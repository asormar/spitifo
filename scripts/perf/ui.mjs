#!/usr/bin/env node
// Measures the running app's UI through the Chrome DevTools Protocol: start-up,
// view switches, tap feedback and frame rate while scrolling the library.
//
//   node scripts/perf/ui.mjs --launch <Spitifo.exe> [--runs 10] [--json]
//   node scripts/perf/ui.mjs --adb [<path to adb>] [--runs 10] [--json]
//   node scripts/perf/ui.mjs --endpoint http://127.0.0.1:9222 [--touch]
//
// Windows: --launch starts the installed Spitifo.exe with WebView2's remote
// debugging port open (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS), so launch to
// usable is measured from the spawn. Android: --adb force-stops and starts
// dev.spitifo, reads the launch time from logcat, forwards the WebView's
// DevTools socket and uses touch input. It needs a build made with
// -Pspitifo.inspectable=true (docs/performance.md). --endpoint attaches to a
// page that is already running.
//
// Every timing is taken inside the page:
// - "usable" is when /api/library has answered and its response has been
//   rendered (the frame after the library button shows the count), measured
//   from the page's time origin and, with a launch time, from the launch;
// - a tap or a view switch is measured from the input event's timestamp to the
//   end of the first frame produced after it (requestAnimationFrame, then a
//   task), which is when the change is on its way to the screen;
// - frame intervals come from requestAnimationFrame while the library scrolls
//   and while the drawer animates.
// Node 22+ (built-in WebSocket), no dependencies.

import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const args = parseArgs(process.argv.slice(2));
const adb = args.adb ? (args.adb === true ? "adb" : args.adb) : null;
const endpoint = args.endpoint ?? (adb ? "http://127.0.0.1:9333" : "http://127.0.0.1:9222");
const runs = Number(args.runs ?? 10);
const touch = Boolean(args.touch) || Boolean(adb);
const PACKAGE = "dev.spitifo";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    };
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  async eval(fn, ...fnArgs) {
    const expression = `(${fn})(...${JSON.stringify(fnArgs)})`;
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  close() {
    this.ws.close();
  }
}

/** Polls the DevTools endpoint until the app page (not the splash) is there. */
async function findPage(deadline) {
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`${endpoint}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url));
      if (page) return page;
    } catch {
      // Not listening yet.
    }
    await sleep(50);
  }
  throw new Error(`no app page on ${endpoint}`);
}

// ------------------------------------------------------------ page helpers
// These run inside the page; they cannot close over anything here.

/** Waits for the library to be rendered and reports the start-up timings. */
function pageStartup() {
  const lib = () => performance.getEntriesByType("resource").find((e) => e.name.includes("/api/library"));
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
  return new Promise((resolve) => {
    const check = async () => {
      const entry = lib();
      const btn = document.querySelector("button.libbtn");
      if (!entry || document.readyState !== "complete" || !btn) return setTimeout(check, 10);
      await frame();
      const nav = performance.getEntriesByType("navigation")[0];
      const fcp = performance.getEntriesByName("first-contentful-paint")[0];
      resolve({
        timeOrigin: performance.timeOrigin,
        domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? 0),
        load: Math.round(nav?.loadEventEnd ?? 0),
        fcp: Math.round(fcp?.startTime ?? 0),
        libraryRequestStart: Math.round(entry.startTime),
        libraryResponseEnd: Math.round(entry.responseEnd),
        // The drawer is not rendered until it is first opened, so painting the
        // answer (the count on the library button) takes one more frame.
        usable: Math.round(Math.max(entry.responseEnd, fcp?.startTime ?? 0)),
        libraryCount: btn.getAttribute("aria-label"),
        tracks: document.querySelectorAll(".drawer .panel__body > *").length,
      });
    };
    check();
  });
}

/** Arms a one-shot probe: input timestamp -> end of the next produced frame. */
function pageArm(type, selector, settle) {
  window.__perf = new Promise((resolve) => {
    const el = document.querySelector(selector);
    const onInput = (e) => {
      const t0 = e.timeStamp;
      requestAnimationFrame(() =>
        setTimeout(() => {
          const frame = performance.now() - t0;
          if (!settle) return resolve({ frame });
          // How long the open/close transition takes to finish, and its frames.
          const drawer = document.querySelector(".drawer");
          const stamps = [];
          let done = false;
          const tick = (ts) => {
            stamps.push(ts);
            if (!done) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          const end = (ev) => {
            if (ev && (ev.target !== drawer || ev.propertyName !== "grid-template-rows")) return;
            done = true;
            drawer.removeEventListener("transitionend", end);
            const gaps = stamps.slice(1).map((s, i) => s - stamps[i]);
            resolve({ frame, settled: performance.now() - t0, longestFrame: Math.max(0, ...gaps) });
          };
          drawer.addEventListener("transitionend", end);
          setTimeout(() => end(), 2000);
        })
      );
    };
    el.addEventListener(type, onInput, { once: true, capture: true });
  });
  const r = document.querySelector(selector).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Records requestAnimationFrame intervals until stopped. */
function pageFramesStart() {
  const run = (window.__framesRun = (window.__framesRun ?? 0) + 1);
  window.__frames = [];
  const tick = (ts) => {
    if (window.__framesRun !== run) return;
    window.__frames.push(ts);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function pageFramesStop() {
  window.__framesRun += 1;
  const s = window.__frames;
  const gaps = s.slice(1).map((v, i) => v - s[i]).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? 0;
  const total = s.length > 1 ? s[s.length - 1] - s[0] : 0;
  return {
    frames: s.length,
    durationMs: Math.round(total),
    fps: total ? Math.round(((s.length - 1) * 1000) / total * 10) / 10 : 0,
    refreshMs: Math.round(median * 100) / 100,
    p95Ms: Math.round((gaps[Math.floor(gaps.length * 0.95)] ?? 0) * 10) / 10,
    longestMs: Math.round((gaps[gaps.length - 1] ?? 0) * 10) / 10,
    // A frame "dropped" when its interval is over 1.5 refreshes.
    droppedPct: gaps.length ? Math.round((gaps.filter((g) => g > median * 1.5).length / gaps.length) * 1000) / 10 : 0,
  };
}

// ------------------------------------------------------------------ input

async function tapAt(cdp, { x, y }) {
  if (touch) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }
}

/** Taps `selector` and returns the probe's result for `type`. */
async function probe(cdp, selector, type, settle = false) {
  const point = await cdp.eval(pageArm, type, selector, settle);
  await tapAt(cdp, point);
  return cdp.eval(() => window.__perf);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.floor(s.length / 2)] * 10) / 10 : null;
};
const max = (xs) => (xs.length ? Math.round(Math.max(...xs) * 10) / 10 : null);

/** Cold-starts the app on the phone; returns the launch time (device clock). */
async function launchOnPhone() {
  const run = (...a) => execFileSync(adb, a, { encoding: "utf8" });
  run("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  run("shell", "am", "force-stop", PACKAGE);
  await sleep(2000);
  run("logcat", "-c");
  run("shell", "am", "start", "-W", "-n", `${PACKAGE}/.MainActivity`);
  // ActivityTaskManager logs the START with the device's wall clock, the same
  // clock as performance.timeOrigin in the WebView.
  let launchedAt = null;
  let pid = "";
  for (let i = 0; i < 100 && (!launchedAt || !pid); i++) {
    const log = run("logcat", "-d", "-v", "epoch", "-s", "ActivityTaskManager:I");
    const line = log.split("\n").find((l) => l.includes("START u0") && l.includes(PACKAGE));
    if (line) launchedAt = Math.round(parseFloat(line.trim().split(/\s+/)[0]) * 1000);
    pid = run("shell", "pidof", PACKAGE).trim();
    if (!launchedAt || !pid) await sleep(100);
  }
  if (!launchedAt || !pid) throw new Error("the app did not start");
  const port = new URL(endpoint).port;
  // The socket appears once the WebView exists, after the backend is up.
  for (let i = 0; i < 300; i++) {
    const sockets = run("shell", "cat", "/proc/net/unix");
    if (sockets.includes(`webview_devtools_remote_${pid}`)) break;
    await sleep(50);
  }
  run("forward", `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
  return launchedAt;
}

async function main() {
  let launchedAt = args["launched-at"] ? Number(args["launched-at"]) : null;
  let child = null;
  if (adb) launchedAt = await launchOnPhone();
  if (args.launch) {
    const port = new URL(endpoint).port || "9222";
    launchedAt = Date.now();
    child = spawn(args.launch, [], {
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
      stdio: "ignore",
      detached: false,
    });
  }

  const page = await findPage(Date.now() + 90_000);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  const result = { page: page.url.replace(/token=[^&]+/, "token=…") };

  // The first load is /?token=…, which the backend redirects to a clean URL:
  // retry while that navigation has no page to evaluate in.
  let s;
  for (let tries = 0; !s; tries++) {
    try {
      s = await cdp.eval(pageStartup);
    } catch (e) {
      if (tries > 100) throw e;
      await sleep(20);
    }
  }
  result.startup = {
    ...s,
    launchToNavigation: launchedAt ? Math.round(s.timeOrigin - launchedAt) : null,
    launchToUsable: launchedAt ? Math.round(s.timeOrigin + s.usable - launchedAt) : null,
  };
  delete result.startup.timeOrigin;
  await sleep(1500); // let the boot animations finish

  // Tap feedback: pointerdown on a format chip -> the frame with :active.
  const tap = [];
  for (let i = 0; i < runs; i++) {
    const sel = `[aria-label="Formato de descarga"] [role=radio]:nth-child(${(i % 2) + 1})`;
    tap.push((await probe(cdp, sel, "pointerdown")).frame);
    await sleep(250);
  }

  // Mode switch inside Download: click a search mode.
  const mode = [];
  for (let i = 0; i < runs; i++) {
    const sel = `[aria-label="Modo de búsqueda"] [role=radio]:nth-child(${(i % 2) + 1})`;
    mode.push((await probe(cdp, sel, "click")).frame);
    await sleep(400);
  }

  // View switch: open and close the library drawer.
  const open = [];
  const close = [];
  for (let i = 0; i < runs; i++) {
    open.push(await probe(cdp, "button.libbtn", "click", true));
    await sleep(400);
    close.push(await probe(cdp, "button.libbtn", "click", true));
    await sleep(400);
  }

  result.tapFeedback = { medianMs: median(tap), maxMs: max(tap), runs: tap.length };
  result.modeSwitch = { medianMs: median(mode), maxMs: max(mode), runs: mode.length };
  result.libraryOpen = {
    firstFrameMedianMs: median(open.map((o) => o.frame)),
    firstFrameMaxMs: max(open.map((o) => o.frame)),
    settledMedianMs: median(open.map((o) => o.settled)),
    longestFrameMedianMs: median(open.map((o) => o.longestFrame)),
  };
  result.libraryClose = {
    firstFrameMedianMs: median(close.map((o) => o.frame)),
    settledMedianMs: median(close.map((o) => o.settled)),
    longestFrameMedianMs: median(close.map((o) => o.longestFrame)),
  };

  // Scroll: open the drawer, then fling through the list and back.
  await probe(cdp, "button.libbtn", "click", true);
  await sleep(500);
  const vp = await cdp.eval(() => ({ w: innerWidth, h: innerHeight }));
  const scroll = [];
  for (let i = 0; i < 3; i++) {
    await cdp.eval(pageFramesStart);
    for (const dir of [-1, 1]) {
      await cdp.send("Input.synthesizeScrollGesture", {
        x: Math.round(vp.w / 2),
        y: Math.round(vp.h * 0.6),
        yDistance: dir * Math.round(vp.h * 4),
        speed: 2000,
        gestureSourceType: touch ? "touch" : "mouse",
        repeatCount: 1,
      });
    }
    scroll.push(await cdp.eval(pageFramesStop));
  }
  result.libraryScroll = scroll;
  await probe(cdp, "button.libbtn", "click", true);

  cdp.close();
  if (child) child.kill();

  if (args.json) console.log(JSON.stringify(result));
  else console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
