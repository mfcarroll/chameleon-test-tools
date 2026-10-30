// node selftest.mjs — framing against bytes from chameleon_com.py's packing, then the fits on synthetic runs.
import * as H from "./hfxo.js";

const hex = (u) => Buffer.from(u).toString("hex");
const unhex = (s) => Uint8Array.from(Buffer.from(s, "hex"));
let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };

console.log("framing");
check(hex(H.makeFrame(3125, 0, Uint8Array.of(1))) === "11ef0c3500000001be01ff", "3125 READ request matches Python");
check(hex(H.makeFrame(1017)) === "11ef03f9000000000400", "1017 request matches Python");
const reply = unhex("11ef0c35006800144300000100000030390000010000003039000001012a");
const p = new H.FrameParser();
// garbage, then the reply split across chunks, then a corrupted copy, then the reply again
const frames = [...p.push(Uint8Array.of(0x00, 0x11, 0x42)), ...p.push(reply.slice(0, 7)), ...p.push(reply.slice(7)),
  ...p.push(Uint8Array.from(reply, (b, i) => (i === 15 ? b ^ 1 : b))), ...p.push(reply)];
check(frames.length === 2 && frames.every((f) => f.cmd === 3125 && f.status === 0x68), "parser: split, garbage and bad LRC handled");
const c = H.parseHfxoCount(frames[0].data);
check(c.ticks === 2 ** 40 + 12345 && c.overflows === 256 && c.raw === 12345 && c.lapses === 0 && c.running && c.hfxo,
  "3125 payload decodes");

// Seeded RNG so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return { u, exp: (m) => -m * Math.log(u()), norm: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
}

// One synthetic run on the page's schedule. True time T; the local clock runs at (1 + host) and starts at an
// arbitrary epoch; the CU counts at (1 + cuPpm) of true time. Network: each direction 6 ms + exponential
// queueing (mean 12 ms), so round trips look like the 12.6 ms min / 38 ms median measured to Akamai; the
// server stamp is truncated to the millisecond. `shift` adds a step in the one-way asymmetry at `shiftAt` of the run.
function simulate({ seed, cuPpm, hostPpm, minutes = 30, burstN = 120, shift = 0, shiftAt = 0.3, hostStep = 0 }) {
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
  for (let Tc = 0; Tc <= minutes * 60; Tc += 2) {
    const usb = 0.0005 + Math.abs(r.norm()) * 0.0007 + (r.u() < 0.01 ? 0.02 : 0);   // ~1 ms, the odd 20 ms stall
    t.push((loc(Tc) + loc(Tc + usb)) / 2);
    ticks.push(Math.round((Tc + usb / 2) * H.NOMINAL * (1 + cuPpm * 1e-6)) + 987654321);
  }
  const ph = (p) => ref.filter((s) => s.phase === p);
  const fit = H.refFit([ph("start"), ph("end")]);
  return { res: H.combine(H.rateFit(t, ticks), fit), bc: H.boundCheck(fit, ph("probe")),
    hc: H.halvesCheck(ph("start"), ph("mid"), ph("end"), t, ticks) };
}

console.log("rate fit");
for (const ppm of [-37, 0, 12.3, 140]) {
  const r = rng(7), t = [], k = [];
  // the read is timed at t but the CU latched its count at t + jitter (±1 ms USB, one 20 ms stall)
  for (let i = 0; i < 180; i++) { const x = i * 10, jit = r.norm() * 1e-3 + (i === 50 ? 0.02 : 0); t.push(1.7e9 + x); k.push(Math.round((x + jit) * H.NOMINAL * (1 + ppm * 1e-6)) + 123456789); }
  const f = H.rateFit(t, k);
  check(Math.abs(f.ppm - ppm) < 0.5 && f.dropped >= 1, `true ${ppm} fit ${f.ppm.toFixed(3)} dropped ${f.dropped}`);
}

for (const minutes of [30, 15, 60]) {
  console.log(`end-to-end, ${minutes} min, 40 seeds (CU +36.45, host clock -6.5 ppm)`);
  const errs = [], sigs = [];
  let viol = 0, flagged = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const { res, bc, hc } = simulate({ seed, cuPpm: 36.45, hostPpm: -6.5, minutes });
    errs.push(res.ppm - 36.45); sigs.push(res.sig);
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

for (const shiftMs of [2, 4, 8]) {
  let caught = 0, errSum = 0, bcCaught = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { res, bc, hc } = simulate({ seed, cuPpm: 36.45, hostPpm: -6.5, shift: shiftMs / 1000 });
    if (!hc.ok) caught++;
    if (bc.violations) bcCaught++;
    errSum += Math.abs(res.ppm - 36.45);
  }
  // a one-way step s moves the measured offset (out - back) / 2 by s / 2, so the bias is s / 2 / 1800 s
  console.log(`${shiftMs} ms one-way delay step at 30% of a 30 min run: mean error ${(errSum / 20).toFixed(2)} ppm (expect ` +
    `${(shiftMs / 2 / 1.8).toFixed(2)}); halves check flagged ${caught}/20, bound check ${bcCaught}/20`);
  if (shiftMs >= 8) check(caught >= 18, `halves check catches a ${shiftMs} ms step (${(shiftMs / 3.6).toFixed(1)} ppm bias)`);
}

{
  // the local clock's rate changing halfway, as macOS's did by 1.8 ppm in two runs on 2026-10-29
  let flagged = 0, errSum = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { res, hc } = simulate({ seed, cuPpm: 36.45, hostPpm: -5, hostStep: 1.8 });
    if (!hc.ok) flagged++;
    errSum += Math.abs(res.ppm - (36.45));
  }
  console.log(`local clock rate +1.8 ppm halfway through a 30 min run: mean error ${(errSum / 20).toFixed(2)} ppm; ` +
    `halves check flagged ${flagged}/20`);
  check(flagged <= 1, "a change in the local clock's rate is not taken for a path change");
}

console.log(fails ? `${fails} FAILED` : "selftest ok");
process.exit(fails ? 1 : 0);
