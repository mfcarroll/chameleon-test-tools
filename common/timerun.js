// A crystal measurement against a time server, and the page sections that show it (Progress, Result, the plot).
// Shared by the Chameleon Ultra and Flipper crystal pages; the device comes in as { start, read, stop }, each
// read being { tb, ta, ticks } (ticks bracketed by local times before and after).
//
// The reference is an HTTPS time server (time.akamai.com/?ms: millisecond stamps, open to any page). Its requests
// come in dense bursts at the start and end, because for a straight-line rate the points belong at the ends, and
// only each burst's fastest round trips are kept. A third burst halfway checks the network path didn't change;
// small probes between them feed the running estimate and the plot. The local clock is
// performance.timeOrigin + performance.now(): monotonic and never slewed, so a straight line describes it.

import * as T from "./timefit.js";
import { $, nowS, fmt, log, sleep, saveJson } from "./page.js";

const REF_URL = "https://time.akamai.com/?ms";
const READ_INTERVAL = 2.0; // s between device reads
const BURST_GAP = 0.25; // s between requests inside a burst
const PROBE_EVERY = 60; // s between probes
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
  for (const id of ["result", "host", "rms", "bounds", "prov"]) $(id).textContent = "–";
  $("result").className = "big";
  return run;
}

async function refSample(phase) {
  const tb = nowS();
  const r = await fetch(REF_URL, { cache: "no-store" });
  const body = await r.text();
  const ta = nowS();
  const srv = Number(body);
  if (!r.ok || !isFinite(srv)) throw new Error(`time server returned ${r.status} "${body.slice(0, 40)}"`);
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
        while (!run.aborted && !run.finishNow && nowS() < Math.min(t, tp + PROBE_EVERY)) await sleep(1);
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

function provisional() {
  if (run.t.length < 10 || !run.probes.length) return;
  const ref = T.refFit([run.startBurst, ...run.probes.map((p) => T.fastest(p, 0, 1))]);
  if (!ref) return;
  run.estimate = T.combine(T.rateFit(run.t, run.c, run.nominal), ref, run.nominal);
  $("prov").textContent = `${fmt(run.estimate.ppm)} ppm`;
  draw(ref);
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
  const hc = run.midBurst ? T.halvesCheck(run.startBurst, run.midBurst, run.endBurst) : null;
  const bc = T.boundCheck(ref, run.ref);
  $("phase").textContent = "done";
  $("result").textContent = `${fmt(r.ppm)} ppm ± ${r.sig.toFixed(2)}`;
  $("resultnote").textContent =
    `The crystal's offset, + meaning fast: ${(ref.span / 60).toFixed(1)} min against time.akamai.com, ${fit.n} reads.`;
  $("host").textContent = `${fmt(-r.hostPpm)} ppm`;
  $("rms").textContent = `${(fit.rmsUs / 1000).toFixed(2)} ms`;
  // The computer's clock stops while it sleeps and the device keeps counting: the reads then sit on two lines.
  // USB jitter is about 1 ms rms, so 20 ms is unmistakable.
  if (fit.rmsUs > 20000) {
    log(`⚠ reads scatter ${(fit.rmsUs / 1000).toFixed(0)} ms rms around the fit: did the computer sleep? Rejected.`);
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
  $("result").className = "big " + (suspect ? "bad" : !hc || run.hidden.length ? "warn" : "ok");
  log(
    `RESULT ${fmt(r.ppm, 3)} ppm ± ${r.sig.toFixed(3)} (uncorrected ${fmt(r.uncorrected, 3)}, host clock ${fmt(-r.hostPpm, 3)} ppm vs server)`,
  );
  log(`  ref fit: ${ref.n} samples, rms ${ref.rmsMs.toFixed(2)} ms; read fit rms ${(fit.rmsUs / 1000).toFixed(2)} ms, dropped ${fit.dropped}`);
  if (hc)
    log(
      `  halves: host clock ${fmt(hc.first, 3)} then ${fmt(hc.second, 3)} ppm, diff ${fmt(hc.diff, 3)} ± ${hc.sig.toFixed(3)}: ${hc.ok ? "ok" : "PATH CHANGED"}`,
    );
  log(`  bound check: ${bc.violations}/${bc.of} samples violate (worst ${bc.worstMs.toFixed(2)} ms)`);
  if (suspect) log("  ⚠ the path to the time server changed during the run: treat this result as suspect and re-run");
  if (run.hidden.length) log(`  ⚠ the tab was hidden ${run.hidden.length}x during the run; check the read count looks right`);
  draw(ref);
  run.result = { ...r, fit, ref, halves: hc, bounds: bc, hidden: run.hidden, suspect: suspect || !hc };
  return run.result;
}

function update() {
  if (!run) return;
  $("elapsed").textContent = `${((nowS() - run.t0) / 60).toFixed(1)} / ${run.minutes} min`;
  $("reads").textContent = String(run.reads.length);
  $("refn").textContent = String(run.ref.length);
  const rt = run.ref.map(T.sampleRtt);
  if (rt.length) $("minrtt").textContent = `${(Math.min(...rt) * 1e3).toFixed(1)} ms`;
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
      log("tab hidden: timers keep running in a worker, but keep it visible if you can");
    }
  });
}

// ---------------------------------------------------------------- plot

function draw(ref) {
  const cv = $("plot"),
    dpr = devicePixelRatio || 1;
  const W = cv.clientWidth,
    Hh = cv.clientHeight;
  cv.width = W * dpr;
  cv.height = Hh * dpr;
  const g = cv.getContext("2d");
  g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const pts = run.ref.map((s) => ({
    x: (s.tb + s.ta) / 2 - run.t0,
    y: (T.sampleOffset(s) - (ref ? T.refOffsetAt(ref, (s.tb + s.ta) / 2) : 0)) * 1e3,
  }));
  if (!pts.length) return;
  const fast = new Set(
    [run.startBurst, run.midBurst ?? [], run.endBurst, ...run.probes].flatMap((b) =>
      T.fastest(b, 0.2, b.length < 10 ? 1 : 5),
    ),
  );
  const ys = pts.map((p) => p.y).sort((a, b) => a - b);
  const lo = Math.min(-2, ys[Math.floor(ys.length * 0.02)]),
    hi = Math.max(2, ys[Math.floor(ys.length * 0.9)]);
  const xmax = Math.max(run.minutes * 60, ...pts.map((p) => p.x));
  const L = 44,
    R = 8,
    Tp = 8,
    B = 22;
  const X = (x) => L + (x / xmax) * (W - L - R),
    Y = (y) => Tp + (1 - (y - lo) / (hi - lo)) * (Hh - Tp - B);
  g.font = "11px -apple-system, sans-serif";
  g.fillStyle = col("--muted");
  g.strokeStyle = col("--line");
  for (let i = 0; i <= 4; i++) {
    const y = lo + ((hi - lo) * i) / 4;
    g.beginPath();
    g.moveTo(L, Y(y));
    g.lineTo(W - R, Y(y));
    g.stroke();
    g.fillText(`${y.toFixed(1)} ms`, 2, Y(y) + 4);
  }
  g.fillText("0", L, Hh - 6);
  g.fillText(`${(xmax / 60).toFixed(0)} min`, W - R - 36, Hh - 6);
  run.ref.forEach((s, i) => {
    const p = pts[i];
    if (p.y < lo || p.y > hi) return;
    g.fillStyle = fast.has(s) ? col("--fast") : col("--dot");
    g.beginPath();
    g.arc(X(p.x), Y(p.y), fast.has(s) ? 2.6 : 1.6, 0, 7);
    g.fill();
  });
  if (ref) {
    g.strokeStyle = col("--text");
    g.beginPath();
    g.moveTo(L, Y(0));
    g.lineTo(W - R, Y(0));
    g.stroke();
  }
}
