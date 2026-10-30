// Chameleon Ultra over Web Serial: framing, a one-command-at-a-time client, and DFU flashing.
// No DOM in here; pages pass callbacks for progress.

const nowS = () => (performance.timeOrigin + performance.now()) / 1000;

export const CMD_GET_GIT_VERSION = 1017;
export const STATUS_SUCCESS = 0x68;
export const STATUS_INVALID_CMD = 0x67;
export const SOF = 0x11;

// ---------------------------------------------------------------- framing (chameleon_com.py, big-endian)
// SOF, LRC1, cmd u16, status u16, len u16, LRC2, data, LRC3. Each LRC covers every byte before it.

export function lrc(bytes, end = bytes.length) {
  let s = 0;
  for (let i = 0; i < end; i++) s = (s + bytes[i]) & 0xff;
  return (0x100 - s) & 0xff;
}

export function makeFrame(cmd, status = 0, data = new Uint8Array(0)) {
  const f = new Uint8Array(10 + data.length);
  f[0] = SOF;
  f[1] = lrc(f, 1);
  f[2] = cmd >> 8;
  f[3] = cmd & 0xff;
  f[4] = status >> 8;
  f[5] = status & 0xff;
  f[6] = data.length >> 8;
  f[7] = data.length & 0xff;
  f[8] = lrc(f, 8);
  f.set(data, 9);
  f[9 + data.length] = lrc(f, 9 + data.length);
  return f;
}

// Byte-stream parser; resynchronises on a bad LRC by dropping one byte, as chameleon_com.py does.
export class FrameParser {
  constructor() {
    this.buf = [];
  }
  push(chunk) {
    for (const b of chunk) this.buf.push(b);
    const out = [];
    for (;;) {
      while (this.buf.length && this.buf[0] !== SOF) this.buf.shift();
      if (this.buf.length < 9) break;
      const b = this.buf;
      if (b[1] !== lrc(b, 1) || b[8] !== lrc(b, 8)) {
        b.shift();
        continue;
      }
      const len = (b[6] << 8) | b[7];
      if (b.length < 10 + len) break;
      if (b[9 + len] !== lrc(b, 9 + len)) {
        b.shift();
        continue;
      }
      out.push({
        cmd: (b[2] << 8) | b[3],
        status: (b[4] << 8) | b[5],
        data: Uint8Array.from(b.slice(9, 9 + len)),
      });
      this.buf = b.slice(10 + len);
    }
    return out;
  }
}

// ---------------------------------------------------------------- client

export class SerialCU {
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
          if (p && f.cmd === p.cmd) {
            this.pending = null;
            clearTimeout(p.timer);
            p.resolve({ ...f, ta });
          }
        }
      }
    } catch (e) {
      this.pending?.reject(e);
      this.pending = null;
    }
  }
  // The reply, with tb and ta: local times just before sending and when the reply arrived.
  async cmd(cmd, data = new Uint8Array(0), timeoutS = 3) {
    if (this.pending) throw new Error("command already in flight");
    const reply = new Promise((resolve, reject) => {
      this.pending = {
        cmd,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending = null;
          reject(new Error(`no reply to ${cmd}`));
        }, timeoutS * 1000),
      };
    });
    const tb = nowS();
    await this.writer.write(makeFrame(cmd, 0, data));
    return { ...(await reply), tb };
  }
  async version() {
    const r = await this.cmd(CMD_GET_GIT_VERSION);
    return r.status === STATUS_SUCCESS
      ? new TextDecoder().decode(r.data)
      : `? (status 0x${r.status.toString(16)})`;
  }
  async close() {
    try {
      this.reader.cancel();
      this.reader.releaseLock();
      this.writer.releaseLock();
      await this.port.close();
    } catch {}
  }
}

// ---------------------------------------------------------------- flashing

// chameleon-ultra.js does the Nordic DFU. The CU reboots into its bootloader, which is a different USB device with
// its own permission. Chrome remembers ports it has been allowed, so the browser only asks for the bootloader the
// first time; after that the flasher finds it. The library always opens the port picker, so connectTo() answers the
// picker with a known port instead.
const CUJS = "https://cdn.jsdelivr.net/npm/chameleon-ultra.js@0.4.7";
const DFU_USB = { usbVendorId: 0x1915, usbProductId: 0x521f };
let lib = null;

export async function loadFlashLib() {
  if (!lib) {
    const [core, ws, dz] = await Promise.all([
      import(`${CUJS}/+esm`),
      import(`${CUJS}/plugin/WebserialAdapter/+esm`),
      import(`${CUJS}/plugin/DfuZip/+esm`),
    ]);
    lib = { ...core, WebserialAdapter: ws.default, DfuZip: dz.default };
  }
  return lib;
}

async function connectTo(ultra, port) {
  if (!port) return await ultra.connect();
  navigator.serial.requestPort = async () => port;
  try {
    await ultra.connect();
  } finally {
    delete navigator.serial.requestPort;
  }
}

async function findBootloader(timeoutS = 10) {
  for (
    const end = Date.now() + timeoutS * 1000;
    Date.now() < end;
    await new Promise((r) => setTimeout(r, 500))
  ) {
    for (const p of await navigator.serial.getPorts()) {
      const i = p.getInfo();
      if (
        i.usbVendorId === DFU_USB.usbVendorId &&
        i.usbProductId === DFU_USB.usbProductId
      )
        return p;
    }
  }
  return null;
}

// One flash. start(knownPort) returns true when it's written, or false when the bootloader needs the user to allow
// it: then call allowBootloader() from a click.
export class Flasher {
  constructor(fw, { log, status }) {
    this.fw = fw;
    this.log = log;
    this.status = status;
  }
  async start(knownPort) {
    const L = await loadFlashLib();
    this.ultra = new L.ChameleonUltra();
    await this.ultra.use(new L.WebserialAdapter());
    await connectTo(this.ultra, knownPort); // with no known port, the picker needs the user's click
    const ab = await (await fetch(this.fw.zip)).arrayBuffer();
    const zip = new L.DfuZip(L.Buffer.fromView(new Uint8Array(ab)));
    this.image = await zip.getAppImage();
    if (!this.image) throw new Error(`${this.fw.zip} has no application image`);
    if (this.ultra.isDfu()) {
      await this.write();
      return true;
    }
    if ((await this.ultra.cmdGetDeviceModel()) !== L.DeviceModel.ULTRA)
      throw new Error("this firmware is for the Chameleon Ultra, not the Lite");
    this.log(
      `flash: CU on ${await this.ultra.cmdGetGitVersion()}, rebooting it into the bootloader`,
    );
    await this.ultra.cmdDfuEnter();
    this.status("waiting for the bootloader…");
    const dfuPort = await findBootloader();
    if (!dfuPort) return false;
    await connectTo(this.ultra, dfuPort);
    await this.write();
    return true;
  }
  async allowBootloader() {
    await this.ultra.connect();
    if (!this.ultra.isDfu())
      throw new Error(
        "that port is the CU itself, not its bootloader: try again",
      );
    await this.write();
  }
  async write() {
    this.log(`flash: writing ${this.fw.name}, ${this.image.body.length} bytes`);
    const onProgress = (p) => {
      if (p.type === 2)
        this.status(`writing ${Math.floor((100 * p.offset) / p.size)} %`);
    };
    this.ultra.emitter.on("progress", onProgress);
    try {
      await this.ultra.dfuUpdateImage(this.image);
    } finally {
      this.ultra.emitter.removeListener("progress", onProgress);
    }
    this.log(
      `flash: done; the CU restarts on ${this.fw.name}. Connect it again to check.`,
    );
  }
}
