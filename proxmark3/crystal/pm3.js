// Proxmark3 over Web Serial: NG framing, a one-command-at-a-time client, and CMD_HW_TICKS, with the fits from
// ../../common/timefit.js at the tick counter's rate. Shared by index.html and selftest.mjs, with no DOM.

const nowS = () => (performance.timeOrigin + performance.now()) / 1000;

export const USB = { usbVendorId: 0x9ac4, usbProductId: 0x4b8f };
export const CMD_DEBUG_PRINT_STRING = 0x0100;
export const CMD_VERSION = 0x0107;
export const CMD_HW_TICKS = 0x011b;
export const PM3_SUCCESS = 0;
// The tick counter (TC0 and TC1) counts the master clock / 32. The PLL makes the 48 MHz master clock from the crystal.
export const NOMINAL = 1.5e6;
export const START = 0, READ = 1, STOP = 2;

// ---------------------------------------------------------------- framing (pm3_cmd.h, little-endian)
// Command: magic "PM3a", u16 length | 0x8000 (NG), u16 cmd, data, u16 postamble "a3" (no CRC needed over USB).
// Reply: magic "PM3b", u16 length | NG bit, i8 status, i8 reason, u16 cmd, data, u16 CRC or "b3".

const CMD_MAGIC = 0x61334d50, CMD_POST = 0x3361, REPLY_MAGIC = 0x62334d50;
const MAX_DATA = 4064; // the PM5's largest frame (the PM3's is 624)

export function makeFrame(cmd, data = new Uint8Array(0)) {
  const f = new Uint8Array(10 + data.length);
  const v = new DataView(f.buffer);
  v.setUint32(0, CMD_MAGIC, true);
  v.setUint16(4, data.length | 0x8000, true);
  v.setUint16(6, cmd, true);
  f.set(data, 8);
  v.setUint16(8 + data.length, CMD_POST, true);
  return f;
}

// The byte-stream parser resynchronises on the next magic when a header doesn't make sense.
export class FrameParser {
  constructor() { this.buf = new Uint8Array(0); }
  push(chunk) {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf);
    b.set(chunk, this.buf.length);
    const v = new DataView(b.buffer);
    const out = [];
    let i = 0;
    while (b.length - i >= 10) {
      if (v.getUint32(i, true) !== REPLY_MAGIC) { i++; continue; }
      const len = v.getUint16(i + 4, true) & 0x7fff;
      if (len > MAX_DATA) { i++; continue; }
      if (b.length - i < 12 + len) break;
      out.push({ cmd: v.getUint16(i + 8, true), status: v.getInt8(i + 6), reason: v.getInt8(i + 7),
        ng: !!(v.getUint16(i + 4, true) & 0x8000), data: b.slice(i + 10, i + 10 + len) });
      i += 12 + len;
    }
    this.buf = b.slice(i);
    return out;
  }
}

// A debug print's text: u16 flags, then the string.
export const debugText = (data) => new TextDecoder().decode(data.subarray(2));

// CMD_VERSION's reply: u32 chip id, u32 section size, u32 string length, then the version text.
export function parseVersion(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const n = Math.min(v.getUint32(8, true), d.length - 12);
  const text = new TextDecoder().decode(d.subarray(12, 12 + n)).replace(/\0.*$/s, "");
  // the OS line, without colour codes: "  OS......... Iceman/master/v4.20728-... 2026-10-29 17:30:01 a8471ac1f"
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  const os = plain.match(/^\s*OS[.:]*\s+(\S.*)$/im)?.[1]?.trim() ?? "?";
  return { chipId: v.getUint32(0, true), text: plain, os };
}

// ---------------------------------------------------------------- client

export class SerialPM3 {
  // onDebug(text): the PM3's debug prints (Dbprintf), which arrive between replies.
  constructor({ onDebug } = {}) { this.onDebug = onDebug; }
  async open(port) {
    this.port = port;
    await port.open({ baudRate: 115200 });
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    this.parser = new FrameParser();
    this.pending = null;
    this.loop();
  }
  async loop() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        const ta = nowS();
        for (const f of this.parser.push(value)) {
          const p = this.pending;
          if (f.cmd === CMD_DEBUG_PRINT_STRING) {
            const text = debugText(f.data);
            this.onDebug?.(text);
            // firmware without the command prints "unknown command" and never replies
            if (p && new RegExp(`unknown command:+\\s*0x0*${p.cmd.toString(16)}\\b`, "i").test(text)) {
              this.pending = null; clearTimeout(p.timer); p.reject(new UnknownCommand(p.cmd));
            }
            continue;
          }
          if (p && f.cmd === p.cmd) { this.pending = null; clearTimeout(p.timer); p.resolve({ ...f, ta }); }
        }
      }
    } catch (e) { this.pending?.reject(e); this.pending = null; }
  }
  // The reply, with tb and ta: local times just before sending and when the reply arrived.
  async cmd(cmd, data = new Uint8Array(0), timeoutS = 3) {
    if (this.pending) throw new Error("command already in flight");
    const reply = new Promise((resolve, reject) => {
      this.pending = { cmd, resolve, reject,
        timer: setTimeout(() => { this.pending = null; reject(new Error(`no reply to 0x${cmd.toString(16)}`)); }, timeoutS * 1000) };
    });
    const tb = nowS();
    await this.writer.write(makeFrame(cmd, data));
    return { ...(await reply), tb };
  }
  async version() {
    return parseVersion((await this.cmd(CMD_VERSION)).data);
  }
  async close() {
    try { this.reader.cancel(); this.reader.releaseLock(); this.writer.releaseLock(); await this.port.close(); } catch {}
  }
}

export class UnknownCommand extends Error {
  constructor(cmd) { super(`the firmware doesn't know command 0x${cmd.toString(16)}`); this.cmd = cmd; }
}

// ---------------------------------------------------------------- CMD_HW_TICKS

// u8 0 start (resets the count) / 1 read / 2 stop -> u32 count, little-endian. The count wraps every 47.7 min.
// Ticks adds the wraps back, which relies on reads seconds apart.
export class Ticks {
  constructor(pm3) { this.pm3 = pm3; this.last = null; this.wraps = 0; }
  async call(sub) {
    let r;
    try {
      r = await this.pm3.cmd(CMD_HW_TICKS, Uint8Array.of(sub));
    } catch (e) {
      if (e instanceof UnknownCommand) throw new Error("this firmware has no CMD_HW_TICKS: flash the test firmware first");
      throw e;
    }
    if (r.status !== PM3_SUCCESS) throw new Error(`CMD_HW_TICKS returned status ${r.status}`);
    if (r.data.length < 4) throw new Error(`CMD_HW_TICKS reply is ${r.data.length} bytes, expected 4`);
    const raw = new DataView(r.data.buffer, r.data.byteOffset).getUint32(0, true);
    return { tb: r.tb, ta: r.ta, raw, ...this.unwrap(sub, raw) };
  }
  unwrap(sub, raw) {
    if (sub === START) this.wraps = 0;
    else if (this.last !== null && raw < this.last) this.wraps++;
    this.last = raw;
    return { ticks: this.wraps * 2 ** 32 + raw, wraps: this.wraps };
  }
  start() { return this.call(START); }
  read() { return this.call(READ); }
  stop() { return this.call(STOP); }
}

// ---------------------------------------------------------------- fits (shared), at the PM3's 1.5 MHz

import * as T from "../../common/timefit.js";
export { linfit, sampleOffset, sampleRtt, fastest, refFit, refOffsetAt, boundCheck } from "../../common/timefit.js";
export const rateFit = (t, ticks, nominal = NOMINAL) => T.rateFit(t, ticks, nominal);
export const combine = (dev, ref, nominal = NOMINAL) => T.combine(dev, ref, nominal);
export const halvesCheck = (start, mid, end, t, ticks, nominal = NOMINAL) => T.halvesCheck(start, mid, end, t, ticks, nominal);
