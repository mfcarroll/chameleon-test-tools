// Flipper Zero over Web Serial: its text CLI, installing a .fap, and the RFID detector's `rfid_detector_cal`
// session. No DOM in here. The CLI echoes what is typed and ends each command's output with the ">: " prompt.

export const NOMINAL = 64e6; // the app's timer: 64 MHz from the crystal's PLL
export const CAL_LIMIT = 100; // ppm, as the app's Calibration screen
export const APP_PATH = "/ext/apps/Tools/nfc_rfid_detector.fap"; // where the app catalog and this page install it
const PROMPT = ">: ";
const ANSI = /\x1b\[[0-9;]*m/g;

export class SerialFlipper {
  constructor(now) {
    this.now = now;
  } // the page's clock, for timestamping replies

  async open(port) {
    this.port = port;
    await port.open({ baudRate: 230400 });
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    this.text = ""; // everything received and not consumed yet
    this.waiter = null; // { test, resolve, reject, timer }
    this.loop();
    await this.write("\r");
    await this.until((t) => t.includes(PROMPT), 5); // the banner (if any) and a prompt
  }

  async loop() {
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.text += dec.decode(value, { stream: true }).replace(ANSI, "");
        this.at = this.now();
        this.check();
      }
    } catch (e) {
      this.waiter?.reject(e);
      this.waiter = null;
    }
  }

  check() {
    const w = this.waiter;
    if (!w) return;
    let r;
    try {
      r = w.test(this.text);
    } catch (e) {
      this.waiter = null;
      clearTimeout(w.timer);
      w.reject(e);
      return;
    }
    if (r === undefined || r === false || r === null) return;
    this.waiter = null;
    clearTimeout(w.timer);
    w.resolve({ r, ta: this.at });
  }

  // Wait until test(text) returns something; the test consumes what it used from this.text itself.
  until(test, timeoutS = 3) {
    return new Promise((resolve, reject) => {
      this.waiter = {
        test,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiter = null;
          reject(new Error("no reply from the Flipper"));
        }, timeoutS * 1000),
      };
      this.check();
    });
  }

  write(s) {
    return this.writer.write(
      typeof s === "string" ? new TextEncoder().encode(s) : s,
    );
  }

  // One CLI command; returns its output without the echo and the prompt.
  async cli(cmd, timeoutS = 5) {
    this.text = "";
    await this.write(cmd + "\r");
    const { r } = await this.until((t) => {
      const i = t.indexOf(PROMPT);
      if (i < 0) return;
      this.text = t.slice(i + PROMPT.length);
      return t.slice(0, i);
    }, timeoutS);
    return r
      .split(/\r?\n/)
      .filter((l) => l.trim() && l.trim() !== cmd)
      .join("\n");
  }

  async deviceInfo() {
    const out = await this.cli("info device");
    const info = {};
    for (const l of out.split("\n")) {
      const m = l.match(/^\s*([\w.]+)\s*:\s*(.*?)\s*$/);
      if (m) info[m[1]] = m[2];
    }
    return info;
  }

  // Replace a file with `bytes` through `storage write_chunk`, which prints "Ready" and then reads exactly that
  // many bytes. It appends, so the old file is removed first.
  async writeFile(path, bytes, onProgress) {
    await this.cli(`storage remove ${path}`).catch(() => {});
    this.text = "";
    await this.write(`storage write_chunk ${path} ${bytes.length}\r`);
    await this.until((t) => {
      if (/Storage error/i.test(t)) throw new Error(t.trim());
      return t.includes("Ready") || undefined;
    }, 5);
    for (let i = 0; i < bytes.length; i += 512) {
      await this.write(bytes.subarray(i, i + 512));
      onProgress?.(Math.min(bytes.length, i + 512) / bytes.length);
    }
    this.text = "";
    await this.until((t) => t.includes(PROMPT) || undefined, 10);
    const stat = await this.cli(`storage stat ${path}`);
    if (!stat.includes(String(bytes.length)))
      throw new Error(`written file doesn't check out: ${stat}`);
  }

  // ------------------------------------------------------------ the app's calibration session

  // A complete line of the session, or undefined.
  takeLine() {
    const i = this.text.indexOf("\n");
    if (i < 0) return;
    const l = this.text.slice(0, i).trim();
    this.text = this.text.slice(i + 1);
    return l;
  }

  lineMatching(re, timeoutS = 3) {
    return this.until(() => {
      for (let l; (l = this.takeLine()) !== undefined;) {
        if (/could not find command/.test(l))
          throw Object.assign(
            new Error("the RFID detector app isn't running"),
            { noCommand: true },
          );
        if (l.startsWith("ERR")) throw new Error(l.slice(4));
        if (l === "STOPPED" && !re.test(l)) {
          this.session = false;
          throw new Error("cancelled on the Flipper: nothing saved");
        }
        const m = l.match(re);
        if (m) return m;
      }
    }, timeoutS);
  }

  // The app on its calibration screen. If it is already running, the command itself takes it there.
  async openApp() {
    const out = await this.cli(`loader open ${APP_PATH} cal`);
    if (out.trim())
      throw new Error(
        `couldn't open the RFID detector app (${out.trim()}). Exit any app open on the Flipper, ` +
          "or open it yourself: Left for Config, then Calibrate with a computer",
      );
    await new Promise((r) => setTimeout(r, 1500));
  }

  // The app running now, or null ("loader info").
  async runningApp() {
    const m = (await this.cli("loader info")).match(
      /Application "(.*)" is running/,
    );
    return m ? m[1] : null;
  }

  // Returns the app's saved calibration in ppm. Opens the app first if it isn't running.
  async calStart() {
    this.last = null;
    this.hi = 0;
    for (let attempt = 0; ; attempt++) {
      // a CR first ends anything half-typed at the shell prompt, such as a progress line sent as the session ended
      await this.write("\r");
      await new Promise((r) => setTimeout(r, 300));
      this.text = "";
      await this.write("rfid_detector_cal\r");
      try {
        const { r } = await this.lineMatching(/^OK lfcal (\d+) (-?\d+)/, 5);
        this.session = true;
        return Number(r[2]) / 10;
      } catch (e) {
        if (!e.noCommand) throw e;
        if (attempt)
          throw new Error(
            "the RFID detector app on the Flipper is older than 1.5: install it above",
          );
        // the detector already open just needs the command again
        if (!/detector/i.test((await this.runningApp()) ?? ""))
          await this.openApp();
      }
    }
  }

  // {tb, ta, ticks, pll}: the 32-bit count unwrapped (it wraps every 67 s; reads are seconds apart).
  async calRead() {
    const tb = this.now();
    await this.write("r");
    const { r, ta } = await this.lineMatching(/^(\d+) ([01])$/);
    const raw = Number(r[1]);
    if (this.last !== null && raw < this.last) this.hi++;
    this.last = raw;
    return { tb, ta, ticks: this.hi * 2 ** 32 + raw, pll: r[2] === "1" };
  }

  // Progress for the Flipper's status screen (no reply): seconds, and the running estimate in ppm if there is one.
  calProgress(elapsed, total, est) {
    let msg = `p${Math.round(elapsed)} ${Math.round(total)}`;
    if (est)
      msg += ` ${Math.round(est.ppm * 10)} ${Math.max(1, Math.round(est.sig * 10))}`;
    return this.write(msg + "\r");
  }

  // The result and its ±: the app saves them and shows them.
  async calSend(ppm, sig) {
    const v = Math.round(ppm * 10);
    await this.write(`s${v} ${Math.max(1, Math.round(sig * 10))}\r`);
    await this.lineMatching(new RegExp(`^SET ${v}$`));
  }

  async calStop() {
    if (!this.session) return;
    this.session = false;
    // The Flipper may have ended the session itself (OK or Cancel there). A "q" now would reach its shell.
    if (/^STOPPED\r?$/m.test(this.text)) {
      this.text = "";
      return;
    }
    await this.write("q");
    await this.lineMatching(/^STOPPED$/).catch(() => {});
  }

  async close() {
    try {
      await this.calStop();
    } catch {}
    try {
      this.reader.cancel();
      this.reader.releaseLock();
      this.writer.releaseLock();
      await this.port.close();
    } catch {}
  }
}

// Builds for each firmware family (apps/manifest.json): same fork, same API major, and a minor no newer than the
// Flipper's. The newest such build wins.
export function pickBuild(builds, info) {
  const fork = info["firmware.origin.fork"],
    major = Number(info["firmware.api.major"]),
    minor = Number(info["firmware.api.minor"]);
  return (
    builds
      .filter((b) => b.fork === fork && b.api[0] === major && b.api[1] <= minor)
      .sort((a, b) => b.api[1] - a.api[1])[0] ?? null
  );
}
