// Fits for timing a device's crystal against a time server: the device's tick rate against this computer's
// clock, and this computer's clock against the server. Shared by the crystal pages.
// `nominal` is the device's tick rate in Hz.

// Least squares y = k x + b. sigK is the slope's 1-sigma from the residual scatter.
export function linfit(x, y) {
  const n = x.length;
  let mx = 0,
    my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  const k = sxy / sxx,
    b = my - k * mx;
  let ss = 0;
  const res = new Array(n);
  for (let i = 0; i < n; i++) {
    res[i] = y[i] - (k * x[i] + b);
    ss += res[i] ** 2;
  }
  return {
    k,
    b,
    res,
    sigK: n > 2 ? Math.sqrt(ss / (n - 2)) / Math.sqrt(sxx) : NaN,
  };
}

export const median = (a) => {
  const s = [...a].sort((p, q) => p - q),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Fits ticks against local time. Each read's time is the midpoint of the local times just before and just after
// it. A USB stall delays a read and puts it off the line, and the fit runs once more without reads more than 5 MADs
// off. Times are in seconds.
export function rateFit(t, ticks, nominal) {
  const x = t.map((v) => v - t[0]),
    y = ticks.map((v) => v - ticks[0]);
  let f = linfit(x, y);
  let resUs = f.res.map((r) => (r / f.k) * 1e6);
  const med = median(resUs);
  const mad = median(resUs.map((r) => Math.abs(r - med))) || 1;
  const keep = resUs.map((r) => Math.abs(r - med) <= 5 * 1.4826 * mad);
  const nk = keep.filter(Boolean).length;
  let kx = x,
    ky = y;
  if (x.length >= 4 && nk >= 3 && nk < x.length) {
    kx = x.filter((_, i) => keep[i]);
    ky = y.filter((_, i) => keep[i]);
    f = linfit(kx, ky);
    resUs = y.map((v, i) => ((v - (f.k * x[i] + f.b)) / f.k) * 1e6);
  }
  const kept = resUs.filter((_, i) => keep[i] || nk < 3);
  return {
    f: f.k,
    ppm: (f.k / nominal - 1) * 1e6,
    sig: (f.sigK / nominal) * 1e6,
    rmsUs: Math.sqrt(kept.reduce((s, r) => s + r * r, 0) / kept.length),
    maxUs: Math.max(...resUs.map(Math.abs)),
    dropped: x.length - nk,
    n: x.length,
  };
}

// Reference sample: {tb, ta, srv} in seconds (local before/after, server stamp). offset = server - local mid.
export const sampleOffset = (s) => s.srv - (s.tb + s.ta) / 2;
export const sampleRtt = (s) => s.ta - s.tb;

// The fastest `frac` of a burst (at least `min`). A fast round trip bounds the stamp tightly. Slow ones carry
// queueing that is not split evenly between the two directions.
export function fastest(samples, frac = 0.2, min = 5) {
  const s = [...samples].sort((a, b) => sampleRtt(a) - sampleRtt(b));
  return s.slice(
    0,
    Math.min(s.length, Math.max(min, Math.ceil(s.length * frac))),
  );
}

// Fits the local clock against the reference: offset(t) = a + k (t - t0), where offset is server minus local.
// The fit uses the fastest samples of each group given: the two end bursts, or during the run the start burst
// plus each probe's best. k > 0 means the local clock runs slow. A constant asymmetry shifts only `a`, and
// cancels out of k.
export function refFit(groups, opts = {}) {
  const pts = groups.flatMap((g) =>
    fastest(g, opts.frac ?? 0.2, opts.min ?? 5),
  );
  if (pts.length < 3) return null;
  const t0 = pts[0].tb;
  const x = pts.map((s) => (s.tb + s.ta) / 2 - t0),
    y = pts.map(sampleOffset);
  const f = linfit(x, y);
  return {
    k: f.k,
    a: f.b,
    t0,
    sigK: f.sigK,
    n: pts.length,
    span: Math.max(...x) - Math.min(...x),
    rmsMs: Math.sqrt(f.res.reduce((s, r) => s + r * r, 0) / f.res.length) * 1e3,
  };
}

export const refOffsetAt = (fit, t) => fit.a + fit.k * (t - fit.t0);

// A rough consistency test. The server stamps its reply somewhere between our send (tb) and our receipt (ta).
// Mapped to server time through the fit, tb must not fall after the stamp, and ta must not fall before it, within
// q for the millisecond stamp. Jitter can't explain a sample that breaks this. The test is weak: its slack is about
// one one-way delay (~6 ms here), and it only catches large jumps. halvesCheck is the sensitive check. Returns
// the violations and the worst one, in ms.
export function boundCheck(fit, samples, q = 0.001) {
  let n = 0,
    worst = 0;
  for (const s of samples) {
    const early = s.tb + refOffsetAt(fit, s.tb) - (s.srv + q); // > 0: line puts the send after the stamp
    const late = s.srv - q - (s.ta + refOffsetAt(fit, s.ta)); // > 0: line puts the receipt before the stamp
    const v = Math.max(early, late);
    if (v > 0) {
      n++;
      worst = Math.max(worst, v);
    }
  }
  return { violations: n, of: samples.length, worstMs: worst * 1e3 };
}

// The check that matters. A path's asymmetry can step partway through a run (a route change, or a different
// server behind the name). The step biases k by step / T, where T is the run's length, and the end bursts can't
// see it. A third burst halfway splits the run into halves. A step in one half biases that half's rate by 2 x
// step / T and leaves the other half alone, and the two halves then disagree.
// Each half compares the crystal against the reference, not the local clock. The local clock's rate can change
// between the halves, and the device's rate against the local clock then moves by the opposite amount.
// The result itself fits only the end bursts. The middle burst would add nothing to the slope's precision (it sits
// at the mean of x).
// ⚠ A slow, steady drift in asymmetry looks exactly like a clock rate, and no schedule of bursts can detect it.
// sourcesCheck can, when a second server is in use.
export function halvesCheck(start, mid, end, t, ticks, nominal, nsig = 3) {
  if (!mid.length) return null;
  const a = refFit([start, mid]),
    b = refFit([mid, end]);
  const split = mid.reduce((s, x) => s + (x.tb + x.ta) / 2, 0) / mid.length;
  const half = (keep) => {
    const i = t.map((_, k) => k).filter((k) => keep(t[k]));
    return i.length >= 3
      ? rateFit(
          i.map((k) => t[k]),
          i.map((k) => ticks[k]),
          nominal,
        )
      : null;
  };
  const da = half((x) => x <= split),
    db = half((x) => x >= split);
  if (!a || !b || !da || !db) return null;
  const ca = combine(da, a, nominal),
    cb = combine(db, b, nominal);
  const diff = cb.ppm - ca.ppm,
    sig = Math.hypot(ca.sig, cb.sig);
  // `limit`: the largest bias from a single step that could pass unflagged (half the detection threshold).
  return {
    first: ca.ppm,
    second: cb.ppm,
    hostFirst: -a.k * 1e6,
    hostSecond: -b.k * 1e6,
    diff,
    sig,
    limit: (nsig * sig) / 2,
    ok: Math.abs(diff) <= nsig * sig,
  };
}

// Averages several reference fits' slopes, each weighted by 1 / sigK^2. The result keeps the first fit's a and t0,
// which only place a plot's baseline.
export function meanRef(fits) {
  const ok = fits.filter(Boolean);
  if (ok.length < 2) return ok[0] ?? null;
  const w = ok.map((f) => 1 / f.sigK ** 2),
    W = w.reduce((s, v) => s + v, 0);
  return {
    ...ok[0],
    k: ok.reduce((s, f, i) => s + f.k * w[i], 0) / W,
    sigK: 1 / Math.sqrt(W),
    n: ok.reduce((s, f) => s + f.n, 0),
    span: Math.max(...ok.map((f) => f.span)),
  };
}

// Compares two references reached through different networks. A path problem on one moves only that reference's
// slope, even a slow drift in asymmetry that the halves check can't see. diff is the crystal's offset against b
// minus its offset against a.
export function sourcesCheck(a, b, nsig = 3) {
  const diff = (a.k - b.k) * 1e6,
    sig = Math.hypot(a.sigK, b.sigK) * 1e6;
  return { diff, sig, ok: Math.abs(diff) <= nsig * sig };
}

// Crystal offset against the reference. Ticks per local second f -> per reference second f / (1 + k).
export function combine(cu, ref, nominal) {
  const ppm = (cu.f / (1 + ref.k) / nominal - 1) * 1e6;
  return {
    ppm,
    sig: Math.hypot(cu.sig, ref.sigK * 1e6),
    hostPpm: ref.k * 1e6,
    uncorrected: cu.ppm,
  };
}
