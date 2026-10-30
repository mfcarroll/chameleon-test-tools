# Proxmark3 crystal offset

Measures how fast or slow a Proxmark3's 16 MHz crystal runs, in ppm, against internet time, over USB. The PM3's
125 kHz LF carrier comes from the same crystal and is off by the same ppm. Two tools, same method:

- **The page** (`index.html`), in Chrome or Edge on a computer. Live at
  https://mfcarroll.github.io/rfid-test-tools/proxmark3/crystal/
- **The command line** (`pm3_crystal.py`), using NTP. Needs Python 3, `pyserial`, and outbound UDP port 123.

```
uv run pm3_crystal.py /dev/tty.usbmodemXXXX --minutes 30      # COM5 on Windows, /dev/ttyACM0 on Linux
```

`uv run` and `pipx run` install pyserial themselves, from the script's inline header. With plain Python,
`pip install pyserial` first, then `python3 pm3_crystal.py ...`. Quit the pm3 client first. Only one program at a
time can open the PM3's port.

## Firmware

Both tools need the test firmware. Stock firmware has no command that reads a count driven by the crystal, and its
millisecond tick runs from the internal RC oscillator. The test firmware adds **`CMD_HW_TICKS`** (0x011B), which
reads the firmware's tick counter.

- `firmware/hw-ticks-a8471ac1-pm3generic-fullimage.elf`: PM3 Easy and other generic boards (`PLATFORM=PM3GENERIC`)
- `firmware/hw-ticks-a8471ac1-pm3rdv4-fullimage.elf`: RDV4 (`PLATFORM=PM3RDV4`)

Both images are Iceman master `a078a36db` plus `CMD_HW_TICKS`, from
[`feat/hw-ticks`](https://github.com/mfcarroll/proxmark3/tree/feat/hw-ticks) at commit `a8471ac1f`. The test
firmware reports `Iceman/feat/hw-ticks/v4.23346-234-ga8471ac1f`. Flash the image for your board with your own
client, from your proxmark3 folder:

```
./client/proxmark3 /dev/tty.usbmodemXXXX --flash --image hw-ticks-a8471ac1-pm3generic-fullimage.elf
```

The command writes the OS and leaves the bootloader alone. Run `./pm3-flash-fullimage` to go back to your own build.
While the test firmware is on the PM3, the pm3 client warns that the firmware doesn't match the client. The warning
is expected.

The page doesn't flash firmware. Every PM3 owner already has the pm3 client, and the client flashes on every
platform.

## Use

1. Plug the PM3 in by USB, and quit the pm3 client.
2. Leave the button alone during the run. Standalone modes and other firmware commands use the same tick counter,
   and starting one resets or stops the count. The page and the script stop the run when a read's count moves more
   than 1 s away from the computer's clock.
3. Keep the computer awake and on the same network for the whole run.
4. 30 minutes is the default. 5 minutes gives roughly ±2 ppm, 15 about ±0.7, 30 about ±0.3, 60 about ±0.15.

A + result means the crystal runs fast.

## Method

`CMD_HW_TICKS` takes one byte. 0 starts the count from zero, 1 reads the count, and 2 stops the tick counter. The
reply is the count as a u32, little-endian.

The tick counter is TC0 and TC1 chained, counting the master clock (MCK) divided by 32. The PLL makes the 48 MHz
master clock from the 16 MHz crystal. The count therefore runs at 1.5 MHz. The u32 count wraps every 47.7 minutes. The page
and the script read the count every 2 s and add the wraps back.

The rest of the method is the Chameleon Ultra tool's, run by the same shared code (`../../common/timerun.js` and
`timefit.js`). [`../../chameleon/crystal/README.md`](../../chameleon/crystal/README.md) describes the time-server
bursts, the NTP queries and the checks.

## Accuracy

`selftest.mjs` (`node selftest.mjs`) checks the framing and the wrap counting. The self-test then runs the fits on
the Chameleon tool's synthetic runs, at 1.5 MHz and with the count wrapping. Each row is 40 runs:

| run | error rms | worst | mean reported ± |
|---|---|---|---|
| 15 min | 0.70 ppm | 2.35 | 0.66 |
| 30 min | 0.32 ppm | 0.86 | 0.32 |
| 60 min | 0.13 ppm | 0.30 | 0.16 |

On hardware (macOS, wifi), a PM3 Easy on the `exp/hw-ticks` build read −103.6 ± 0.1 ppm in a 30 min page run and
−103.7 ± 0.1 in a 30 min script run, back to back on 2026-10-29. A 30 min run of the research script that preceded
these tools read −103.7 ± 0.3 on the same PM3 on 2026-10-24.

Both runs on 2026-10-29 failed the halves check, because the Mac's clock changed rate by about 1.8 ppm between the
halves. The PM3's offset against the time reference held across the halves (page −103.6 then −103.8, script −103.4
then −103.5).

## Not tested

- The two firmware images in `firmware/`. The PM3 Easy measured so far runs the same command on an older base
  (`exp/hw-ticks`, Iceman `ac59f2f76`).
- PM5 (AT32). The PM5 firmware has a 1.5 MHz tick counter too, but there is no PM5 test build.
- Windows and Linux.

## Files

| file | |
|---|---|
| `index.html` | the page |
| `pm3.js` | the PM3 protocol (NG frames), `CMD_HW_TICKS` and the fits at 1.5 MHz. Used by the page and the self-test. |
| `selftest.mjs` | self-test, no hardware |
| `pm3_crystal.py` | the command-line version |
| `firmware/` | the test firmware |

GPL-3.0.
