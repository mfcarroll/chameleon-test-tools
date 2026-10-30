# Flipper Zero crystal oscillator calibration

Page: https://mfcarroll.github.io/rfid-test-tools/flipper/crystal/

Calibrate your Flipper against internet time, so the RFID detector app can measure the precise frequency of a
low-frequency RFID field. The calibration needs the app at version 1.5 or later. Until that version is in the app
catalog, the page can install it on OFW or Momentum.

Plug your Flipper in to USB and close qFlipper. Exit any app that's open on the Flipper itself. The page and the
script open the RFID detector app and show their progress on the Flipper. If the run passes its checks, they save
the result in the app.

## How to calibrate

- **In the page**, which requires Chrome or Edge on a computer. Keep the tab open in the foreground with the computer
  awake, and stay on the same network. 30 minutes is recommended.
- **From the command line**: `flipper_crystal.py` performs the same calibration using NTP. `uv` and `pipx` install
  pyserial automatically.

      curl -LO https://mfcarroll.github.io/rfid-test-tools/flipper/crystal/flipper_crystal.py
      uv run flipper_crystal.py          # or: pipx run flipper_crystal.py
      python3 flipper_crystal.py         # after: pip install pyserial

  Options:
  - `--minutes N`: how long to measure. 30 by default.
  - `--no-send`: print the result without saving it on the Flipper.
  - `--server HOST`: the NTP server. `time.cloudflare.com` by default.
  - `--log FILE`: write every sample to a file.
  - `PORT`: with more than one Flipper plugged in, the one to use, such as `COM5` or `/dev/ttyACM0`.

- **By hand**, if you already know the offset. Set it in the app: press Left for Config, then _Set calibration
  manually_.

## Files

| file                       | what                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `index.html`, `flipper.js` | the page; `flipper.js` talks to the Flipper's CLI over Web Serial                                               |
| `flipper_crystal.py`       | the command-line version, using NTP. A copy: edit the one in the app's `tools/` folder in flipperzero-good-faps |
| `apps/`                    | app builds for each firmware, and `manifest.json`, which the page picks from                                    |
| `build_apps.py`            | makes `apps/` from the app's source, and copies the script                                                      |

The page measures against two time servers, Akamai (`time.akamai.com`) and Cloudflare (`time.mfc.cx`). The page uses
`../../common/timerun.js` and its fits in `../../common/timefit.js`, which the Chameleon Ultra crystal tool also
uses. That tool's README describes the method. The app's CLI command is described at the bottom of the page and in
the app's `tools/README.md`.

GPL-3.0.
