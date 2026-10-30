// node selftest.mjs — framing against bytes from pm3_crystal.py's packing, the tick unwrap, then the fits on
// synthetic runs.
import * as P from "./pm3.js";

const hex = (u) => Buffer.from(u).toString("hex");
const unhex = (s) => Uint8Array.from(Buffer.from(s, "hex"));
let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };

console.log("framing");
check(hex(P.makeFrame(P.CMD_HW_TICKS, Uint8Array.of(1))) === "504d336101801b010161 33".replace(" ", ""),
  "CMD_HW_TICKS READ request matches Python");
check(hex(P.makeFrame(P.CMD_VERSION)) === "504d3361008007016133", "CMD_VERSION request matches Python");
// reply: PM3b, len 4 | NG, status 0, reason 0, cmd 0x011b, u32 0x12345678, postamble b3
const reply = unhex("504d3362048000001b01785634126233");
// a debug print ("unknown command:: 0x011b") as the stock firmware sends it, flags u16 first
const dbgText = new TextEncoder().encode("unknown command:: 0x011b");
const dbg = new Uint8Array(12 + 2 + dbgText.length);
dbg.set(unhex("504d3362"));
new DataView(dbg.buffer).setUint16(4, (2 + dbgText.length) | 0x8000, true);
new DataView(dbg.buffer).setUint16(8, P.CMD_DEBUG_PRINT_STRING, true);
dbg.set(dbgText, 12);
const p = new P.FrameParser();
// garbage, the reply split across chunks, a header with an impossible length, the debug print, the reply again
const frames = [...p.push(unhex("00504d")), ...p.push(reply.slice(0, 7)), ...p.push(reply.slice(7)),
  ...p.push(unhex("504d3362ffff00001b01")), ...p.push(dbg), ...p.push(reply)];
check(frames.length === 3 && frames[0].cmd === P.CMD_HW_TICKS && frames[2].cmd === P.CMD_HW_TICKS &&
  frames[1].cmd === P.CMD_DEBUG_PRINT_STRING, "parser: split, garbage and a bad header handled");
check(new DataView(frames[0].data.buffer).getUint32(0, true) === 0x12345678 && frames[0].status === 0 && frames[0].ng,
  "CMD_HW_TICKS payload decodes");
check(P.debugText(frames[1].data) === "unknown command:: 0x011b", "debug print decodes");

// CMD_VERSION's text as the firmware formats it (colours included)
const vtext = " [ \x1b[33mARM\x1b[0m ]\n  bootrom: Iceman/master/v4.21611 2026-09-12 12:59:21 1fb3497f1\n" +
  "       os: Iceman/feat/hw-ticks/v4.23346-234-ga8471ac1f 2026-10-29 17:30:01 a8471ac1f\n";
const vb = new TextEncoder().encode(vtext);
const vd = new Uint8Array(12 + vb.length + 3);
new DataView(vd.buffer).setUint32(0, 0x270b0a40, true);
new DataView(vd.buffer).setUint32(8, vb.length + 1, true);
vd.set(vb, 12);
const ver = P.parseVersion(vd);
check(ver.os === "Iceman/feat/hw-ticks/v4.23346-234-ga8471ac1f 2026-10-29 17:30:01 a8471ac1f" && ver.chipId === 0x270b0a40,
  `version: os "${ver.os}"`);

console.log("unwrap");
{
  const t = new P.Ticks(null);
  const seq = [[P.START, 5], [P.READ, 3e9], [P.READ, 4.2e9], [P.READ, 1e8], [P.READ, 3e9], [P.READ, 2e6]];
  const got = seq.map(([s, raw]) => t.unwrap(s, raw).ticks);
  check(JSON.stringify(got) === JSON.stringify([5, 3e9, 4.2e9, 2 ** 32 + 1e8, 2 ** 32 + 3e9, 2 ** 33 + 2e6]),
    "32-bit wraps carried into the count");
  check(t.unwrap(P.START, 7).ticks === 7, "START resets the wraps");
}

// Seeded RNG so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return { u, exp: (m) => -m * Math.log(u()), norm: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
}

// One synthetic run on the page's schedule, as in ../../chameleon/crystal/selftest.mjs, at the PM3's 1.5 MHz. The
// count is quantised to 0.67 us and wraps past 2^32, and Ticks adds the wraps back as on the page. True time is T,
// the local clock runs at (1 + host), each network direction takes 6 ms plus exponential queueing (mean 12 ms), and
// server stamps are whole milliseconds.
function simulate({ seed, devPpm, hostPpm, minutes = 30, burstN = 120, shift = 0, shiftAt = 0.3, hostStep = 0 }) {
  const r = rng(seed);
  // hostStep: the local clock's rate changes by this many ppm halfway through
  const loc = (T) => 1.79e9 + 1234.5 + T * (1 + hostPpm * 1e-6) + Math.max(0, T - minutes * 30) * hostStep * 1e-6;
  const ref = [], t = [], ticks = [];
  const D = minutes * 60;
  const req = (T, phase) => {
    const out = 0.006 + r.exp(0.012) + (T > shiftAt * D ? shift : 0), back = 0.006 + r.exp(0.012);
    ref.push({ tb: loc(T), ta: loc(T + out + back), srv: Math.floor((1.79e9 + T + out) * 1000) / 1000, phase });
    return out + back;
  };
  const burst = (T, phase) => { for (let i = 0; i < burstN; i++) T += req(T, phase) + 0.25; };
  burst(0, "start");
  for (let Tp = burstN * 0.25 + 60; Tp < D - burstN * 0.25 - 30; Tp += 60) { let x = Tp; for (let i = 0; i < 5; i++) x += req(x, "probe") + 0.25; }
  burst(D / 2 - burstN * 0.13, "mid");
  burst(D - burstN * 0.27, "end");
  const un = new P.Ticks(null);
  for (let Tc = 0; Tc <= minutes * 60; Tc += 2) {
    const usb = 0.0005 + Math.abs(r.norm()) * 0.0007 + (r.u() < 0.01 ? 0.02 : 0);   // ~1 ms, the odd 20 ms stall
    t.push((loc(Tc) + loc(Tc + usb)) / 2);
    const raw = (Math.floor((Tc + usb / 2) * P.NOMINAL * (1 + devPpm * 1e-6)) + 4.0e9) % 2 ** 32;   // wraps early on
    ticks.push(un.unwrap(Tc === 0 ? P.START : P.READ, raw).ticks);
  }
  const ph = (p) => ref.filter((s) => s.phase === p);
  const fit = P.refFit([ph("start"), ph("end")]);
  return { res: P.combine(P.rateFit(t, ticks), fit), bc: P.boundCheck(fit, ph("probe")),
    hc: P.halvesCheck(ph("start"), ph("mid"), ph("end"), t, ticks) };
}

console.log("rate fit");
for (const ppm of [-103.7, 0, 12.3, 140]) {
  const r = rng(7), t = [], k = [];
  // the read is timed at t but the PM3 latched its count at t + jitter (±1 ms USB, one 20 ms stall)
  for (let i = 0; i < 180; i++) { const x = i * 10, jit = r.norm() * 1e-3 + (i === 50 ? 0.02 : 0); t.push(1.7e9 + x); k.push(Math.floor((x + jit) * P.NOMINAL * (1 + ppm * 1e-6)) + 123456789); }
  const f = P.rateFit(t, k);
  check(Math.abs(f.ppm - ppm) < 0.5 && f.dropped >= 1, `true ${ppm} fit ${f.ppm.toFixed(3)} dropped ${f.dropped}`);
}

for (const minutes of [30, 15, 60]) {
  console.log(`end-to-end, ${minutes} min, 40 seeds (PM3 -103.7, host clock -6.5 ppm)`);
  const errs = [], sigs = [];
  let viol = 0, flagged = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const { res, bc, hc } = simulate({ seed, devPpm: -103.7, hostPpm: -6.5, minutes });
    errs.push(res.ppm + 103.7); sigs.push(res.sig);
    viol += bc.violations;
    if (!hc.ok) flagged++;
  }
  const rms = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length), worst = Math.max(...errs.map(Math.abs));
  const msig = sigs.reduce((s, v) => s + v, 0) / sigs.length;
  console.log(`  error rms ${rms.toFixed(3)} ppm, worst ${worst.toFixed(3)}; mean reported ± ${msig.toFixed(3)}; ` +
    `bound violations ${viol}; halves flagged ${flagged}/40`);
  check(rms < { 15: 0.8, 30: 0.4, 60: 0.2 }[minutes], "error rms under target");
  check(msig > 0.6 * rms && msig < 1.6 * rms, "reported ± is an honest estimate of the actual scatter");
  check(viol === 0 && flagged <= 1, "no false alarms on a steady path");
}

{
  // the local clock's rate changing halfway, as macOS's did by 1.8 ppm in two runs on 2026-10-29
  let flagged = 0, errSum = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { res, hc } = simulate({ seed, devPpm: -103.7, hostPpm: -5, hostStep: 1.8 });
    if (!hc.ok) flagged++;
    errSum += Math.abs(res.ppm - (-103.7));
  }
  console.log(`local clock rate +1.8 ppm halfway through a 30 min run: mean error ${(errSum / 20).toFixed(2)} ppm; ` +
    `halves check flagged ${flagged}/20`);
  check(flagged <= 1, "a change in the local clock's rate is not taken for a path change");
}

console.log(fails ? `${fails} FAILED` : "selftest ok");
process.exit(fails ? 1 : 0);
