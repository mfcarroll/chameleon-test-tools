#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# dependencies = ["pyserial"]
# ///
"""Chameleon Ultra crystal offset over USB, timed against an NTP server. The command-line twin of index.html.

    uv run hfxo_ntp.py /dev/tty.usbmodemXXXX     # or: pipx run hfxo_ntp.py ... (both install pyserial)
    pip install pyserial
    python3 hfxo_ntp.py /dev/tty.usbmodemXXXX [--minutes 30] [--server time.cloudflare.com]
    python3 hfxo_ntp.py COM5 --minutes 15

Needs firmware with command 3125 (HFXO tick counter). Same method as the page: START the counter, READ it every
2 s with each read bracketed by this computer's monotonic clock, STOP, and fit ticks against time. The monotonic
clock's own rate error is measured against NTP over the same window and taken out. Differences from the page:
the reference is NTP over UDP (port 123), one query every 16 s through the whole run instead of bursts, which
public servers would rate-limit. As on the page, only the fastest half of the queries (by round trip) go into the
fit: a slow query carries queueing that isn't split evenly between the two directions. The server name is resolved
once, so every query goes to the same machine. Prints the crystal offset in ppm (+ means the crystal runs fast).

Keep the CU out of reader fields and run no LF commands during the run: LF code can release the crystal, which
the firmware counts as a lapse, and a run with lapses is rejected. Keep the computer awake.
"""

import argparse
import json
import math
import socket
import struct
import sys
import time

import serial

NOMINAL = 16e6  # command 3125 counts 16 MHz HFCLK ticks with the crystal held
CMD_HFXO_COUNT, CMD_GET_GIT_VERSION = 3125, 1017
STATUS_SUCCESS, STATUS_INVALID_CMD = 0x68, 0x67
START, READ, STOP = 0, 1, 2
CU_INTERVAL, NTP_INTERVAL = 2.0, 16.0
NTP_EPOCH = 2208988800  # 1900 -> 1970

# Local clock: perf_counter (mach_absolute_time on macOS, QueryPerformanceCounter on Windows), put on a Unix-ish
# scale once so offsets stay small. It is never stepped; its rate error is what the NTP fit measures.
_BASE = time.time() - time.perf_counter()


def now():
    return _BASE + time.perf_counter()


# ---------------------------------------------------------------- CU framing (big-endian)
# SOF, LRC1, cmd u16, status u16, len u16, LRC2, data, LRC3. Each LRC covers every byte before it.


def lrc(b):
    return (0x100 - sum(b)) & 0xFF


def frame(cmd, data=b""):
    f = bytearray([0x11])
    f.append(lrc(f))
    f += struct.pack("!HHH", cmd, 0, len(data))
    f.append(lrc(f))
    f += data
    f.append(lrc(f))
    return bytes(f)


class CU:
    def __init__(self, port):
        self.s = serial.Serial(port, 115200, timeout=0.05)
        self.buf = bytearray()

    def cmd(self, cmd, data=b"", timeout=3.0):
        self.s.write(frame(cmd, data))
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.buf += self.s.read(max(1, self.s.in_waiting))  # not a fixed size: that waits out the timeout
            while True:
                i = self.buf.find(0x11)
                if i < 0:
                    self.buf.clear()
                    break
                del self.buf[:i]
                b = self.buf
                if len(b) < 9:
                    break
                if b[1] != lrc(b[:1]) or b[8] != lrc(b[:8]):
                    del b[:1]
                    continue
                n = struct.unpack("!H", b[6:8])[0]
                if len(b) < 10 + n:
                    break
                if b[9 + n] != lrc(b[: 9 + n]):
                    del b[:1]
                    continue
                rcmd, status = struct.unpack("!HH", b[2:6])
                data_out = bytes(b[9 : 9 + n])
                del b[: 10 + n]
                if rcmd == cmd:
                    return status, data_out
        raise TimeoutError(f"no reply to command {cmd}")

    def version(self):
        status, d = self.cmd(CMD_GET_GIT_VERSION)
        return d.decode(errors="replace") if status == STATUS_SUCCESS else "?"

    def hfxo(self, sub):
        tb = now()
        status, d = self.cmd(CMD_HFXO_COUNT, bytes([sub]))
        ta = now()
        if status == STATUS_INVALID_CMD:
            raise SystemExit("this firmware has no command 3125 (HFXO tick counter)")
        if status != STATUS_SUCCESS or len(d) < 20:
            raise RuntimeError(f"3125 failed: status {status:#x}, {len(d)} bytes")
        ticks, _, _, lapses, running, hfxo = struct.unpack("!QIIHBB", d[:20])
        return {"t": (tb + ta) / 2, "ticks": ticks, "lapses": lapses, "running": bool(running), "hfxo": bool(hfxo)}


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
    ap.add_argument("port", help="the CU's serial port (/dev/tty.usbmodem..., /dev/ttyACM0, COM5)")
    ap.add_argument("--minutes", type=float, default=30, help="run length (default 30; 15 is ~+-0.5 ppm)")
    ap.add_argument("--server", default="time.cloudflare.com", help="NTP server (resolved once)")
    ap.add_argument("--log", help="write every sample to this JSON-lines file")
    a = ap.parse_args()

    info = socket.getaddrinfo(a.server, 123, type=socket.SOCK_DGRAM)[0]
    addr = info[4][:2]
    cu = CU(a.port)
    print(f"firmware {cu.version()}, NTP {a.server} ({addr[0]}), {a.minutes:g} min")
    log = open(a.log, "w") if a.log else None  # noqa: SIM115 (closed in the finally below)
    cu_pts, ref_pts = [], []
    p = cu.hfxo(START)
    t0 = p["t"]
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
            p = cu.hfxo(READ)
            if p["lapses"] or not p["running"]:
                raise SystemExit("the crystal was released during the run (LF activity?): rejected, run again")
            cu_pts.append((p["t"], p["ticks"]))
            if log:
                log.write(json.dumps({"cu": [p["t"], p["ticks"]]}) + "\n")
            if p["t"] >= end:
                break
            done = (p["t"] - t0) / 60
            print(f"\r  {done:5.1f} / {a.minutes:g} min, {len(cu_pts)} reads, {len(ref_pts)} NTP", end="", flush=True)
            time.sleep(max(0.0, CU_INTERVAL - (now() - t)))
    except KeyboardInterrupt:
        print("\n  stopped early")
    finally:
        try:
            cu.hfxo(STOP)
        except (OSError, RuntimeError) as e:
            print(f"  STOP failed: {e}")
        if log:
            log.close()
    print()
    if len(cu_pts) < 10 or len(ref_pts) < 12:
        raise SystemExit("too short to fit")

    # The CU: ticks per local second. Residual scatter in us shows USB stalls (and laptop sleep).
    x = [t - cu_pts[0][0] for t, _ in cu_pts]
    y = [c - cu_pts[0][1] for _, c in cu_pts]
    f, fsig, _, _ = robust_fit(x, y)
    rms_us = math.sqrt(sum(r * r for r in linfit(x, y)[2]) / len(x)) / f * 1e6
    if rms_us > 20000:
        raise SystemExit(f"CU reads scatter {rms_us / 1e3:.0f} ms rms: the computer probably slept. Run again.")

    # The local clock against NTP: offset(t) = a + k t through the fastest half of the queries; k > 0 means the
    # local clock runs slow. The halves check fits each half of the run on its own and compares.
    cut = sorted(r for _, _, r in ref_pts)[len(ref_pts) // 2]
    fast = [p for p in ref_pts if p[2] <= cut]
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
    print(f"  CU reads       {len(cu_pts)}, {rms_us:.0f} us rms")


if __name__ == "__main__":
    sys.exit(main())
