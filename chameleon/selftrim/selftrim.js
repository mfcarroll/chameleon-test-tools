// FSK self-trim field test: command 3120's request and reply. No DOM, no Web Serial in here.
//
// The test firmware gives each slot a preset, saved on the CU: a mode, 0 stock (as stock firmware), 1 drive (the new
// modulation drive, no trim), 2 self-trim (the new drive, plus: measure the reader's clock, trim to it, and restart
// in phase with it; what it learns is kept per slot), plus flag 0x04, exact bits (HID Prox and Paradox bits at
// exactly 50 carrier cycles on average; stock firmware makes each fc/8 bit 48). Unset slots use the default.

export const CMD_EXP_FSK = 3120;
export const EXACT_BITS = 0x04;
const MODES = ["stock", "new drive only", "self-trim"];
const SHORT = ["stock", "drive", "selftrim"];
// The choices offered, in this order.
export const CHOICES = [0, EXACT_BITS, 2, 2 | EXACT_BITS, 1, 1 | EXACT_BITS];
export const presetName = (p) =>
  MODES[p & 3] + (p & EXACT_BITS ? " + exact bits" : "");
// A slot nickname for a preset, e.g. "Paradox selftrim+x" (the CU allows 32 bytes).
export const presetNick = (lfType, p) =>
  `${lfName(lfType)} ${SHORT[p & 3]}${p & EXACT_BITS ? "+x" : ""}`;
// Test plans: the modes to compare, in the order they go into slots.
export const PLANS = {
  4: [0, EXACT_BITS, 2, 2 | EXACT_BITS],
  6: [0, EXACT_BITS, 2, 2 | EXACT_BITS, 1, 1 | EXACT_BITS],
};
export const UNSET = 0xff;
export const FSK_TYPES = new Set([200, 201, 202]); // HID Prox, ioProx, Paradox: the types the presets apply to

const LF_TYPES = {
  0: "none",
  100: "EM410x",
  101: "EM410x/16",
  102: "EM410x/32",
  103: "EM410x/64",
  104: "EM410x Electra",
  150: "PAC",
  170: "Viking",
  180: "Jablotron",
  200: "HID Prox",
  201: "ioProx",
  202: "Paradox",
  300: "Indala",
  310: "IDTECK",
};
export const lfName = (t) => LF_TYPES[t] ?? `type ${t}`;

export const reqQuery = () => new Uint8Array(0);
export const reqSet = (slot, preset) => Uint8Array.of(slot, preset); // slot 0-7, preset 0-2 or UNSET
export const reqClear = () => Uint8Array.of(0xc1);

// The reader's line on the CU's alias (mHz) -> the reader's clock against the CU's crystal, ppm.
export const readerPpm = (mhz) => (mhz / 1000 - 5000) / 0.125;

export function parse(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d[0] !== 1)
    throw new Error(`3120 reply version ${d[0]}, this page knows version 1`);
  const r = {
    version: d[0],
    active: d[1],
    defaultPreset: d[2],
    k: d[3],
    drive: { requested: d[4], active: d[5] },
    trim: { requested: v.getInt16(6), applied: v.getInt16(8) },
    frameTicks: v.getUint32(10),
  };
  const alen = d[14],
    a = 15;
  r.auto = {
    locked: !!d[a],
    moves: v.getUint16(a + 1),
    rejects: v.getUint16(a + 3),
    widePpm: v.getInt16(a + 5) / 10,
    wides: v.getUint16(a + 7),
    restores: v.getUint16(a + 12),
  };
  let n = a + alen;
  r.slots = [];
  for (let s = 0; s < 8; s++, n += 18) {
    const slot = {
      slot: s,
      stored: d[n],
      preset: d[n + 1],
      lfType: v.getUint16(n + 2),
      fields: v.getUint16(n + 4),
    };
    if (d[n + 6]) {
      const mhz = v.getUint32(n + 11);
      slot.kept = {
        lfType: v.getUint16(n + 7),
        trim: v.getInt16(n + 9),
        mhz,
        readerPpm: readerPpm(mhz),
        fields: v.getUint16(n + 15),
      };
    }
    r.slots.push(slot);
  }
  if (n !== d.length)
    throw new Error(`3120 reply is ${d.length} bytes, expected ${n}`);
  return r;
}

// Plain text for pasting into a chat: one line per slot that matters.
export function report(r, firmware) {
  const lines = [`CU firmware ${firmware}, active slot ${r.active + 1}`];
  for (const s of r.slots) {
    if (!FSK_TYPES.has(s.lfType) && !s.kept && !s.fields) continue;
    let l = `slot ${s.slot + 1}: ${lfName(s.lfType)}, ${presetName(s.preset)}${s.stored === UNSET ? " (default)" : ""}, fields seen ${s.fields}`;
    if (s.kept)
      l += `, reader ${fmtPpm(s.kept.readerPpm)} ppm vs CU (learned on ${lfName(s.kept.lfType)}, trim ${s.kept.trim})`;
    else if ((s.preset & 3) === 2) l += ", no reader learned";
    lines.push(l);
  }
  return lines.join("\n");
}

export const fmtPpm = (p) => (p >= 0 ? "+" : "") + p.toFixed(1);

// ---------------------------------------------------------------- copying a card between slots
// Standard slot commands (chameleon_cmd.py). Slots are 0-7 here. Card data is passed through, never decoded.

export const CMD = {
  SET_ACTIVE_SLOT: 1003,
  SET_SLOT_TAG_TYPE: 1004,
  SET_SLOT_DATA_DEFAULT: 1005,
  SET_SLOT_ENABLE: 1006,
  SET_SLOT_TAG_NICK: 1007,
  GET_SLOT_TAG_NICK: 1008,
  SLOT_DATA_CONFIG_SAVE: 1009,
  GET_ACTIVE_SLOT: 1018,
  DELETE_SLOT_TAG_NICK: 1021,
  GET_ENABLED_SLOTS: 1023,
  DELETE_SLOT_SENSE_TYPE: 1024,
};
// Every LF type whose card this firmware can read back and write: [get, set, bytes the get reply carries before
// the card]. EM410x replies with a 2-byte prefix ahead of the ID.
export const LF_CARD = {
  100: [5001, 5000, 2],
  101: [5001, 5000, 2],
  102: [5001, 5000, 2],
  103: [5001, 5000, 2],
  104: [5001, 5000, 2],
  150: [5007, 5006, 0],
  170: [5005, 5004, 0],
  180: [5011, 5010, 0],
  200: [5003, 5002, 0],
  201: [5009, 5008, 0],
  202: [5015, 5014, 0],
  310: [5013, 5012, 0],
};
const SENSE_LF = 1;
// Get/set the active slot's card, per FSK type: [get, set, data length].
export const EMU_ID = {
  200: [5003, 5002, 13],
  201: [5009, 5008, 16],
  202: [5015, 5014, 6],
};

export const reqSlot = (slot) => Uint8Array.of(slot);
export const reqSlotType = (slot, type) =>
  Uint8Array.of(slot, type >> 8, type & 0xff);
export const reqEnableLf = (slot, on = true) =>
  Uint8Array.of(slot, SENSE_LF, on ? 1 : 0);
export const reqSlotLf = (slot) => Uint8Array.of(slot, SENSE_LF);
export const hex = (b) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (h) =>
  Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

// A backup file holds each slot's LF side only (type, card, enabled, nickname, mode); HF is never touched.
export const BACKUP_KIND = "rfid-test-tools/chameleon/selftrim LF slot backup";
const OLD_KINDS = ["chameleon-test-tools/selftrim LF slot backup"];
export function checkBackup(b) {
  if (
    !(b?.kind === BACKUP_KIND || OLD_KINDS.includes(b?.kind)) ||
    b.version !== 1 ||
    !Array.isArray(b.slots) ||
    b.slots.length !== 8
  )
    throw new Error("this isn't a backup file from this page");
  return b;
}
export function reqNickLf(slot, name) {
  const b = new TextEncoder().encode(name).slice(0, 32);
  const r = new Uint8Array(2 + b.length);
  r[0] = slot;
  r[1] = SENSE_LF;
  r.set(b, 2);
  return r;
}

// ---------------------------------------------------------------- self-trim event log (wide-search test builds)
// Command 3100 at offset 0xFFFE: what self-trim did, the last 32 events, oldest first. From fsk-selftrim-wide 18a1c939
// the log is kept while the CU sleeps and each event carries the wake (presentation) it happened in and the time since
// that wake; older wide builds (0fcc91d9 and before) lose it in sleep and send 16-byte events with no header. 0xFFFC
// clears it. Builds before the wide search have no log.

export const CMD_EVENT_LOG = 3100;
export const reqLog = () => Uint8Array.of(0xff, 0xfe, 0, 0);
export const reqLogClear = () => Uint8Array.of(0xff, 0xfc, 0, 0);
const EV_KIND = {
  1: "wide search, capture A",
  2: "wide search, capture B",
  3: "restored learned reader",
  4: "narrow check failed, unlocked",
  5: "narrow check locked",
  6: "trim moved",
  7: "field",
};
const EV_WHY = {
  0: "trim",
  1: "near matched",
  2: "weak",
  3: "self line",
  4: "too far",
  5: "no peak",
  6: "matched",
};
const EV_FAIL = { 1: "invalid", 2: "leak", 3: "outside guard" };

export function parseLog(d) {
  if (d.length < 2) return null; // no log in this firmware
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const total = v.getUint16(0);
  let size = 16,
    at = 2,
    wake = null;
  if (d.length >= 5 && d[2] === 20 && (d.length - 5) % 20 === 0) {
    size = 20;
    wake = v.getUint16(3);
    at = 5;
  } else if ((d.length - 2) % 16 !== 0) {
    throw new Error(
      `event log reply of ${d.length} bytes: not a format this page knows`,
    );
  }
  const events = [];
  for (; at + size <= d.length; at += size) {
    const k = d[at],
      w = d[at + 1];
    const e = {
      kind: k,
      what: EV_KIND[k] ?? `kind ${k}`,
      field: v.getUint16(at + 2),
      trim: v.getInt16(at + 4),
      ownPpm: v.getInt32(at + 6) / 10,
      ppm: v.getInt32(at + 10) / 10,
      snr: v.getInt16(at + 14) / 10,
    };
    if (size === 20) {
      e.wake = v.getUint16(at + 16);
      e.ms = v.getUint16(at + 18);
    }
    if (k === 2) {
      e.result = EV_WHY[w & 0x7f] ?? w & 0x7f;
      e.valid = !!(w & 0x80);
    } else if (k === 4) e.result = EV_FAIL[w] ?? w;
    else if (k === 7) e.slot = w;
    events.push(e);
  }
  return { total, wake, kept: size === 20, events };
}

// One line per event, as plain text.
export function logLine(e) {
  const t =
    e.wake != null ? `wake ${e.wake} ${(e.ms / 1000).toFixed(2)} s  ` : "";
  const f = `field ${e.field}  `;
  switch (e.kind) {
    case 7:
      return (
        `${t}${f}field on slot ${e.slot + 1}, plays trim ${e.trim} (${fmtPpm(e.ownPpm)} ppm)` +
        (e.ppm ? `, learned reader ${fmtPpm(e.ppm)}` : ", no learned reader")
      );
    case 1:
      return `${t}${f}wide search: capture A stored (our line ${fmtPpm(e.ownPpm)})`;
    case 2:
      return (
        `${t}${f}wide search: ${e.valid ? "found" : "nothing usable"}, reader ${fmtPpm(e.ppm)} ppm, ` +
        `${e.result === "trim" ? "" : e.result + ", "}SNR ${e.snr.toFixed(1)} dB`
      );
    case 3:
      return `${t}${f}restored learned reader ${fmtPpm(e.ppm)} ppm (trim ${e.trim})`;
    case 4:
      return `${t}${f}narrow check ${e.result}: reader ${fmtPpm(e.ppm)}, our line ${fmtPpm(e.ownPpm)}, SNR ${e.snr.toFixed(1)} dB; unlocked`;
    case 5:
      return `${t}${f}narrow check locked: reader ${fmtPpm(e.ppm)}, SNR ${e.snr.toFixed(1)} dB`;
    case 6:
      return `${t}${f}trim moved to ${fmtPpm(e.ownPpm)} ppm, following the reader at ${fmtPpm(e.ppm)} (${e.snr} fields)`;
    default:
      return `${t}${f}${e.what}: own ${e.ownPpm}, ppm ${e.ppm}, SNR ${e.snr}`;
  }
}

export function logReport(l, firmware) {
  const head =
    `CU firmware ${firmware}: self-trim event log, ${l.total} events since cleared` +
    (l.total > l.events.length ? ` (last ${l.events.length} shown)` : "") +
    (l.kept ? "" : "; this firmware loses the log when the CU sleeps");
  return [head, ...l.events.map(logLine)].join("\n");
}
