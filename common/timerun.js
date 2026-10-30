// A crystal measurement against a time server, and the page sections that show it (Progress, Result, the plot).
// Shared by the crystal pages; the device comes in as { start, read, stop }, each
// read being { tb, ta, ticks } (ticks bracketed by local times before and after).
//
// The reference is an HTTPS time server (time.akamai.com/?ms: millisecond stamps, open to any page). Its requests
// come in dense bursts at the start and end, because for a straight-line rate the points belong at the ends, and
// only each burst's fastest round trips are kept. A third burst halfway checks the network path didn't change;
// small probes between them feed the running estimate and the plot. The local clock is
// performance.timeOrigin + performance.now(): monotonic and never slewed, so a straight line describes it.

import * as T from "./timefit.js";
import { $, nowS, fmt, fmtPm, log, sleep, saveJson } from "./page.js";

const REF_URL = "https://time.akamai.com/?ms";
const READ_INTERVAL = 2.0; // s between device reads
const BURST_GAP = 0.25; // s between requests inside a burst
const PROBE_EVERY = 60; // s between probes, unless the run sets probeEvery
const SETTLED_SIG = 5; // ppm: the running estimate shows once its ± is under this
const PROBE_N = 5; // requests per probe; its fastest is the probe's point

let run = null;
export const currentRun = () => run;

export function newRun({ minutes, burstN, nominal, ...extra }) {
  run = {
    id: new Date().toISOString(),
    minutes,
    burstN,
    nominal,
    ...extra,
    ref: [],
    reads: [],
    t: [],
    c: [],
    probes: [],
    hidden: [],
    startBurst: [],
    endBurst: [],
    t0: nowS(),
  };
  for (const id of ["result", "devrate", "host", "rms", "bounds", "prov"])
    $(id).textContent = "–";
  $("result").className = "big";
  return run;
}

async function refSample(phase) {
  const tb = nowS();
  const r = await fetch(REF_URL, { cache: "no-store" });
  const body = await r.text();
  const ta = nowS();
  const srv = Number(body);
  if (!r.ok || !isFinite(srv))
    throw new Error(`time server returned ${r.status} "${body.slice(0, 40)}"`);
  const s = { tb, ta, srv, phase };
  run.ref.push(s);
  return s;
}

async function burst(phase, n) {
  $("phase").textContent = `${phase} burst`;
  log(`${phase} burst: ${n} time-server requests`);
  const out = [];
  await fetch(REF_URL, { cache: "no-store" })
    .then((r) => r.text())
    .catch(() => {}); // warm the connection (TLS); not counted
  for (let i = 0; i < n && !run.aborted; i++) {
    const t = nowS();
    try {
      out.push(await refSample(phase));
    } catch (e) {
      log(`  request failed: ${e.message}`);
    }
    update();
    await sleep(BURST_GAP - (nowS() - t));
  }
  const rtts = out.map(T.sampleRtt).sort((a, b) => a - b);
  if (rtts.length)
    log(
      `  ${out.length} samples, round trip fastest ${(rtts[0] * 1e3).toFixed(1)} ms, median ${(rtts[rtts.length >> 1] * 1e3).toFixed(1)} ms`,
    );
  return out;
}

function addRead(p) {
  run.reads.push(p);
  run.t.push((p.tb + p.ta) / 2);
  run.c.push(p.ticks);
}

async function readLoop(dev, onRead) {
  while (!run.stopReads) {
    const t = nowS();
    addRead(await dev.read());
    provisional();
    await onRead?.(run, t);
    update();
    await sleep(READ_INTERVAL - (nowS() - t));
  }
}

// Runs the whole measurement. Returns the result, or null if it was aborted or failed.
export async function measure(dev, { onRead } = {}) {
  const n = run.burstN;
  try {
    run.wake = await navigator.wakeLock?.request("screen");
  } catch {
    log("no screen wake lock: keep the computer awake yourself");
  }
  const timer = setInterval(update, 1000);
  try {
    addRead(await dev.start());
    const readsDone = readLoop(dev, onRead).catch((e) => {
      run.readError = e;
      run.aborted = true;
    });
    // bursts are centred on 0, the halfway point and the end: each starts half a burst early
    const bt = n * (BURST_GAP + 0.04);
    const probesUntil = async (t) => {
      while (!run.aborted && !run.finishNow && nowS() < t) {
        $("phase").textContent = "measuring";
        const tp = nowS();
        const probe = [];
        for (let i = 0; i < PROBE_N; i++) {
          try {
            probe.push(await refSample("probe"));
          } catch {}
          await sleep(BURST_GAP);
        }
        if (probe.length) run.probes.push(probe);
        provisional();
        while (
          !run.aborted &&
          !run.finishNow &&
          nowS() < Math.min(t, tp + (run.probeEvery ?? PROBE_EVERY))
        )
          await sleep(1);
      }
    };
    run.startBurst = await burst("start", n);
    await probesUntil(run.t0 + run.minutes * 30 - bt / 2);
    if (!run.aborted && !run.finishNow) run.midBurst = await burst("mid", n);
    await probesUntil(run.t0 + run.minutes * 60 - bt);
    if (!run.aborted) run.endBurst = await burst("end", n);
    run.stopReads = true;
    await readsDone;
    if (run.readError) throw run.readError;
    await dev.stop();
    if (run.aborted) {
      log("aborted");
      $("phase").textContent = "aborted";
      return null;
    }
    return finalResult();
  } catch (e) {
    log(`run stopped: ${e.message}`);
    $("phase").textContent = "failed";
    await dev.stop().catch(() => {});
    return null;
  } finally {
    clearInterval(timer);
    run.wake?.release().catch(() => {});
    update();
  }
}

// The running estimate, after every read and probe, and the clock and scatter figures behind it. The plots are drawn
// from the first request and read, and get their lines once there is enough to fit.
function provisional() {
  const ref = run.probes.length
    ? T.refFit([run.startBurst, ...run.probes.map((p) => T.fastest(p, 0, 1))])
    : null;
  const fit = run.t.length >= 3 ? T.rateFit(run.t, run.c, run.nominal) : null;
  run.plotted = { ref, fit };
  drawServer(ref);
  drawDevice(fit);
  if (run.t.length < 10 || !ref) return;
  run.estimate = T.combine(fit, ref, run.nominal);
  run.estimate.settled = run.estimate.sig < SETTLED_SIG;
  $("prov").textContent = run.estimate.settled
    ? fmtPm(run.estimate.ppm, run.estimate.sig)
    : "settling";
  $("devrate").textContent = `${fmt(fit.ppm, 1)} ppm`;
  $("host").textContent = `${fmt(-run.estimate.hostPpm, 1)} ppm`;
  $("rms").textContent = `${(fit.rmsUs / 1000).toFixed(2)} ms`;
  $("bounds").textContent = "after the run (it needs the end burst)";
}

// The result, with .suspect when a check failed; null when the fits can't be trusted at all.
function finalResult() {
  const fit = T.rateFit(run.t, run.c, run.nominal);
  const ref = T.refFit([run.startBurst, run.endBurst]);
  if (!ref) {
    log("not enough time-server samples to fit");
    return null;
  }
  const r = T.combine(fit, ref, run.nominal);
  const hc = run.midBurst
    ? T.halvesCheck(
        run.startBurst,
        run.midBurst,
        run.endBurst,
        run.t,
        run.c,
        run.nominal,
      )
    : null;
  const bc = T.boundCheck(ref, run.ref);
  $("phase").textContent = "done";
  $("result").textContent = fmtPm(r.ppm, r.sig);
  // the result supersedes the running estimate, which never saw the end burst
  $("prov").textContent = fmtPm(r.ppm, r.sig);
  $("resultnote").textContent =
    `The crystal's offset, + meaning fast: ${(ref.span / 60).toFixed(1)} min against time.akamai.com, ${fit.n} reads.`;
  $("devrate").textContent = `${fmt(r.uncorrected, 1)} ppm`;
  $("host").textContent = `${fmt(-r.hostPpm, 1)} ppm`;
  $("rms").textContent = `${(fit.rmsUs / 1000).toFixed(2)} ms`;
  // The computer's clock stops while it sleeps and the device keeps counting: the reads then sit on two lines.
  // USB jitter is about 1 ms rms, so 20 ms is unmistakable.
  if (fit.rmsUs > 20000) {
    log(
      `⚠ reads scatter ${(fit.rmsUs / 1000).toFixed(0)} ms rms around the fit: did the computer sleep? Rejected.`,
    );
    $("result").textContent = "rejected";
    $("result").className = "big bad";
    $("resultnote").textContent =
      "The reads don't fit one line, probably because the computer slept. Run it again with the computer awake.";
    return null;
  }
  const suspect = (hc && !hc.ok) || bc.violations > 0;
  $("bounds").innerHTML = !hc
    ? `<span class="warn">not checked: the run finished early</span>`
    : !hc.ok
      ? `<span class="bad">failed: the network path changed during the run, so the result may be off</span>`
      : bc.violations
        ? `<span class="bad">failed: some time-server samples are far off the line</span>`
        : `<span class="ok">passed: the network path stayed the same</span>`;
  $("result").className =
    "big " + (suspect ? "bad" : !hc || run.hidden.length ? "warn" : "ok");
  log(
    `RESULT ${fmt(r.ppm, 3)} ppm ± ${r.sig.toFixed(3)} (uncorrected ${fmt(r.uncorrected, 3)}, host clock ${fmt(-r.hostPpm, 3)} ppm vs server)`,
  );
  log(
    `  ref fit: ${ref.n} samples, rms ${ref.rmsMs.toFixed(2)} ms; read fit rms ${(fit.rmsUs / 1000).toFixed(2)} ms, dropped ${fit.dropped}`,
  );
  if (hc)
    log(
      `  halves: crystal ${fmt(hc.first, 3)} then ${fmt(hc.second, 3)} ppm, diff ${fmt(hc.diff, 3)} ± ${hc.sig.toFixed(3)} (host clock ${fmt(hc.hostFirst, 3)} then ${fmt(hc.hostSecond, 3)}): ${hc.ok ? "ok" : "PATH CHANGED"}`,
    );
  log(
    `  bound check: ${bc.violations}/${bc.of} samples violate (worst ${bc.worstMs.toFixed(2)} ms)`,
  );
  if (suspect)
    log(
      "  ⚠ the path to the time server changed during the run: treat this result as suspect and re-run",
    );
  if (run.hidden.length)
    log(
      `  ⚠ the tab was hidden ${run.hidden.length}x during the run; check the read count looks right`,
    );
  run.plotted = { ref, fit };
  drawServer(ref);
  drawDevice(fit);
  run.result = {
    ...r,
    fit,
    ref,
    halves: hc,
    bounds: bc,
    hidden: run.hidden,
    suspect: suspect || !hc,
  };
  return run.result;
}

function update() {
  if (!run) return;
  const elapsed = Math.max(0, Math.floor(nowS() - run.t0));
  $("elapsed").textContent =
    `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")} / ${run.minutes} min`;
  $("reads").textContent = String(run.reads.length);
  $("refn").textContent = String(run.ref.length);
  const rt = run.ref.map(T.sampleRtt);
  if (rt.length)
    $("minrtt").textContent = `${(Math.min(...rt) * 1e3).toFixed(1)} ms`;
}

// Finish now, Abort, Download log, and noting when the tab is hidden. `file` names the downloaded log.
export function bindRunControls(file) {
  $("finish").onclick = () => {
    if (run) {
      run.finishNow = true;
      log("finishing early: end burst next");
    }
  };
  $("abort").onclick = () => {
    if (run) {
      run.aborted = true;
      run.stopReads = true;
    }
  };
  $("download").onclick = () => {
    const { wake, ...data } = run;
    saveJson(`${file}-${run.id.replace(/[:.]/g, "")}.json`, data);
  };
  document.addEventListener("visibilitychange", () => {
    if (run && !run.result && document.hidden) {
      run.hidden.push(nowS());
      log(
        "tab hidden: timers keep running in a worker, but keep it visible if you can",
      );
    }
  });
}

// ---------------------------------------------------------------- plot

// Draws the plots again from the last fits, for a page that shows them after they were hidden: a canvas that isn't
// displayed has no size to draw at.
export function redrawPlots() {
  if (!run?.plotted) return;
  drawServer(run.plotted.ref);
  drawDevice(run.plotted.fit);
}

// Tick values for an axis from lo to hi: a step of 1, 2 or 5 times a power of ten, giving about `count` ticks.
function niceTicks(lo, hi, count) {
  const rough = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step)
    ticks.push(Math.round(v / step) * step);
  return { ticks, decimals: Math.max(0, -Math.floor(Math.log10(step))) };
}

// Sets up a plot canvas with its grid and axes: minutes 0 to xmax/60 across, lo to hi ms up. Returns what the
// caller needs to draw on it.
function plotFrame(id, xmax, lo, hi) {
  // a margin above and below the data, so nothing sits on the plot's edge
  const margin = (hi - lo) * 0.06;
  lo -= margin;
  hi += margin;
  const cv = $(id),
    dpr = devicePixelRatio || 1;
  const W = cv.clientWidth,
    Hh = cv.clientHeight;
  cv.width = W * dpr;
  cv.height = Hh * dpr;
  const g = cv.getContext("2d");
  g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  // Tp leaves a strip at the top for the line's label
  const L = 44,
    R = 8,
    Tp = 20,
    B = 22;
  const X = (x) => L + (x / xmax) * (W - L - R),
    Y = (y) => Tp + (1 - (y - lo) / (hi - lo)) * (Hh - Tp - B);
  g.font = "11px -apple-system, sans-serif";
  g.fillStyle = col("--muted");
  g.strokeStyle = col("--line");
  const yAxis = niceTicks(lo, hi, 7);
  for (const y of yAxis.ticks) {
    g.beginPath();
    g.moveTo(L, Y(y));
    g.lineTo(W - R, Y(y));
    g.stroke();
    g.fillText(`${y.toFixed(yAxis.decimals)} ms`, 2, Y(y) + 4);
  }
  const xAxis = niceTicks(0, xmax / 60, 6);
  xAxis.ticks.forEach((minutes, i) => {
    const last = i === xAxis.ticks.length - 1;
    g.textAlign = i === 0 ? "left" : last ? "right" : "center";
    g.fillText(
      last ? `${minutes} min` : String(minutes),
      X(minutes * 60),
      Hh - 6,
    );
  });
  g.textAlign = "left";
  return { g, col, X, Y, L, R, W, Tp };
}

// A plot's fitted line from (x0, y0) to (x1, y1), thin and in the fast dots' blue so it reads apart from the grid,
// with its label top right.
function plotLine(frame, x0, y0, x1, y1, label) {
  const { g, col, X, Y, W, R, Tp } = frame;
  g.strokeStyle = col("--fast");
  g.lineWidth = 1.25;
  g.beginPath();
  g.moveTo(X(x0), Y(y0));
  g.lineTo(X(x1), Y(y1));
  g.stroke();
  g.lineWidth = 1;
  g.fillStyle = col("--fast");
  g.textAlign = "right";
  g.fillText(label, W - R, 12);
  g.textAlign = "left";
}

function drawServer(ref) {
  if (!run.ref.length) return;
  // This computer's clock against the server's, from the line's value at the start (or the first sample's, before
  // there is a line). The line starts at 0, and a slow computer clock falls below it.
  const baseline = ref
    ? T.refOffsetAt(ref, run.t0)
    : T.sampleOffset(run.ref[0]);
  const pts = run.ref.map((s) => ({
    x: (s.tb + s.ta) / 2 - run.t0,
    y: (baseline - T.sampleOffset(s)) * 1e3,
  }));
  const fast = new Set(
    [run.startBurst, run.midBurst ?? [], run.endBurst, ...run.probes].flatMap(
      (b) => T.fastest(b, 0.2, b.length < 10 ? 1 : 5),
    ),
  );
  const ys = pts.map((p) => p.y).sort((a, b) => a - b);
  // slow requests trail below the line: the range leaves out the lowest 10 %
  let lo = Math.min(-2, ys[Math.floor(ys.length * 0.1)]),
    hi = Math.max(2, ys[Math.floor(ys.length * 0.98)]);
  const xmax = Math.max(run.minutes * 60, ...pts.map((p) => p.x));
  // the line runs up to the latest request, not ahead of the data
  const xEnd = Math.max(...pts.map((p) => p.x));
  const lineEnd = ref ? -ref.k * xEnd * 1e3 : 0;
  lo = Math.min(lo, lineEnd - 1);
  hi = Math.max(hi, lineEnd + 1);
  const frame = plotFrame("plot", xmax, lo, hi);
  const { g, col, X, Y } = frame;
  run.ref.forEach((s, i) => {
    const p = pts[i];
    if (p.y < lo || p.y > hi) return;
    g.fillStyle = fast.has(s) ? col("--fast") : col("--dot");
    g.beginPath();
    g.arc(X(p.x), Y(p.y), fast.has(s) ? 2.6 : 1.6, 0, 7);
    g.fill();
  });
  if (ref)
    plotLine(
      frame,
      0,
      0,
      xEnd,
      lineEnd,
      `line: computer clock ${fmt(-ref.k * 1e6, 1)} ppm vs. internet time`,
    );
}

// The device's clock against this computer's: each read's ticks as time, from the first read. The line's slope is
// the crystal against this computer's clock, and the spread around it is the read scatter.
function drawDevice(fit) {
  if (!$("devplot") || run.t.length < 2) return;
  const pts = run.t.map((t, i) => {
    const x = t - run.t[0];
    return {
      x: t - run.t0,
      y: ((run.c[i] - run.c[0]) / run.nominal - x) * 1e3,
      fromFirst: x,
    };
  });
  const slope = fit ? fit.f / run.nominal - 1 : 0; // the device's clock against this computer's
  const intercept = fit
    ? T.median(pts.map((p) => p.y - slope * p.fromFirst * 1e3))
    : 0;
  const lineAt = (x) => intercept + slope * (x - (run.t[0] - run.t0)) * 1e3;
  const ys = pts.map((p) => p.y).sort((a, b) => a - b);
  const xmax = Math.max(run.minutes * 60, ...pts.map((p) => p.x));
  let lo = Math.min(-1, ys[Math.floor(ys.length * 0.01)]),
    hi = Math.max(1, ys[Math.floor(ys.length * 0.99)]);
  // the line runs from the first read to the latest, not ahead of the data
  const xStart = pts[0].x,
    xEnd = pts[pts.length - 1].x;
  lo = Math.min(lo, lineAt(xStart) - 0.5, lineAt(xEnd) - 0.5);
  hi = Math.max(hi, lineAt(xStart) + 0.5, lineAt(xEnd) + 0.5);
  const frame = plotFrame("devplot", xmax, lo, hi);
  const { g, col, X, Y } = frame;
  g.fillStyle = col("--dot");
  for (const p of pts) {
    if (p.y < lo || p.y > hi) continue;
    g.beginPath();
    g.arc(X(p.x), Y(p.y), 1.8, 0, 7);
    g.fill();
  }
  if (fit) {
    const device = run.device ?? "device";
    plotLine(
      frame,
      xStart,
      lineAt(xStart),
      xEnd,
      lineAt(xEnd),
      `line: ${device} ${fmt(fit.ppm, 1)} ppm vs. this computer`,
    );
  }
}
