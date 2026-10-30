// Fits for timing a device's crystal against a time server: the device's tick rate against this computer's
// clock, and this computer's clock against the server. Shared by the crystal pages.
// `nominal` is the device's tick rate in Hz.


// Least squares y = k x + b; sigK is the slope's 1-sigma from the residual scatter.
export function linfit(x, y) {
  const n = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  const k = sxy / sxx, b = my - k * mx;
  let ss = 0;
  const res = new Array(n);
  for (let i = 0; i < n; i++) { res[i] = y[i] - (k * x[i] + b); ss += res[i] ** 2; }
  return { k, b, res, sigK: n > 2 ? Math.sqrt(ss / (n - 2)) / Math.sqrt(sxx) : NaN };
}

export const median = (a) => { const s = [...a].sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Ticks against local mid-bracket time, refit once without reads more than 5 MADs off the
// line (a USB stall only ever delays a read). Times in seconds.
export function rateFit(t, ticks, nominal) {
  const x = t.map((v) => v - t[0]), y = ticks.map((v) => v - ticks[0]);
  let f = linfit(x, y);
  let resUs = f.res.map((r) => (r / f.k) * 1e6);
  const med = median(resUs);
  const mad = median(resUs.map((r) => Math.abs(r - med))) || 1;
  const keep = resUs.map((r) => Math.abs(r - med) <= 5 * 1.4826 * mad);
  const nk = keep.filter(Boolean).length;
  let kx = x, ky = y;
  if (x.length >= 4 && nk >= 3 && nk < x.length) {
    kx = x.filter((_, i) => keep[i]); ky = y.filter((_, i) => keep[i]);
    f = linfit(kx, ky);
    resUs = y.map((v, i) => ((v - (f.k * x[i] + f.b)) / f.k) * 1e6);
  }
  const kept = resUs.filter((_, i) => keep[i] || nk < 3);
  return {
    f: f.k, ppm: (f.k / nominal - 1) * 1e6, sig: (f.sigK / nominal) * 1e6,
    rmsUs: Math.sqrt(kept.reduce((s, r) => s + r * r, 0) / kept.length),
    maxUs: Math.max(...resUs.map(Math.abs)), dropped: x.length - nk, n: x.length,
  };
}

// Reference sample: {tb, ta, srv} in seconds (local before/after, server stamp). offset = server - local mid.
export const sampleOffset = (s) => s.srv - (s.tb + s.ta) / 2;
export const sampleRtt = (s) => s.ta - s.tb;

// The fastest `frac` of a burst (at least `min`). A fast round trip bounds the stamp tightly; slow ones carry
// queueing that is not split evenly between the two directions.
export function fastest(samples, frac = 0.2, min = 5) {
  const s = [...samples].sort((a, b) => sampleRtt(a) - sampleRtt(b));
  return s.slice(0, Math.min(s.length, Math.max(min, Math.ceil(s.length * frac))));
}

// Local clock against the reference: offset(t) = a + k (t - t0) through the fastest samples of every group
// given (the two end bursts; during the run, the start burst plus each mid-run probe's best). k > 0 means
// the local clock runs slow. A constant asymmetry shifts `a` only, so it cancels out of k.
export function refFit(groups, opts = {}) {
  const pts = groups.flatMap((g) => fastest(g, opts.frac ?? 0.2, opts.min ?? 5));
  if (pts.length < 3) return null;
  const t0 = pts[0].tb;
  const x = pts.map((s) => (s.tb + s.ta) / 2 - t0), y = pts.map(sampleOffset);
  const f = linfit(x, y);
  return { k: f.k, a: f.b, t0, sigK: f.sigK, n: pts.length, span: Math.max(...x) - Math.min(...x),
    rmsMs: Math.sqrt(f.res.reduce((s, r) => s + r * r, 0) / f.res.length) * 1e3 };
}

export const refOffsetAt = (fit, t) => fit.a + fit.k * (t - fit.t0);

// Gross consistency test. The server stamped its reply somewhere between our send and our receipt, so mapped to
// server time, tb must not be after the stamp and ta must not be before it (+-q for the millisecond stamp).
// A sample that violates this cannot be explained by jitter. ⚠ Weak: the slack is about one one-way delay
// (~6 ms here), so it only catches large jumps; halvesCheck is the sensitive one. Returns violations, worst ms.
export function boundCheck(fit, samples, q = 0.001) {
  let n = 0, worst = 0;
  for (const s of samples) {
    const early = s.tb + refOffsetAt(fit, s.tb) - (s.srv + q);   // > 0: line puts the send after the stamp
    const late = (s.srv - q) - (s.ta + refOffsetAt(fit, s.ta));   // > 0: line puts the receipt before the stamp
    const v = Math.max(early, late);
    if (v > 0) { n++; worst = Math.max(worst, v); }
  }
  return { violations: n, of: samples.length, worstMs: worst * 1e3 };
}

// The check that matters. A step in the path's asymmetry (route change, a different server behind the name)
// between the end bursts biases k by step / T and nothing at the ends can see it. With a third burst halfway,
// the two halves' rates differ by 2 x that bias, so their disagreement measures it. Fit on the ends only:
// the middle burst adds nothing to the slope's precision (it sits at the mean of x).
// Each half compares the crystal against the reference, not the local clock. The local clock's rate can change
// between the halves, and the device's rate against the local clock then moves by the opposite amount.
// ⚠ A slow, steady DRIFT in asymmetry looks exactly like a clock rate and no schedule can detect it.
export function halvesCheck(start, mid, end, t, ticks, nominal, nsig = 3) {
  const a = refFit([start, mid]), b = refFit([mid, end]);
  const split = mid.reduce((s, x) => s + (x.tb + x.ta) / 2, 0) / mid.length;
  const half = (keep) => {
    const i = t.map((_, k) => k).filter((k) => keep(t[k]));
    return i.length >= 3 ? rateFit(i.map((k) => t[k]), i.map((k) => ticks[k]), nominal) : null;
  };
  const da = half((x) => x <= split), db = half((x) => x >= split);
  if (!a || !b || !da || !db) return null;
  const ca = combine(da, a, nominal), cb = combine(db, b, nominal);
  const diff = cb.ppm - ca.ppm, sig = Math.hypot(ca.sig, cb.sig);
  // `limit`: the largest bias from a single step that could pass unflagged (half the detection threshold).
  return { first: ca.ppm, second: cb.ppm, hostFirst: -a.k * 1e6, hostSecond: -b.k * 1e6, diff, sig,
    limit: (nsig * sig) / 2, ok: Math.abs(diff) <= nsig * sig };
}

// Crystal offset against the reference. Ticks per local second f -> per reference second f / (1 + k).
export function combine(cu, ref, nominal) {
  const ppm = (cu.f / (1 + ref.k) / nominal - 1) * 1e6;
  return { ppm, sig: Math.hypot(cu.sig, ref.sigK * 1e6), hostPpm: ref.k * 1e6, uncorrected: cu.ppm };
}
