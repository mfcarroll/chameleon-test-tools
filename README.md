# RFID test tools

Tools for testing RFID devices in the browser (Chrome or Edge, over USB), with command-line versions. Each tool has
its own folder and README.

Pages: https://mfcarroll.github.io/rfid-test-tools/

## Chameleon Ultra

| tool | what it does | firmware |
|---|---|---|
| [`chameleon/crystal/`](chameleon/crystal/) | how fast or slow the 32 MHz crystal runs, measured against internet time | stock v2.3.0 + command 3125 ([`feat/hfxo-count`](https://github.com/mfcarroll/ChameleonUltra/tree/feat/hfxo-count)) |
| [`chameleon/selftrim/`](chameleon/selftrim/) | (experiment) emulates HID Prox, Paradox and ioProx cards matched to a reader's clock; put the same card in slots with and without the experimental modes, and see which ones a reader accepts | Paradox PR #489 + self-trim research ([`exp/fsk-selftrim-paradox`](https://github.com/mfcarroll/ChameleonUltra/tree/exp/fsk-selftrim-paradox)) |

Each tool needs its own test firmware, available to flash on the page, with stock v2.3.0 for flashing back. The
firmware is built from branches of [mfcarroll/ChameleonUltra](https://github.com/mfcarroll/ChameleonUltra), and each
build also has a release here, tagged `fw-<branch>-<commit>`. The pages flash with
[chameleon-ultra.js](https://github.com/taichunmin/chameleon-ultra.js) (MIT), loaded from jsDelivr.

## Flipper Zero

| tool | what it does | app |
|---|---|---|
| [`flipper/crystal/`](flipper/crystal/) | measures the 32 MHz crystal against internet time and saves the correction in the RFID detector app, allowing exact LF reader frequency measurements | RFID detector 1.5 or later (the page can install it on OFW or Momentum) |

`common/` holds what every page shares: the stylesheet, page helpers, and the crystal measurement and its fits.

## Publishing

After changing a page or a script, run `python3 stamp_versions.py` before pushing. It stamps each page's
modules and stylesheet with a hash of their contents, so a browser never pairs a new page with old cached files.
`python3 stamp_versions.py --check` reports any page that is out of date.

GPL-3.0.
