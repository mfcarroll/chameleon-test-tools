# Chameleon Ultra FSK self-trim (experimental)

Test firmware that lets the CU match its emulated HID Prox, Paradox and ioProx cards to a reader's clock, and a page
that sets it up and shows what it learned. To try it at a reader, put the same card in several slots with and
without self-trim, and compare.

Live at https://mfcarroll.github.io/rfid-test-tools/chameleon/selftrim/ (Chrome or Edge on a computer, over USB).

## What the modes change

Each slot has a mode, saved on the CU:

- **stock**: as stock firmware. The CU modulates by switching a load across its coil, as a real tag does. That
  can't drift against the reader, but the signal is small: on a Proxmark3 at 21 mm, stock emulation read 0 of 50
  for both HID Prox and Paradox.
- **new drive only**: the CU also drives its coil through the reader-side antenna driver, about 3 times the signal.
  That signal runs on the CU's own crystal, and beats against the reader's carrier at the two clocks'
  difference. The beat costs reads and gives wrong IDs.
- **self-trim** (the default): the new drive, matched to the reader. At the start of each field, the CU measures the
  reader's carrier against its own crystal and trims its subcarrier by the difference. The CU then restarts each
  burst at a fixed phase to the reader's carrier. The CU keeps what it learns per slot, through sleep. On the same
  Proxmark3 at 21 mm: 30 to 37 of 50 (Paradox), 22 to 36 (HID Prox).
- **+ exact bits** (with any of the above): stock firmware sends a HID Prox or Paradox `0` bit as 6 periods of fc/8,
  48 carrier cycles, where RF/50 is 50 (as a T5577 sends it). Each frame is about 2 % short. A Proxmark3 recovers
  the bit clock and doesn't mind. A stricter reader might. With this flag each bit ends at the period nearest its
  boundary: 6 or 7 periods, 50 cycles on average.

The recommended test is four slots: stock, stock + exact bits, self-trim, self-trim + exact bits.

Self-trim has two costs. Each field's first burst (about 0.4 s) is the measurement and carries no ID. While the field
stays up, the CU measures again every 2 s, and each new measurement costs one more ID-less burst. The repeat catches a
reader that restarts its carrier without dropping the field.

## Firmware

- `firmware/fsk-selftrim-paradox-f56e572e-ultra-dfu-app.zip`: built from
  [`exp/fsk-selftrim-paradox`](https://github.com/mfcarroll/ChameleonUltra/tree/exp/fsk-selftrim-paradox),
  commit `f56e572e`. Reports `v2.2.0-78-gf56e572`. It's the Paradox pull request
  ([#489](https://github.com/RfidResearchGroup/ChameleonUltra/pull/489)) plus fixes for answering a reader that
  wakes the CU (from [#514](https://github.com/RfidResearchGroup/ChameleonUltra/pull/514) and
  [#515](https://github.com/RfidResearchGroup/ChameleonUltra/pull/515)), plus the self-trim research code.
- `../common/firmware/stock-v2.3.0-ultra-dfu-app.zip`: the official v2.3.0 application package, unchanged, for
  flashing back. It has no Paradox support.

Chameleon Ultra only, not Lite: the Lite has no reader-side antenna driver, which the new drive needs. Flashing
replaces the firmware. Slots and saved cards are kept. Flashing either way clears what self-trim learned, and keeps
the modes. Flash stock back when you're done.

## The page

- **Slots**: each slot's LF card, mode, how many reader fields it has seen, and the reader's clock offset against
  the CU that self-trim learned. "Fields seen" counts a reader's field arriving. A reader that drops and restores
  its field quickly (a Proxmark3 running reads back to back) can count once for many reads. Treat the count as "the
  reader was seen", not an exact number of attempts. The radio button makes a slot active. Copy report gives a
  plain-text summary for sharing (no card data).
- **Set up a test**: copies one HID Prox, Paradox or ioProx card into several slots, each with a different mode and
  an LF nickname naming it (e.g. "Paradox selftrim+x"), so they can be compared at a reader by switching slots. Only
  the LF side of each slot changes, and an HF card in the same slot stays.
- **Backup and restore**: a JSON file with every slot's LF type, card, enabled state, nickname and mode. Setting up
  a test downloads one first. Restore needs the test firmware. The file lists card types this firmware can't read
  back (Indala), but the page can't restore them.
- **Self-trim event log**: what self-trim did at each presentation: the field arriving, the wide search for the
  reader, a learned reader restored, checks that locked or failed. The CU keeps the last 32 events while it sleeps. Read them on the page after a test. Needs a wide-search test build (`fsk-selftrim-wide` `18a1c939` or later keeps
  the log through sleep).

Card data only passes between the CU and the page's memory. The page never shows, logs, stores or sends it. The
backup file you download is the only copy outside the CU. Keep it private.

## Testing at a reader

1. Load the card into one slot with your usual app or the CLI, then use _Set up a test_ with the recommended plan.
   Self-trim helps a weak signal, exact bits help a reader that is strict about bit length. Clear results. Unplug.
2. At the reader: present the CU on one slot several times. Hold the CU to the reader for at least 2 seconds the
   first time on each slot. Switch slots with the buttons. Note which slot opened it and how quickly.
3. Back on the page: Refresh, then Copy report and send it along with your notes. On a wide-search build, also
   Read event log and Copy event log.

## Command 3120

The test firmware's one new command for the page. Request: none (report), `slot, preset` (set; slot 0–7; preset
= mode 0 stock, 1 new drive only, 2 self-trim, `| 0x04` exact bits; `0xFF` = default), or `0xC1` (clear what was
learned and the field counts). Setting the active slot's preset reloads the slot. Reply (big-endian): version (1),
active slot, default preset, phase constant K, live drive and trim state, the self-trim status, then 18 bytes per
slot: stored preset, preset in use, LF type, fields seen, learned (valid, LF type, trim in steps, the reader's
line in mHz, fields averaged). `selftrim.js` parses it.

## Not tested

- Any real door reader yet. All numbers above are from one Proxmark3.
- Windows and Linux.

## Files

| file                                       |                                                              |
| ------------------------------------------ | ------------------------------------------------------------ |
| `index.html`                               | the page                                                     |
| `selftrim.js`                              | command 3120 and the slot commands, no DOM                   |
| `../common/cu.js`, `../common/flash-ui.js` | the CU client and flashing, shared with the crystal page     |
| `firmware/`                                | the test firmware (stock v2.3.0 is in `../common/firmware/`) |
