# Chameleon Ultra crystal offset

Measures how fast or slow a Chameleon Ultra's 32 MHz crystal runs, in ppm, against internet time, over USB. Two
tools, same method:

- **The page** (`index.html`), in Chrome or Edge on a computer. It can also flash the test firmware it needs. Live at
  https://mfcarroll.github.io/rfid-test-tools/chameleon/crystal/
- **The command line** (`hfxo_ntp.py`), using NTP. Needs Python 3, `pyserial`, and outbound UDP port 123.

```
uv run hfxo_ntp.py /dev/tty.usbmodemXXXX --minutes 30      # COM5 on Windows, /dev/ttyACM0 on Linux
```

`uv run` and `pipx run` install pyserial themselves, from the script's inline header. With plain Python,
`pip install pyserial` first, then `python3 hfxo_ntp.py ...`.

## Firmware

Both need the test firmware: stock firmware can't count the crystal's ticks. It adds command **3125**, a tick
counter for the crystal-driven clock.

- `firmware/hfxo-count-4e494589-ultra-dfu-app.zip`: stock v2.3.0 plus command 3125, nothing else. Source:
  [`feat/hfxo-count`](https://github.com/mfcarroll/ChameleonUltra/tree/feat/hfxo-count), commit `4e494589`. Reports
  `v2.3.0-5-g4e49458`.
- `../common/firmware/stock-v2.3.0-ultra-dfu-app.zip`: the official v2.3.0 application package, unchanged, for flashing back.

Chameleon Ultra only, not Lite. Flashing replaces the firmware; slots and saved cards are kept. Flash stock v2.3.0
back when you're done. The page flashes either one over Web Serial using
[chameleon-ultra.js](https://github.com/taichunmin/chameleon-ultra.js): it asks for the CU's port, reboots the CU into
its bootloader and connects to that. The bootloader is a separate USB device, so the first time, the browser asks to
allow it too; Chrome remembers it after that. If the CU is already in its bootloader (a flash was interrupted), pick
it when the page asks for the CU's port and flashing starts straight away. Tested in
Chrome on macOS: stock → test → stock, and from the bootloader. The zips also work with any other DFU tool
(`nrfutil`, nRF Connect for mobile).

Command 3125 takes one byte: 0 starts the counter (and holds the crystal on), 1 reads it, 2 stops it. The reply is 20
bytes, big-endian: u64 ticks of the 16 MHz clock, u32 timer overflows, u32 raw timer value, u16 lapses (times the
crystal was released while counting), u8 running, u8 crystal on now.

## Use

1. Plug the CU in by USB, not Bluetooth (too much jitter).
2. Close anything else using the CU (e.g. CU App or the Python CLI), and keep it away from readers during the run.
   LF activity can switch the crystal off, the counter records that as a lapse, and a run with a lapse is rejected.
3. Keep the computer awake and on the same network for the whole run.
4. 30 minutes is the default. 5 minutes gives roughly ±2 ppm, 15 about ±0.7, 30 about ±0.3, 60 about ±0.15.

A + result means the crystal runs fast.

## Method

- **CU side:** START, then READ every 2 s with each read bracketed by the computer's clock, then STOP. Fit ticks
  against the bracket midpoints, then refit once without reads more than 5 MADs off the line.
- **Computer clock:** the page reads `performance.timeOrigin + performance.now()`; the script reads
  `time.perf_counter()`. On macOS and Windows both are monotonic and never slewed. The fit measures the computer
  clock's own rate error against the time server and takes it out.
- **Page reference:** `https://time.akamai.com/?ms`, millisecond stamps, readable from any site. Three dense bursts
  (120 requests 0.25 s apart by default): at the start, halfway and at the end. The rate comes from the fastest 20 %
  of the start and end bursts, so a constant asymmetry in the network path cancels out. Five-request probes every
  60 s feed only the provisional figure and the plot.
- **Script reference:** one SNTP query every 16 s through the run (public servers rate-limit bursts). The server name
  is resolved once so every query reaches the same machine. Only the fastest half of the queries by round trip go
  into the fit.
- **Path check:** a change in the network path mid-run (a new route, or a different server behind the name) biases
  the rate. Both tools fit each half of the run on its own and flag the run if the crystal's offset in the two halves
  differs by more than 3σ. Each half measures the crystal against the reference, not the computer's clock. A change
  in the computer clock's rate between the halves therefore cancels out of the check.
  A slow, steady drift in path asymmetry looks exactly like a clock rate, and no schedule can catch it.
- **Sleep:** macOS's monotonic clock stops while the computer sleeps and the CU keeps counting. A run whose CU reads
  scatter more than 20 ms rms is rejected.
- The page sleeps in a Web Worker so a hidden tab isn't throttled, asks for a screen wake lock, and logs every time
  the tab is hidden.

## Accuracy

`selftest.mjs` (`node selftest.mjs`) checks the framing and runs the fits on synthetic runs: network 6 ms each way
plus exponential queueing (mean 12 ms), 1 ms server stamps, ~1 ms USB jitter with 1 % 20 ms stalls. 40 seeds each:

| run | error rms | worst | mean reported ± |
|---|---|---|---|
| 15 min | 0.70 ppm | 2.35 | 0.66 |
| 30 min | 0.32 ppm | 0.86 | 0.32 |
| 60 min | 0.13 ppm | 0.30 | 0.16 |

On a 30 min run the halves check flags a single path change that biases the result by more than about 1.5 ppm.

On hardware (macOS, wifi), two CUs on 30 min page runs read within 0.42 ppm of an earlier independent NTP
measurement, and their difference matched it to 0.02 ppm. The page's correction for the computer's clock matched an
independent NTP logger to 0.04 ppm. One CU on the test firmware above read +37.44 ± 0.66 ppm with `hfxo_ntp.py` over
10 min, against +36.85 ± 0.15 from a 30 min page run on an earlier build with the same counter.

## Not tested

- Windows and Linux. On Linux, `performance.now()` and `perf_counter` may sit on a clock NTP slews.
- Laptop sleep during a run (the rejection above hasn't been triggered by a real sleep yet).
- Wired networks, and networks far from Akamai's edge.

## Files

| file | |
|---|---|
| `index.html` | the page |
| `hfxo.js` | command 3125, and the fits at the CU's tick rate; shared by the page and the self-test |
| `selftest.mjs` | self-test, no hardware |
| `hfxo_ntp.py` | the command-line version |
| `firmware/` | the test firmware (stock v2.3.0 is in `../common/firmware/`) |
| `../common/cu.js`, `../common/flash-ui.js` | the CU client and flashing, shared with the self-trim page |
| `../../common/timerun.js`, `timefit.js` | the measurement and its fits, shared with the Flipper crystal page |
