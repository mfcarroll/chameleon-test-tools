// Command 3125, the CU's crystal tick counter: its sub-commands and reply, the client call, and the fits from
// ../../common/timefit.js at the CU's tick rate. Framing is ../common/cu.js. Shared by index.html and
// selftest.mjs; no DOM.

export {
  lrc,
  makeFrame,
  FrameParser,
  SOF,
  CMD_GET_GIT_VERSION,
  STATUS_SUCCESS,
  STATUS_INVALID_CMD,
} from "../common/cu.js";
import { STATUS_SUCCESS, STATUS_INVALID_CMD } from "../common/cu.js";

export const NOMINAL = 16e6; // command 3125 counts 16 MHz HFCLK ticks with HFXO held
export const CMD_HFXO_COUNT = 3125;
export const START = 0,
  READ = 1,
  STOP = 2;

// v1 payload: u64 ticks, u32 overflows, u32 raw, u16 lapses, u8 running, u8 hfxo_now (big-endian).
export function parseHfxoCount(d) {
  if (d.length < 20)
    throw new Error(`3125 reply is ${d.length} bytes, expected 20`);
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    ticks: Number(v.getBigUint64(0)), // exact below 2^53: 17.8 years at 16 MHz
    overflows: v.getUint32(8),
    raw: v.getUint32(12),
    lapses: v.getUint16(16),
    running: !!v.getUint8(18),
    hfxo: !!v.getUint8(19),
  };
}

// One 3125 call on a SerialCU: { tb, ta, ticks, ... }, the reply bracketed by local times.
export async function hfxoCount(cu, sub) {
  const r = await cu.cmd(CMD_HFXO_COUNT, Uint8Array.of(sub));
  if (r.status === STATUS_INVALID_CMD)
    throw new Error(
      "firmware has no command 3125: flash the test firmware first",
    );
  if (r.status !== STATUS_SUCCESS)
    throw new Error(`3125 returned status 0x${r.status.toString(16)}`);
  return { tb: r.tb, ta: r.ta, ...parseHfxoCount(r.data) };
}

// ---------------------------------------------------------------- fits (shared), at the CU's 16 MHz

import * as T from "../../common/timefit.js";
export {
  linfit,
  sampleOffset,
  sampleRtt,
  fastest,
  refFit,
  refOffsetAt,
  boundCheck,
} from "../../common/timefit.js";
export const rateFit = (t, ticks, nominal = NOMINAL) =>
  T.rateFit(t, ticks, nominal);
export const combine = (cu, ref, nominal = NOMINAL) =>
  T.combine(cu, ref, nominal);
export const halvesCheck = (start, mid, end, t, ticks, nominal = NOMINAL) =>
  T.halvesCheck(start, mid, end, t, ticks, nominal);
