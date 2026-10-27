# Chameleon test tools

Browser and command-line tools for testing [Chameleon Ultra](https://github.com/RfidResearchGroup/ChameleonUltra)
hardware, with the test firmware each one needs. Each tool lives in its own folder with its own README.

Pages: https://mfcarroll.github.io/chameleon-test-tools/

| tool | what it measures | firmware |
|---|---|---|
| [`crystal/`](crystal/) | the 32 MHz crystal's offset in ppm, against an internet time server | stock v2.3.0 + command 3125 ([`feat/hfxo-count`](https://github.com/mfcarroll/ChameleonUltra/tree/feat/hfxo-count)) |
| [`selftrim/`](selftrim/) | (experiment) HID Prox, Paradox and ioProx emulation modes to compare at a real reader, and what self-trim learned about it | Paradox PR #489 + self-trim research ([`exp/fsk-selftrim-paradox`](https://github.com/mfcarroll/ChameleonUltra/tree/exp/fsk-selftrim-paradox)) |

Test firmware is built from branches of [mfcarroll/ChameleonUltra](https://github.com/mfcarroll/ChameleonUltra) and
committed here as DFU packages, so a page can flash it straight from the browser. Each build also gets a release
here, tagged `fw-<branch>-<commit>`. Each tool keeps the stock package next to its test firmware for flashing back.

GPL-3.0, as ChameleonUltra. The pages load [chameleon-ultra.js](https://github.com/taichunmin/chameleon-ultra.js)
(MIT) from jsDelivr for flashing.
