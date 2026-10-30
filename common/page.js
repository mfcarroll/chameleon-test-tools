// Small helpers every tool page uses: the page's elements, its log, and sleeping that survives a hidden tab.

export const $ = (id) => document.getElementById(id);
export const nowS = () => (performance.timeOrigin + performance.now()) / 1000;
export const fmt = (v, d = 2) => (v >= 0 ? "+" : "") + v.toFixed(d);

// "+16.2 ± 0.7 ppm". Both numbers go to the ±'s first significant digit, or to its first two when that digit is
// 1, and never finer than 0.1 ppm.
export function fmtPm(value, sig) {
  let decimals = 1;
  if (sig > 0) {
    const exponent = Math.floor(Math.log10(sig));
    decimals = Math.max(
      0,
      Math.min(1, -exponent + (sig / 10 ** exponent < 2 ? 1 : 0)),
    );
  }
  return `${fmt(value, decimals)} ± ${sig.toFixed(decimals)} ppm`;
}

export function log(msg) {
  const el = $("log");
  el.textContent += `${new Date().toISOString().slice(11, 19)}  ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

// Sleep in a worker: a hidden tab throttles its own timers to once a minute, a worker's are not.
const worker = new Worker(
  URL.createObjectURL(
    new Blob(
      [
        "onmessage = (e) => setTimeout(() => postMessage(e.data.id), e.data.ms);",
      ],
      {
        type: "text/javascript",
      },
    ),
  ),
);
const sleepers = new Map();
let sleepId = 0;
worker.onmessage = (e) => {
  sleepers.get(e.data)?.();
  sleepers.delete(e.data);
};
export const sleep = (s) =>
  new Promise((r) => {
    const id = ++sleepId;
    sleepers.set(id, r);
    worker.postMessage({ id, ms: Math.max(0, s * 1000) });
  });

export function saveJson(name, data) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }),
  );
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function hasWebSerial() {
  if ("serial" in navigator) return true;
  log("This browser has no Web Serial. Use Chrome or Edge on a computer.");
  return false;
}

// Tabs: buttons with role="tab" and aria-controls naming their panel. Arrow keys move between them.
export function bindTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !on;
    }
  };
  tabs.forEach((tab, i) => {
    tab.onclick = () => select(tab);
    tab.onkeydown = (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      const next = tabs[(i + step + tabs.length) % tabs.length];
      select(next);
      next.focus();
    };
  });
  if (tabs.length) select(tabs[0]);
}

// Copy buttons: each copies the text of the element just before it.
export function bindCopyButtons() {
  for (const button of document.querySelectorAll("button.copy")) {
    button.onclick = async () => {
      try {
        await navigator.clipboard.writeText(
          button.previousElementSibling.textContent,
        );
        button.textContent = "Copied";
      } catch {
        // no clipboard access: select the text so a copy shortcut finishes the job
        getSelection().selectAllChildren(button.previousElementSibling);
        button.textContent = "Selected";
      }
      setTimeout(() => (button.textContent = "Copy"), 1500);
    };
  }
}
