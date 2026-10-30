# Chameleon Ultra crystal oscillator offset

Measure how fast or slow your Chameleon Ultra's 32 MHz crystal runs, against internet time. Two tools, same method:

- **The page** (`index.html`), which requires Chrome or Edge on a computer. It can also flash the test firmware it
  needs. Live at https://mfcarroll.github.io/rfid-test-tools/chameleon/crystal/
- **The command line** (`hfxo_ntp.py`), which performs the same measurement using NTP. Needs Python 3, `pyserial`,
  and outbound UDP port 123.

```
uv run hfxo_ntp.py /dev/tty.usbmodemXXXX --minutes 30      # COM5 on Windows, /dev/ttyACM0 on Linux
```

`uv` and `pipx` install pyserial automatically, from the script's inline header. With plain Python,
`pip install pyserial` first, then `python3 hfxo_ntp.py ...`.

## Firmware

Measuring needs the test firmware: stock v2.3.0 plus a crystal tick counter, command **3125**. Stock firmware can't
count the crystal's ticks.

- `firmware/hfxo-count-4e494589-ultra-dfu-app.zip`: stock v2.3.0 plus command 3125, nothing else. Source:
  [`feat/hfxo-count`](https://github.com/mfcarroll/ChameleonUltra/tree/feat/hfxo-count), commit `4e494589`. Reports
  `v2.3.0-5-g4e49458`.
- `../common/firmware/stock-v2.3.0-ultra-dfu-app.zip`: the official v2.3.0 application package, unchanged, for flashing back.

Chameleon Ultra only, not Lite. Flashing keeps your slots and saved cards. Flash stock v2.3.0 back when you're done.
The page flashes either one over Web Serial using
[chameleon-ultra.js](https://github.com/taichunmin/chameleon-ultra.js). The page asks for the CU's port and reboots
the CU into its bootloader. Then the page connects to the bootloader. The bootloader is a separate USB device, and
the first time, the browser asks to allow it too. Chrome remembers it after that. If the CU is already in its
bootloader (a flash was interrupted), pick it when the page asks for the CU's port. Flashing then starts straight
away. Tested in Chrome on macOS: stock → test → stock, and from the bootloader. The zips also work with any other
DFU tool (`nrfutil`, nRF Connect for mobile).

Command 3125 takes one byte: 0 starts the counter and holds the crystal on, 1 reads it, 2 stops it. The reply is 20
bytes, big-endian: u64 ticks of the 16 MHz clock, u32 timer overflows, u32 raw timer value, u16 lapses (times the
crystal was released while counting), u8 running, u8 crystal on now.

## Use

1. Plug your CU in to USB, not Bluetooth (too much jitter).
2. Close anything else using it, such as the CU app or the Python CLI, and keep the CU away from readers. LF
   activity can release the crystal, the counter records that as a lapse, and a run with any lapse is rejected.
3. Keep this tab open in the foreground with the computer awake, and stay on the same network for the whole run.
4. 30 minutes is recommended, and the default. 5 minutes gives roughly ±2 ppm, 15 about ±0.7, 30 about ±0.3, 60
   about ±0.15.

A + result means the crystal runs fast.

## Method

- **CU side:** both tools send START, then READ every 2 s, then STOP. Each READ sits between two readings of the
  computer's clock. The fit puts the ticks against the midpoints of those pairs, then refits once without reads more
  than 5 MADs off the line.
- **Computer clock:** the page reads `performance.timeOrigin + performance.now()`, and the script reads
  `time.perf_counter()`. On macOS and Windows both are monotonic and never slewed. The fit measures the computer
  clock's own rate error against the time server and takes it out.
- **Page reference:** two servers with millisecond stamps, readable from any site: `https://time.akamai.com/?ms` and
  `https://time.mfc.cx/` (a Cloudflare Worker, [`../../timeserver/`](../../timeserver/)). Requests alternate between
  them in three dense bursts (120 to each server, 0.25 s apart by default): at the start, halfway and at the end.
  Each server's rate comes from the fastest 20 % of its start and end bursts. A constant asymmetry in the network
  path cancels out of that rate. The result uses the two rates' weighted mean. Five-request probes to each server
  every 60 s feed only the provisional figure and the plot. The page leaves out a server that fails half the start
  burst.
- **Script reference:** one SNTP query every 16 s through the run (public servers rate-limit bursts), to
  `time.cloudflare.com` by default. That is Cloudflare's NTP service, separate from the page's `time.mfc.cx` Worker.
  The script looks up the server's name once, and every query then reaches the same machine. Only the fastest half
  of the queries by round trip go into the fit.
- **Path check:** a change in the network path mid-run (a new route, or a different server behind the name) biases
  the rate. Both tools fit each half of the run on its own and flag the run if the crystal's offset in the two halves
  differs by more than 3σ. Each half measures the crystal against the reference, not the computer's clock. A change
  in the computer clock's rate between the halves therefore cancels out of the check.
  A slow, steady drift in path asymmetry looks exactly like a clock rate, and no schedule can catch it.
- **Server check (page):** the two servers sit on different networks, and a path problem on one moves only its own
  rate. The page flags the run if the crystal's offset against each server differs by more than 3σ. The server check
  also catches a slow drift on one path, which the halves check can't.
- **Sleep:** macOS's monotonic clock stops while the computer sleeps, and the CU keeps counting. The page and the
  script reject a run whose CU reads scatter more than 20 ms rms.
- The page times its sleeps in a Web Worker, which a hidden tab doesn't throttle. The page also asks for a screen
  wake lock, and logs each time the tab is hidden.

## Accuracy

`selftest.mjs` (`node selftest.mjs`) checks the framing and runs the fits on synthetic runs: network 6 ms each way
plus exponential queueing (mean 12 ms), 1 ms server stamps, ~1 ms USB jitter with 1 % 20 ms stalls. 40 seeds each:

| run    | error rms | worst | mean reported ± |
| ------ | --------- | ----- | --------------- |
| 15 min | 0.70 ppm  | 2.35  | 0.66            |
| 30 min | 0.32 ppm  | 0.86  | 0.32            |
| 60 min | 0.13 ppm  | 0.30  | 0.16            |

On a 30 min run the halves check flags a single path change that biases the result by more than about 1.5 ppm.
With both servers, the 30 min error falls to 0.21 ppm rms, against 0.34 with one. An outbound delay on one path that
grows steadily by 8 ms over the run passes that server's halves check 19 times in 20, and the server check catches it
19 times in 20.

On hardware (macOS, wifi), two CUs on 30 min page runs read within 0.42 ppm of an earlier independent NTP
measurement, and their difference matched it to 0.02 ppm. The page's correction for the computer's clock matched an
independent NTP logger to 0.04 ppm. One CU on the test firmware above read +37.44 ± 0.66 ppm with `hfxo_ntp.py` over
10 min, against +36.85 ± 0.15 from a 30 min page run on an earlier build with the same counter.

## Not tested

- Windows and Linux. On Linux, `performance.now()` and `perf_counter` may sit on a clock NTP slews.
- Laptop sleep during a run (the rejection above hasn't been triggered by a real sleep yet).
- Wired networks, and networks far from Akamai's edge.

## Files

| file                                       |                                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `index.html`                               | the page                                                                               |
| `hfxo.js`                                  | command 3125, and the fits at the CU's tick rate; shared by the page and the self-test |
| `selftest.mjs`                             | self-test, no hardware                                                                 |
| `hfxo_ntp.py`                              | the command-line version                                                               |
| `firmware/`                                | the test firmware (stock v2.3.0 is in `../common/firmware/`)                           |
| `../common/cu.js`, `../common/flash-ui.js` | the CU client and flashing, shared with the self-trim page                             |
| `../../common/timerun.js`, `timefit.js`    | the measurement and its fits, shared with the Flipper crystal page                     |
