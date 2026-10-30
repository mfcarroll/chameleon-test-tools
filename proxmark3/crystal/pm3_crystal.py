#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# dependencies = ["pyserial"]
# ///
"""Proxmark3 crystal offset over USB, timed against an NTP server. The command-line twin of index.html.

    uv run pm3_crystal.py /dev/tty.usbmodemXXXX     # or: pipx run pm3_crystal.py ... (both install pyserial)
    pip install pyserial
    python3 pm3_crystal.py /dev/tty.usbmodemXXXX [--minutes 30] [--server time.cloudflare.com]
    python3 pm3_crystal.py COM5 --minutes 15

Needs firmware with CMD_HW_TICKS (0x011B, branch feat/hw-ticks), and the pm3 client closed. The method is the
page's. The script starts the tick counter, reads the count every 2 s with each read bracketed by this computer's
monotonic clock, stops the tick counter, and fits the count against time. The script measures the monotonic clock's
own rate error against NTP over the same window and takes the error out.

Unlike the page, the script uses NTP over UDP (port 123), with one query every 16 s through the whole run. Public NTP
servers would rate-limit the page's bursts. As on the page, only the fastest half of the queries by round trip go
into the fit, because a slow query carries queueing that isn't split evenly between the two directions. The script
resolves the server name once, and every query then reaches the same machine. The script prints the crystal offset
in ppm (+ means the crystal runs fast).

Other firmware commands use the same tick counter. Nothing else may talk to the PM3 during the run, and the PM3's
button must be left alone. The script stops the run when a read's count jumps. Keep the computer awake.
"""

import argparse
import json
import math
import re
import socket
import struct
import sys
import time

import serial

NOMINAL = 1.5e6  # the tick counter counts the 48 MHz master clock / 32, and the PLL makes that clock from the crystal
CMD_DEBUG_PRINT_STRING, CMD_VERSION, CMD_HW_TICKS = 0x0100, 0x0107, 0x011B
START, READ, STOP = 0, 1, 2
PM3_INTERVAL, NTP_INTERVAL = 2.0, 16.0
NTP_EPOCH = 2208988800  # 1900 -> 1970

# Local clock: perf_counter (mach_absolute_time on macOS, QueryPerformanceCounter on Windows), put on a Unix-ish
# scale once so offsets stay small. The clock is never stepped, and the NTP fit measures its rate error.
_BASE = time.time() - time.perf_counter()


def now():
    return _BASE + time.perf_counter()


# ---------------------------------------------------------------- PM3 framing (pm3_cmd.h, little-endian)
# Command: "PM3a", u16 length | 0x8000 (NG), u16 cmd, data, "a3" (no CRC over USB).
# Reply: "PM3b", u16 length | NG bit, i8 status, i8 reason, u16 cmd, data, u16 CRC or "b3".


def frame(cmd, data=b""):
    return struct.pack("<IHH", 0x61334D50, len(data) | 0x8000, cmd) + data + struct.pack("<H", 0x3361)


class PM3:
    def __init__(self, port):
        self.s = serial.Serial(port, 115200, timeout=0.05)
        self.s.reset_input_buffer()
        self.buf = bytearray()
        self.last = None
        self.wraps = 0

    def cmd(self, cmd, data=b"", timeout=3.0):
        self.s.write(frame(cmd, data))
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.buf += self.s.read(max(1, self.s.in_waiting))  # a fixed size would wait out the timeout
            while True:
                i = self.buf.find(b"PM3b")
                if i < 0:
                    del self.buf[: max(0, len(self.buf) - 3)]
                    break
                del self.buf[:i]
                b = self.buf
                if len(b) < 10:
                    break
                n = struct.unpack("<H", b[4:6])[0] & 0x7FFF
                if n > 4064:
                    del b[:1]
                    continue
                if len(b) < 12 + n:
                    break
                status, _, rcmd = struct.unpack("<bbH", b[6:10])
                data_out = bytes(b[10 : 10 + n])
                del b[: 12 + n]
                if rcmd == CMD_DEBUG_PRINT_STRING:
                    # firmware without the command prints "unknown command" and never replies
                    if re.search(
                        rf"unknown command:+\s*0x0*{cmd:x}\b", data_out[2:].decode(errors="replace"), re.IGNORECASE
                    ):
                        raise SystemExit(f"this firmware doesn't know command {cmd:#06x}. Flash the test firmware.")
                    continue
                if rcmd == cmd:
                    return status, data_out
        raise TimeoutError(f"no reply to command {cmd:#06x}")

    def version(self):
        _, d = self.cmd(CMD_VERSION)
        n = struct.unpack("<I", d[8:12])[0]
        text = re.sub(r"\x1b\[[0-9;]*m", "", d[12 : 12 + n].split(b"\0")[0].decode(errors="replace"))
        m = re.search(r"^\s*OS[.:]*\s+(\S.*)$", text, re.MULTILINE | re.IGNORECASE)
        return m.group(1).strip() if m else "?"

    def ticks(self, sub):
        """CMD_HW_TICKS: u8 0 start / 1 read / 2 stop -> u32 count. The count wraps every 47.7 min, and ticks()
        adds the wraps back."""
        tb = now()
        status, d = self.cmd(CMD_HW_TICKS, bytes([sub]))
        ta = now()
        if status != 0 or len(d) < 4:
            raise RuntimeError(f"CMD_HW_TICKS failed: status {status}, {len(d)} bytes")
        raw = struct.unpack("<I", d[:4])[0]
        if sub == START:
            self.wraps = 0
        elif self.last is not None and raw < self.last:
            self.wraps += 1
        self.last = raw
        return {"t": (tb + ta) / 2, "ticks": (self.wraps << 32) | raw}


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


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("port", help="the PM3's serial port (/dev/tty.usbmodem..., /dev/ttyACM0, COM5)")
    ap.add_argument("--minutes", type=float, default=30, help="run length (default 30; 15 is ~+-0.5 ppm)")
    ap.add_argument("--server", default="time.cloudflare.com", help="NTP server (resolved once)")
    ap.add_argument("--log", help="write every sample to this JSON-lines file")
    a = ap.parse_args()

    info = socket.getaddrinfo(a.server, 123, type=socket.SOCK_DGRAM)[0]
    addr = info[4][:2]
    pm3 = PM3(a.port)
    print(f"firmware {pm3.version()}, NTP {a.server} ({addr[0]}), {a.minutes:g} min")
    log = open(a.log, "w") if a.log else None  # noqa: SIM115 (closed in the finally below)
    pm3_pts, ref_pts = [], []
    p = pm3.ticks(START)
    t0 = p["t"]
    prev = p
    end = t0 + a.minutes * 60
    next_ntp = t0
    try:
        while True:
            t = now()
            if t >= next_ntp:
                try:
                    mid, off, rtt = ntp_query(addr)
                    ref_pts.append((mid, off, rtt))
                    if log:
                        log.write(json.dumps({"ntp": [mid, off, rtt]}) + "\n")
                except (OSError, RuntimeError) as e:
                    print(f"  NTP query failed: {e}")
                next_ntp += NTP_INTERVAL
            p = pm3.ticks(READ)
            jump = (p["ticks"] - prev["ticks"]) / NOMINAL - (p["t"] - prev["t"])
            if abs(jump) > 1:
                raise SystemExit(
                    f"the tick count jumped {jump:+.1f} s. The PM3 reset or ran another command. Run again."
                )
            prev = p
            pm3_pts.append((p["t"], p["ticks"]))
            if log:
                log.write(json.dumps({"pm3": [p["t"], p["ticks"]]}) + "\n")
            if p["t"] >= end:
                break
            done = (p["t"] - t0) / 60
            print(f"\r  {done:5.1f} / {a.minutes:g} min, {len(pm3_pts)} reads, {len(ref_pts)} NTP", end="", flush=True)
            time.sleep(max(0.0, PM3_INTERVAL - (now() - t)))
    except KeyboardInterrupt:
        print("\n  stopped early")
    finally:
        try:
            pm3.ticks(STOP)
        except (OSError, RuntimeError) as e:
            print(f"  STOP failed: {e}")
        if log:
            log.close()
    print()
    if len(pm3_pts) < 10 or len(ref_pts) < 12:
        raise SystemExit("too short to fit")

    # The PM3: ticks per local second. Residual scatter in us shows USB stalls (and laptop sleep).
    x = [t - pm3_pts[0][0] for t, _ in pm3_pts]
    y = [c - pm3_pts[0][1] for _, c in pm3_pts]
    f, fsig, _, _ = robust_fit(x, y)
    rms_us = math.sqrt(sum(r * r for r in linfit(x, y)[2]) / len(x)) / f * 1e6
    if rms_us > 20000:
        raise SystemExit(f"PM3 reads scatter {rms_us / 1e3:.0f} ms rms. The computer probably slept. Run again.")

    # The local clock against NTP: offset(t) = a + k t through the fastest half of the queries. k > 0 means the
    # local clock runs slow.
    cut = sorted(r for _, _, r in ref_pts)[len(ref_pts) // 2]
    fast = [p for p in ref_pts if p[2] <= cut]
    rx = [m - ref_pts[0][0] for m, _, _ in fast]
    ry = [o for _, o, _ in fast]
    k, ksig, kept, _ = robust_fit(rx, ry)

    # The halves check fits each half of the run on its own and compares the crystal's offset in each. The local
    # clock's rate can change between the halves, and the device's rate against the local clock then moves the
    # opposite way.
    half = len(fast) // 2
    split = fast[half][0]
    halves = []
    for queries, keep in ((fast[: half + 1], lambda t: t <= split), (fast[half:], lambda t: t >= split)):
        hk, hk_sig, _, _ = robust_fit([m - ref_pts[0][0] for m, _, _ in queries], [o for _, o, _ in queries])
        pts = [(t, c) for t, c in pm3_pts if keep(t)]
        hf, hf_sig, _, _ = robust_fit([t - pts[0][0] for t, _ in pts], [c - pts[0][1] for _, c in pts])
        halves.append(((hf / (1 + hk) / NOMINAL - 1) * 1e6, math.hypot(hf_sig / NOMINAL, hk_sig) * 1e6, -hk * 1e6))

    ppm = (f / (1 + k) / NOMINAL - 1) * 1e6
    sig = math.hypot(fsig / NOMINAL, ksig) * 1e6
    print(f"crystal offset   {ppm:+.2f} +- {sig:.2f} ppm   (+ = fast)")
    print(f"  uncorrected    {(f / NOMINAL - 1) * 1e6:+.2f} ppm vs this computer's clock")
    print(
        f"  computer clock {-k * 1e6:+.2f} ppm vs NTP (fastest {kept} of {len(ref_pts)} queries, min round trip "
        f"{min(r for _, _, r in ref_pts) * 1e3:.1f} ms)"
    )
    (p1, s1, c1), (p2, s2, c2) = halves
    ok = abs(p2 - p1) <= 3 * math.hypot(s1, s2)
    print(
        f"  halves         {p1:+.2f} then {p2:+.2f} ppm (computer clock {c1:+.2f} then {c2:+.2f}): "
        f"{'ok' if ok else 'DISAGREE (path to the server changed?): re-run'}"
    )
    print(f"  PM3 reads      {len(pm3_pts)}, {rms_us:.0f} us rms")


if __name__ == "__main__":
    sys.exit(main())
