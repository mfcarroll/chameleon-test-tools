// A crystal measurement against a time server, and the page sections that show it (Progress, Result, the plot).
// Shared by the crystal pages. The device comes in as { start, read, stop }, each
// read being { tb, ta, ticks } (ticks bracketed by local times before and after).
//
// The reference is two HTTPS time servers with millisecond stamps, open to any page: time.akamai.com/?ms and
// time.mfc.cx (a Cloudflare Worker, ../timeserver/). Requests alternate between the two servers. Most come in dense
// bursts at the start and end of the run, because points at the ends fix a straight-line rate best. The fits keep
// only each burst's fastest round trips. A third burst halfway checks that the network paths didn't change, and the
// two servers check each other. Small probes between the bursts feed the running estimate and the plot.
// The local clock is performance.timeOrigin + performance.now(). It is monotonic and never slewed, and a straight
// line describes it.

import * as T from "./timefit.js";
import { $, nowS, fmt, fmtPm, log, sleep, saveJson } from "./page.js";

// Both reply with Unix seconds to the millisecond. A sample's src is its index here.
const REFS = [
  { name: "Akamai", url: "https://time.akamai.com/?ms" },
  { name: "Cloudflare", url: "https://time.mfc.cx/" },
];
const READ_INTERVAL = 2.0; // s between device reads
const BURST_GAP = 0.25; // s between requests inside a burst
const PROBE_EVERY = 60; // s between probes, unless the run sets probeEvery
const SETTLED_SIG = 5; // ppm: the running estimate shows once its ± is under this
const PROBE_N = 5; // requests per server in a probe; the fastest is the probe's point

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
    servers: REFS.map((r) => r.name),
    sources: REFS.map((_, i) => i), // the servers still in use
    failing: {}, // servers whose last request failed
    t0: nowS(),
  };
  for (const id of ["result", "devrate", "host", "rms", "bounds", "prov"])
    $(id).textContent = "–";
  $("result").className = "big";
  return run;
}

async function refSample(phase, src) {
  const tb = nowS();
  const r = await fetch(REFS[src].url, { cache: "no-store" });
  const body = await r.text();
  const ta = nowS();
  const srv = Number(body);
  if (!r.ok || !isFinite(srv))
    throw new Error(
      `${REFS[src].name} returned ${r.status} "${body.slice(0, 40)}"`,
    );
  const s = { tb, ta, srv, phase, src };
  run.ref.push(s);
  return s;
}

// One sample from each server in use. A failed request counts in `failed` and gets no sample.
// The log notes when a server stops answering, with the error, and when it answers again.
async function refRound(phase, out, failed) {
  for (const src of run.sources) {
    try {
      out.push(await refSample(phase, src));
      if (run.failing[src]) log(`${REFS[src].name} answering again`);
      run.failing[src] = false;
    } catch (e) {
      failed[src] = (failed[src] ?? 0) + 1;
      if (!run.failing[src])
        log(`${REFS[src].name} not answering: ${e.message}`);
      run.failing[src] = true;
    }
  }
}

const of = (samples, src) => samples.filter((s) => s.src === src);

async function burst(phase, n) {
  $("phase").textContent = `${phase} burst`;
  log(`${phase} burst: ${n} requests to each time server`);
  const out = [],
    failed = {};
  // warm the connections (TLS); not counted
  await Promise.all(
    run.sources.map((src) =>
      fetch(REFS[src].url, { cache: "no-store" })
        .then((r) => r.text())
        .catch(() => {}),
    ),
  );
  for (let i = 0; i < n && !run.aborted; i++) {
    const t = nowS();
    await refRound(phase, out, failed);
    update();
    await sleep(BURST_GAP - (nowS() - t));
  }
  for (const src of run.sources) {
    const rtts = of(out, src)
      .map(T.sampleRtt)
      .sort((a, b) => a - b);
    log(
      `  ${REFS[src].name}: ${rtts.length} samples` +
        (rtts.length
          ? `, round trip fastest ${(rtts[0] * 1e3).toFixed(1)} ms, median ${(rtts[rtts.length >> 1] * 1e3).toFixed(1)} ms`
          : "") +
        (failed[src] ? `, ${failed[src]} failed` : ""),
    );
  }
  // A server that fails half the start burst is left out of the rest of the run.
  if (phase === "start") {
    const kept = run.sources.filter((src) => of(out, src).length >= n / 2);
    for (const src of run.sources)
      if (!kept.includes(src))
        log(`  ${REFS[src].name} left out: too many requests failed`);
    run.sources = kept;
  }
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
    // bursts centre on 0, the halfway point and the end, and each starts half a burst early
    const bt = n * (BURST_GAP + 0.04 * run.sources.length);
    const probesUntil = async (t) => {
      while (!run.aborted && !run.finishNow && nowS() < t) {
        $("phase").textContent = "measuring";
        const tp = nowS();
        const probe = [];
        for (let i = 0; i < PROBE_N; i++) {
          await refRound("probe", probe, {});
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
    if (!run.sources.length) throw new Error("no time server answered");
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
  const fits = REFS.map((_, src) =>
    run.sources.includes(src) && run.probes.length
      ? T.refFit([
          of(run.startBurst, src),
          ...run.probes.map((p) => T.fastest(of(p, src), 0, 1)),
        ])
      : null,
  );
  const ref = T.meanRef(fits);
  const fit = run.t.length >= 3 ? T.rateFit(run.t, run.c, run.nominal) : null;
  run.plotted = { fits, ref, fit };
  drawServer(fits, ref);
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
}

// Returns the result, with .suspect when a check failed, or null when the fits can't be trusted at all.
function finalResult() {
  const fit = T.rateFit(run.t, run.c, run.nominal);
  const fits = REFS.map((_, src) =>
    run.sources.includes(src)
      ? T.refFit([of(run.startBurst, src), of(run.endBurst, src)])
      : null,
  );
  const ref = T.meanRef(fits);
  if (!ref) {
    log("not enough time-server samples to fit");
    return null;
  }
  const r = T.combine(fit, ref, run.nominal);
  // each server on its own: the result against it, its halves and its bound check
  const per = REFS.map((server, src) => {
    if (!fits[src]) return null;
    const hc = run.midBurst
      ? T.halvesCheck(
          of(run.startBurst, src),
          of(run.midBurst, src),
          of(run.endBurst, src),
          run.t,
          run.c,
          run.nominal,
        )
      : null;
    return {
      name: server.name,
      ...T.combine(fit, fits[src], run.nominal),
      ref: fits[src],
      halves: hc,
      bounds: T.boundCheck(fits[src], of(run.ref, src)),
    };
  });
  const used = per.filter(Boolean);
  const sc =
    used.length === 2 ? T.sourcesCheck(used[0].ref, used[1].ref) : null;
  // a run without its halfway burst finished early. A server that missed that burst only loses its own halves check.
  const unchecked = !run.midBurst || used.every((p) => !p.halves);
  const pathChanged = used.filter((p) => p.halves && !p.halves.ok);
  const offLine = used.filter((p) => p.bounds.violations);
  $("phase").textContent = "done";
  $("result").textContent = fmtPm(r.ppm, r.sig);
  // the result supersedes the running estimate, which never saw the end burst
  $("prov").textContent = fmtPm(r.ppm, r.sig);
  $("resultnote").textContent =
    `The crystal's offset, + meaning fast: ${(ref.span / 60).toFixed(1)} min against ${used.map((p) => p.name).join(" and ")}, ${fit.n} reads.`;
  $("devrate").textContent = `${fmt(r.uncorrected, 1)} ppm`;
  $("host").textContent = `${fmt(-r.hostPpm, 1)} ppm`;
  $("rms").textContent = `${(fit.rmsUs / 1000).toFixed(2)} ms`;
  // While the computer sleeps, its clock stops and the device keeps counting. The reads then sit on two lines, and
  // their scatter grows far beyond USB jitter (about 1 ms rms). A scatter over 20 ms means the computer slept.
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
  const suspect =
    pathChanged.length > 0 || (sc && !sc.ok) || offLine.length > 0;
  $("bounds").innerHTML = unchecked
    ? `<span class="warn">not checked: ${run.midBurst ? "no time server answered the halfway burst" : "the run finished early"}</span>`
    : pathChanged.length
      ? `<span class="bad">failed: the network path to ${pathChanged.map((p) => p.name).join(" and ")} changed during the run, so the result may be off</span>`
      : sc && !sc.ok
        ? `<span class="bad">failed: the two time servers disagree, so the result may be off</span>`
        : offLine.length
          ? `<span class="bad">failed: some time-server samples are far off the line</span>`
          : sc
            ? `<span class="ok">passed: both time servers agree${used.every((p) => p.halves) ? " and their paths stayed the same" : ""}</span>`
            : `<span class="warn">passed with one time server: the network path stayed the same</span>`;
  $("result").className =
    "big " +
    (suspect ? "bad" : unchecked || !sc || run.hidden.length ? "warn" : "ok");
  log(
    `RESULT ${fmt(r.ppm, 3)} ppm ± ${r.sig.toFixed(3)} (uncorrected ${fmt(r.uncorrected, 3)}, host clock ${fmt(-r.hostPpm, 3)} ppm vs the servers)`,
  );
  log(
    `  read fit rms ${(fit.rmsUs / 1000).toFixed(2)} ms, dropped ${fit.dropped}`,
  );
  for (const p of used) {
    log(
      `  ${p.name}: ${fmt(p.ppm, 3)} ± ${p.sig.toFixed(3)} ppm, host clock ${fmt(-p.hostPpm, 3)}; ref fit ${p.ref.n} samples, rms ${p.ref.rmsMs.toFixed(2)} ms`,
    );
    if (!p.halves)
      log("    halves: not checked (no samples in the halfway burst)");
    else
      log(
        `    halves: crystal ${fmt(p.halves.first, 3)} then ${fmt(p.halves.second, 3)} ppm, diff ${fmt(p.halves.diff, 3)} ± ${p.halves.sig.toFixed(3)} (host clock ${fmt(p.halves.hostFirst, 3)} then ${fmt(p.halves.hostSecond, 3)}): ${p.halves.ok ? "ok" : "PATH CHANGED"}`,
      );
    log(
      `    bound check: ${p.bounds.violations}/${p.bounds.of} samples violate (worst ${p.bounds.worstMs.toFixed(2)} ms)`,
    );
  }
  if (sc)
    log(
      `  servers: ${used[1].name} minus ${used[0].name} ${fmt(sc.diff, 3)} ± ${sc.sig.toFixed(3)} ppm: ${sc.ok ? "ok" : "DISAGREE"}`,
    );
  else
    log(
      "  ⚠ only one time server answered, so the servers didn't check each other",
    );
  if (suspect)
    log(
      "  ⚠ a network path changed or the servers disagree: treat this result as suspect and re-run",
    );
  if (run.hidden.length)
    log(
      `  ⚠ the tab was hidden ${run.hidden.length}x during the run; check the read count looks right`,
    );
  run.plotted = { fits, ref, fit };
  drawServer(fits, ref);
  drawDevice(fit);
  run.result = {
    ...r,
    fit,
    ref,
    servers: used,
    sources: sc,
    hidden: run.hidden,
    suspect: suspect || unchecked,
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
  bindPlotZoom();
}

const ICON = (path) =>
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;

// Each plot gets an Enlarge button. The button moves the plot's canvas into a full-window dialog, where a running
// measurement keeps drawing into it, and closing the dialog moves the canvas back.
function bindPlotZoom() {
  const dialog = document.createElement("dialog");
  dialog.className = "plotzoom";
  dialog.innerHTML = `<div class="plothead"><h3></h3><button type="button" class="iconbtn" aria-label="Close">${ICON("M18 6 6 18M6 6l12 12")}</button></div>`;
  document.body.append(dialog);
  const title = dialog.querySelector("h3");
  let home = null; // where the enlarged canvas came from
  dialog.querySelector("button").onclick = () => dialog.close();
  dialog.addEventListener("close", () => {
    home.figure.insertBefore(home.canvas, home.next);
    home = null;
    removeEventListener("resize", redrawPlots);
    redrawPlots();
  });
  for (const figure of document.querySelectorAll("figure")) {
    const canvas = figure.querySelector("canvas"),
      h3 = figure.querySelector("h3");
    if (!canvas || !h3) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "iconbtn";
    button.title = "Enlarge";
    button.setAttribute("aria-label", `Enlarge the plot: ${h3.textContent}`);
    button.innerHTML = ICON("M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7");
    const head = document.createElement("div");
    head.className = "plothead";
    h3.replaceWith(head);
    head.append(h3, button);
    button.onclick = () => {
      home = { figure, canvas, next: canvas.nextSibling };
      title.textContent = h3.textContent;
      dialog.append(canvas);
      dialog.showModal();
      addEventListener("resize", redrawPlots);
      redrawPlots();
    };
  }
}

// ---------------------------------------------------------------- plot

// Draws the plots again from the last fits. A canvas that isn't displayed has no size to draw at, and a page calls
// this after showing plots that were hidden.
export function redrawPlots() {
  if (!run?.plotted) return;
  drawServer(run.plotted.fits, run.plotted.ref);
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
  // a margin above and below the data keeps points off the plot's edge
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
  // Tp leaves a strip at the top for the line's label. An enlarged plot gets larger text.
  const big = !!cv.closest("dialog"),
    L = big ? 54 : 44,
    R = 8,
    Tp = big ? 24 : 20,
    B = big ? 26 : 22;
  const X = (x) => L + (x / xmax) * (W - L - R),
    Y = (y) => Tp + (1 - (y - lo) / (hi - lo)) * (Hh - Tp - B);
  g.font = `${big ? 13 : 11}px -apple-system, sans-serif`;
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
  // about one minute label per 60 px keeps the labels apart
  const xAxis = niceTicks(
    0,
    xmax / 60,
    Math.max(3, Math.min(6, Math.floor((W - L - R) / 60))),
  );
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
  g.fillText(label, W - R, Tp - 8);
  g.textAlign = "left";
}

function drawServer(fits, ref) {
  if (!run.ref.length) return;
  // Plots this computer's clock against each server's. The servers' constant offsets differ by a millisecond or
  // two. Each server's points start at 0, measured from that server's line at the start, or from its first sample
  // before there is a line. The line has the mean slope, and a slow computer clock falls below it.
  const baseline = REFS.map((_, src) => {
    const first = run.ref.find((s) => s.src === src);
    return fits[src]
      ? T.refOffsetAt(fits[src], run.t0)
      : first
        ? T.sampleOffset(first)
        : 0;
  });
  const pts = run.ref.map((s) => ({
    x: (s.tb + s.ta) / 2 - run.t0,
    y: (baseline[s.src] - T.sampleOffset(s)) * 1e3,
  }));
  const fast = new Set(
    [run.startBurst, run.midBurst ?? [], run.endBurst, ...run.probes].flatMap(
      (b) =>
        REFS.flatMap((_, src) => {
          const g = of(b, src);
          return T.fastest(g, 0.2, g.length < 10 ? 1 : 5);
        }),
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
  const fastColor = [col("--fast"), col("--fast2")];
  run.ref.forEach((s, i) => {
    const p = pts[i];
    if (p.y < lo || p.y > hi) return;
    g.fillStyle = fast.has(s) ? fastColor[s.src] : col("--dot");
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
