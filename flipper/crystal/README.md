# Flipper Zero crystal calibration

Page: https://mfcarroll.github.io/rfid-test-tools/flipper/crystal/

Every Flipper's crystal runs a little fast or slow. This measures your Flipper's crystal against internet time and
saves the correction in the RFID detector app, allowing for accurate measurement of a LF reader field's frequency.
It needs the app at version 1.5 or later; until that's in the app catalog, the page can install it on OFW or
Momentum.

Plug the Flipper in by USB and close any other connected apps, e.g. qFlipper. Exit any app that's open on the
Flipper itself. The page and the script open the RFID detector app automatically, show their progress there, and
save a good result.

## How to calibrate

- **In the page**, in Chrome or Edge on a computer. It takes about 30 minutes.
- **From the command line**, with Python:

      curl -LO https://mfcarroll.github.io/rfid-test-tools/flipper/crystal/flipper_crystal.py
      uv run flipper_crystal.py          # or pipx run: both install pyserial for you
      python3 flipper_crystal.py         # after: pip install pyserial

  Options: `--minutes` (default 30), `--no-send` to only print the result, `--server`, `--log`, and the port if more
  than one Flipper is plugged in.
- **By hand**, if you already know the offset: in the app, press Left for Config, then *Set calibration manually*.

## Files

| file | what |
|---|---|
| `index.html`, `flipper.js` | the page; `flipper.js` talks to the Flipper's CLI over Web Serial |
| `flipper_crystal.py` | the command-line version, using NTP. A copy: edit the one in the app's `tools/` folder in flipperzero-good-faps |
| `apps/` | app builds for each firmware, and `manifest.json`, which the page picks from |
| `build_apps.py` | makes `apps/` from the app's source, and copies the script |

The page measures against `time.akamai.com`, with `../../common/timerun.js` and its fits `../../common/timefit.js`,
shared with the Chameleon Ultra crystal tool; that tool's README describes the method. The app's CLI command is
described at the bottom of the page and in the app's `tools/README.md`.

GPL-3.0.
