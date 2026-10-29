#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# dependencies = ["pyserial"]
# ///
"""Flipper Zero crystal offset over USB, timed against an NTP server, for the RFID detector's LF calibration.
The command-line twin of https://mfcarroll.github.io/rfid-test-tools/flipper/crystal/ (the QR code in the app).

    uv run flipper_crystal.py              # or: pipx run flipper_crystal.py (both fetch pyserial themselves)
    python3 flipper_crystal.py             # after: pip install pyserial
    python3 flipper_crystal.py COM5 --minutes 15

The Flipper is found by its USB ID; name the port if more than one is connected.

The script opens the RFID detector app (1.5 or later) on its calibration screen by itself; if another app is open,
exit it first. The app then answers the `rfid_detector_cal` CLI command: a 64 MHz timer run from the Flipper's
32 MHz crystal, read every 2 s with each read bracketed by this computer's monotonic clock. The monotonic clock's
own rate error is measured against NTP over the same window and taken out: one query every 16 s, the fastest half
by round trip into the fit, the server name resolved once.

The Flipper shows the progress and a running estimate. At the end this prints the crystal offset in ppm (+ means
the crystal runs fast) and, if the run passed its checks, sends it to the app, which saves it and says so
(--no-send to only print it). Close qFlipper and anything else using the Flipper's port first. Keep the computer
awake.
"""

import argparse
import json
import math
import socket
import struct
import sys
import time

import serial
from serial.tools import list_ports

NOMINAL = 64e6  # the app's timer: 64 MHz from the crystal's PLL
COMMAND = b"rfid_detector_cal\r"
APP_PATH = "/ext/apps/Tools/nfc_rfid_detector.fap"  # where the app catalog and the page install it
READ_INTERVAL, NTP_INTERVAL = 2.0, 16.0
NTP_EPOCH = 2208988800  # 1900 -> 1970
CAL_LIMIT = 100.0  # ppm, as the app's Calibration screen

# Local clock: perf_counter (mach_absolute_time on macOS, QueryPerformanceCounter on Windows), put on a Unix-ish
# scale once so offsets stay small. It is never stepped; its rate error is what the NTP fit measures.
_BASE = time.time() - time.perf_counter()


def now():
    return _BASE + time.perf_counter()


# ---------------------------------------------------------------- Flipper

FLIPPER_USB = (0x0483, 0x5740)  # the Flipper's USB serial (CDC) ID


def find_port():
    ports = [p for p in list_ports.comports() if (p.vid, p.pid) == FLIPPER_USB]
    if len(ports) == 1:
        return ports[0].device
    if not ports:
        raise SystemExit("no Flipper found on USB: plug it in (and close qFlipper), or name its port")
    names = "\n  ".join(f"{p.device}  {p.description}" for p in ports)
    raise SystemExit(f"more than one Flipper connected; name one:\n  {names}")



class Flipper:
    """The app's CLI command: "OK lfcal 64000000 <saved>" on start, then "<count> <pll>" per b'r';
    "p<elapsed> <total> [<est> <+->]\\r" shows progress (0.1 ppm, no reply); "s<v>\\r" saves a correction (0.1 ppm,
    replies "SET <v>"); any other byte stops. The 32-bit count wraps every 67 s: unwrapped here."""

    def __init__(self, port):
        self.ser = serial.Serial(port, 230400, timeout=2)
        time.sleep(0.4)
        self.ser.reset_input_buffer()
        self.last, self.hi, self.open = None, 0, False

    def _line(self):
        ln = self.ser.readline().decode("utf-8", "replace").strip()
        if not ln:
            raise TimeoutError("no reply from the Flipper")
        if ln == "STOPPED":  # Cancel on the Flipper, or it left Config
            self.open = False
            raise SystemExit("cancelled on the Flipper: nothing saved")
        return ln

    def cli(self, cmd, timeout=5):
        """One CLI command; its output up to the ">: " prompt, without the echo."""
        self.ser.reset_input_buffer()
        self.ser.write(cmd.encode() + b"\r")
        out, end = b"", time.monotonic() + timeout
        while b">: " not in out and time.monotonic() < end:
            out += self.ser.read(max(1, self.ser.in_waiting))
        text = out.decode("utf-8", "replace").split(">: ")[0]
        return "\n".join(ln.strip() for ln in text.splitlines() if ln.strip() and ln.strip() != cmd)

    def open_app(self):
        """Start the app on its calibration screen (if it is already running, the command itself gets it there)."""
        out = self.cli(f"loader open {APP_PATH} cal")
        if out:
            raise SystemExit(f"Flipper: couldn't open the RFID detector app: {out}\n"
                             "Exit any app that's open on the Flipper, or open the app yourself: Left for Config, "
                             "then Calibrate with a computer")
        time.sleep(1.5)

    def start(self):
        for attempt in range(2):
            self.ser.reset_input_buffer()
            self.ser.write(COMMAND)
            end = time.monotonic() + 10
            while time.monotonic() < end:
                ln = self.ser.readline().decode("utf-8", "replace").strip()
                if ln.startswith("ERR"):
                    raise SystemExit(f"Flipper: {ln[4:]}")
                if "could not find command" in ln:
                    if attempt:
                        raise SystemExit("Flipper: the RFID detector app there is older than 1.5: update it")
                    self.open_app()
                    break
                if ln.startswith("OK lfcal"):
                    self.open = True
                    return int(ln.split()[3]) / 10
            else:
                raise TimeoutError("the Flipper didn't start the session")
        raise SystemExit("Flipper: couldn't start the calibration session")

    def read(self):
        tb = now()
        self.ser.write(b"r")
        ln = self._line()
        ta = now()
        try:
            raw, pll = (int(v) for v in ln.split())
        except ValueError:
            raise SystemExit(f"Flipper: unexpected reply {ln!r} (Config screen closed?)") from None
        if self.last is not None and raw < self.last:
            self.hi += 1
        self.last = raw
        return {"t": (tb + ta) / 2, "ticks": (self.hi << 32) | raw, "pll": bool(pll)}

    def progress(self, elapsed, total, est=None):
        msg = f"p{int(elapsed)} {int(total)}"
        if est:
            msg += f" {round(est[0] * 10)} {max(1, round(est[1] * 10))}"
        self.ser.write((msg + "\r").encode())

    def send(self, ppm):
        v = round(ppm * 10)
        self.ser.write(f"s{v}\r".encode())
        ln = self._line()
        if ln != f"SET {v}":
            raise RuntimeError(f"Flipper didn't take the value: {ln!r}")

    def close(self):
        if self.open:
            self.ser.write(b"q")
            self.open = False
        self.ser.close()


# ---------------------------------------------------------------- NTP


def ntp_query(addr, timeout=2.0):
    """One SNTP query. Returns (local mid time, server - local offset, round trip), all in seconds."""
    with socket.socket(socket.AF_INET6 if ":" in addr[0] else socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(timeout)
        t1 = now()
        s.sendto(b"\x23" + 47 * b"\0", addr)  # LI 0, version 4, mode 3 (client)
        d, _ = s.recvfrom(512)
        t4 = now()
    if len(d) < 48 or d[1] == 0:  # stratum 0: kiss-o'-death, e.g. rate limited
        raise RuntimeError(f"server refused ({d[12:16]!r})")

    def ts(i):
        sec, frac = struct.unpack("!II", d[i : i + 8])
        return sec - NTP_EPOCH + frac / 2**32

    t2, t3 = ts(32), ts(40)
    return (t1 + t4) / 2, ((t2 - t1) + (t3 - t4)) / 2, (t4 - t1) - (t3 - t2)


# ---------------------------------------------------------------- fits


def linfit(x, y):
    n = len(x)
    mx, my = sum(x) / n, sum(y) / n
    sxx = sum((v - mx) ** 2 for v in x)
    k = sum((a - mx) * (b - my) for a, b in zip(x, y)) / sxx
    b0 = my - k * mx
    res = [b - (k * a + b0) for a, b in zip(x, y)]
    sig = math.sqrt(sum(r * r for r in res) / (n - 2) / sxx) if n > 2 else float("nan")
    return k, b0, res, sig


def median(a):
    s = sorted(a)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def robust_fit(x, y):
    """Least squares, refit once without points more than 5 MADs off the line. Returns (k, sigma k, kept, n)."""
    k, _, res, sig = linfit(x, y)
    med = median(res)
    mad = median([abs(r - med) for r in res]) or 1e-12
    keep = [abs(r - med) <= 5 * 1.4826 * mad for r in res]
    if len(x) >= 4 and 3 <= sum(keep) < len(x):
        k, _, res, sig = linfit([v for v, ok in zip(x, keep) if ok], [v for v, ok in zip(y, keep) if ok])
    return k, sig, sum(keep), len(x)


def offset(pts, ref_pts):
    """(ppm, sigma) from the reads and NTP samples so far, the local clock's rate taken out; None if too few."""
    if len(pts) < 10 or len(ref_pts) < 4:
        return None
    x = [t - pts[0][0] for t, _ in pts]
    y = [c - pts[0][1] for _, c in pts]
    f, fsig, _, _ = robust_fit(x, y)
    cut = sorted(r for _, _, r in ref_pts)[len(ref_pts) // 2]
    fast = [q for q in ref_pts if q[2] <= cut]
    if len(fast) < 3:
        return None
    k, ksig, _, _ = robust_fit([m - ref_pts[0][0] for m, _, _ in fast], [o for _, o, _ in fast])
    return (f / (1 + k) / NOMINAL - 1) * 1e6, math.hypot(fsig / NOMINAL, ksig) * 1e6


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("port", nargs="?", help="the Flipper's serial port (default: find it by its USB ID)")
    ap.add_argument("--minutes", type=float, default=30, help="run length (default 30; 15 is ~+-0.5 ppm)")
    ap.add_argument("--server", default="time.cloudflare.com", help="NTP server (resolved once)")
    ap.add_argument("--log", help="write every sample to this JSON-lines file")
    ap.add_argument("--no-send", action="store_true", help="only print the result; don't save it on the Flipper")
    a = ap.parse_args()

    info = socket.getaddrinfo(a.server, 123, type=socket.SOCK_DGRAM)[0]
    addr = info[4][:2]
    port = a.port or find_port()
    fl = Flipper(port)
    log = open(a.log, "w") if a.log else None  # noqa: SIM115 (closed in the finally below)
    pts, ref_pts = [], []
    try:
        saved = fl.start()
        print(f"Flipper on {port}, calibration now {saved:+.1f} ppm; NTP {a.server} ({addr[0]}), {a.minutes:g} min")
        p = fl.read()
        t0 = p["t"]
        end = t0 + a.minutes * 60
        next_ntp = next_progress = t0
        while True:
            t = now()
            if t >= next_ntp:
                try:
                    mid, off, rtt = ntp_query(addr)
                    ref_pts.append((mid, off, rtt))
                    if log:
                        log.write(json.dumps({"ntp": [mid, off, rtt]}) + "\n")
                except (OSError, RuntimeError) as e:
                    print(f"\n  NTP query failed: {e}")
                next_ntp += NTP_INTERVAL
            if not p["pll"]:
                raise SystemExit("the Flipper's clock left the crystal during the run: rejected, run again")
            pts.append((p["t"], p["ticks"]))
            if log:
                log.write(json.dumps({"flipper": [p["t"], p["ticks"]]}) + "\n")
            if p["t"] >= end:
                break
            if p["t"] >= next_progress:
                fl.progress(p["t"] - t0, a.minutes * 60, offset(pts, ref_pts))
                next_progress += 10
            done = (p["t"] - t0) / 60
            print(f"\r  {done:5.1f} / {a.minutes:g} min, {len(pts)} reads, {len(ref_pts)} NTP", end="", flush=True)
            time.sleep(max(0.0, READ_INTERVAL - (now() - t)))
            p = fl.read()
        print()
        if len(pts) < 10 or len(ref_pts) < 12:
            raise SystemExit("too short to fit")

        # The Flipper: ticks per local second. Residual scatter in us shows USB stalls (and laptop sleep).
        x = [t - pts[0][0] for t, _ in pts]
        y = [c - pts[0][1] for _, c in pts]
        f, fsig, _, _ = robust_fit(x, y)
        rms_us = math.sqrt(sum(r * r for r in linfit(x, y)[2]) / len(x)) / f * 1e6
        if rms_us > 20000:
            raise SystemExit(f"reads scatter {rms_us / 1e3:.0f} ms rms: the computer probably slept. Run again.")

        # The local clock against NTP: offset(t) = a + k t through the fastest half of the queries; k > 0 means
        # the local clock runs slow. The halves check fits each half of the run on its own and compares.
        cut = sorted(r for _, _, r in ref_pts)[len(ref_pts) // 2]
        fast = [q for q in ref_pts if q[2] <= cut]
        rx = [m - ref_pts[0][0] for m, _, _ in fast]
        ry = [o for _, o, _ in fast]
        k, ksig, kept, _ = robust_fit(rx, ry)
        half = len(fast) // 2
        k1, s1, _, _ = robust_fit(rx[: half + 1], ry[: half + 1])
        k2, s2, _, _ = robust_fit(rx[half:], ry[half:])

        ppm = (f / (1 + k) / NOMINAL - 1) * 1e6
        sig = math.hypot(fsig / NOMINAL, ksig) * 1e6
        print(f"crystal offset   {ppm:+.2f} +- {sig:.2f} ppm   (+ = fast)")
        print(f"  uncorrected    {(f / NOMINAL - 1) * 1e6:+.2f} ppm vs this computer's clock")
        print(
            f"  computer clock {-k * 1e6:+.2f} ppm vs NTP (fastest {kept} of {len(ref_pts)} queries, min round trip "
            f"{min(r for _, _, r in ref_pts) * 1e3:.1f} ms)"
        )
        diff, dsig = (k2 - k1) * 1e6, math.hypot(s1, s2) * 1e6
        ok = abs(diff) <= 3 * dsig
        print(
            f"  halves         computer clock {-k1 * 1e6:+.2f} then {-k2 * 1e6:+.2f} ppm: "
            f"{'ok' if ok else 'DISAGREE (path to the server changed?): re-run'}"
        )
        print(f"  Flipper reads  {len(pts)}, {rms_us:.0f} us rms")

        if abs(ppm) > CAL_LIMIT:
            print(f"  {ppm:+.1f} ppm is beyond the app's +-{CAL_LIMIT:g}: not saved")
        elif not ok:
            print("  not saved on the Flipper: the halves check failed. Run again")
        elif not a.no_send:
            fl.send(ppm)
            print(f"  saved on the Flipper: {ppm:+.1f} ppm (it was {saved:+.1f})")
    except KeyboardInterrupt:
        print("\n  stopped")
    finally:
        fl.close()
        if log:
            log.close()


if __name__ == "__main__":
    sys.exit(main())
