#!/usr/bin/env node
// Measures the running app's UI through the Chrome DevTools Protocol: start-up,
// tap feedback, switching between the three modes, scrolling the library page,
// and the Discover map (first draw, pan, zoom, the "Para ti" panel).
//
//   node scripts/perf/ui.mjs --launch <Spitifo.exe> [--runs 10] [--json]
//   node scripts/perf/ui.mjs --adb [<path to adb>] [--runs 10] [--json]
//   node scripts/perf/ui.mjs --endpoint http://127.0.0.1:9222 [--touch] [--reload]
//
// Windows: --launch starts the installed Spitifo.exe with WebView2's remote
// debugging port open (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS), so launch to
// usable is measured from the spawn. Android: --adb force-stops and starts
// dev.spitifo, reads the launch time from logcat, forwards the WebView's
// DevTools socket and uses touch input. It needs a build made with
// -Pspitifo.inspectable=true (docs/performance.md). --endpoint attaches to a
// page that is already running (any Chromium started with
// --remote-debugging-port); add --reload to load its root URL again first, with the
// HTTP cache off, so the start-up is observed instead of bounded. --touch sends touch events instead of the mouse.
//
// Every timing is taken inside the page:
// - "usable" is when /api/library has answered AND the first content of the
//   mode the app opened on (Descargar by default) is rendered. When the content
//   was already there at attach time the value is a lower bound: the latest of
//   the library response, the mode's JS chunk and the first contentful paint
//   ("usableBasis": "lower-bound", otherwise "observed"). It is measured from
//   the page's time origin and, with a launch time, from the launch;
// - a tap or a mode switch is measured from the input event's timestamp to the
//   end of the first frame produced after it (requestAnimationFrame, then a
//   task), which is when the change is on its way to the screen. A mode switch
//   also reports when the new screen is shown and when its own content is
//   painted (Escuchar: the home sections; Descubrir: the map canvas's first
//   draw, noticed by watching clearRect on the canvases inside .gmap__view);
// - frame intervals come from requestAnimationFrame while the library page
//   scrolls, the map is dragged and zoomed, and the panel animates.
// Nothing in the app is changed for it: the only thing injected into the page
// is a read-only wrapper around CanvasRenderingContext2D.clearRect that counts
// the map's redraws (one call per redraw).
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
    if (r.exceptionDetails) {
      // Keep the page's message, without the stack, so "missing selector: …" and
      // "timed out …" read as what they are.
      const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
      throw new Error(d.split(/\r?\n/)[0].replace(/^Error: /, ""));
    }
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

/** Installs window.__k, the small toolkit the other page functions share. */
function pageKit() {
  if (window.__k) return true;
  try {
    performance.setResourceTimingBufferSize(1000);
  } catch {
    // Older WebViews: the default buffer (250) is enough for one session.
  }
  const k = (window.__k = { draws: 0 });
  k.MODES = { Descargar: "download", Escuchar: "listen", Descubrir: "discover" };
  k.task = () => new Promise((r) => setTimeout(r));
  k.frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
  /** The moment the page can show a change: a draw happens inside a frame, so
   *  the next task already follows its paint; a DOM change needs the next frame. */
  k.painted = (kind) => (kind === "draw" ? k.task() : k.frame());

  // Counts the map's redraws: draw() in mapCanvas.js calls clearRect once.
  const watchers = new Set();
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function (...a) {
    if (this.canvas?.closest?.(".gmap__view")) {
      k.draws++;
      watchers.forEach((f) => f("draw"));
    }
    return clear.apply(this, a);
  };

  // Times the body read + JSON.parse of genre-map.json (decodeMap runs after).
  const json = Response.prototype.json;
  Response.prototype.json = function () {
    const t = performance.now();
    const url = this.url;
    return json.call(this).then((v) => {
      if (/genre-map\.json/.test(url)) k.mapJson = { startMs: t, ms: performance.now() - t };
      return v;
    });
  };

  /** Resolves with how `test` became true ("now", "dom", "draw", "poll"). */
  k.waitFor = (test, what, ms = 15000) =>
    new Promise((resolve, reject) => {
      let over = false;
      let raf = 0;
      const mo = new MutationObserver(() => check("dom"));
      const timer = setTimeout(() => stop(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
      function stop(err, kind) {
        if (over) return;
        over = true;
        clearTimeout(timer);
        mo.disconnect();
        watchers.delete(check);
        cancelAnimationFrame(raf);
        if (err) reject(err);
        else resolve(kind);
      }
      function check(kind) {
        if (over) return;
        let ok = false;
        try {
          ok = test();
        } catch (e) {
          return stop(e);
        }
        if (ok) stop(null, kind);
      }
      const poll = () => {
        check("poll");
        if (!over) raf = requestAnimationFrame(poll);
      };
      mo.observe(document, { subtree: true, childList: true, attributes: true });
      watchers.add(check);
      check("now");
      if (!over) raf = requestAnimationFrame(poll);
    });

  k.q = (selector, what) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`missing selector: ${selector}${what ? ` (${what})` : ""}`);
    return el;
  };
  k.center = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  // The mode bar: the rail on a desktop, the tab bar (or the dots) on a phone.
  // Both are in the DOM; the one CSS hides has no boxes.
  k.nav = () => {
    const nav = [...document.querySelectorAll('nav[aria-label="Modos"]')].find((n) => n.getClientRects().length > 0);
    if (!nav) throw new Error('missing selector: nav[aria-label="Modos"] (a visible one)');
    return nav;
  };
  k.navButton = (label) => {
    const b = [...k.nav().querySelectorAll("button")].find(
      (x) => (x.getAttribute("aria-label") ?? x.textContent).trim() === label
    );
    if (!b) throw new Error(`missing selector: nav[aria-label="Modos"] button named "${label}"`);
    return b;
  };
  k.currentMode = () => {
    try {
      const b = k.nav().querySelector('button[aria-current="page"]');
      const label = b && (b.getAttribute("aria-label") ?? b.textContent).trim();
      return k.MODES[label] ?? null;
    } catch {
      return null;
    }
  };
  k.navKind = () => {
    const nav = k.nav();
    return nav.classList.contains("rail") ? "rail" : nav.classList.contains("tabbar") ? "tabbar" : "dots";
  };

  // Each mode's "first content rendered". `base` (Descubrir): the draw count
  // that has to be exceeded, so a visit counts its own draw and not an old one.
  const screenOf = (id) => document.querySelector(`[data-screen="${id}"]:not([hidden])`);
  k.visible = (id) => !!screenOf(id);
  k.ready = {
    download: () => !!screenOf("download")?.querySelector('[role="search"] input'),
    listen: () => !!screenOf("listen")?.querySelector(".hfeed, .lnote:not([role=alert])"),
    discover: (base = 0) => {
      const c = screenOf("discover")?.querySelector(".gmap__view canvas");
      return !!c && c.width > 0 && k.draws > base;
    },
  };
  k.WHAT = {
    download: 'the Descargar search box ([data-screen="download"] [role="search"] input)',
    listen: 'the Escuchar home ([data-screen="listen"] .hfeed, or .lnote when the library is empty)',
    discover: 'the genre map drawn ([data-screen="discover"] .gmap__view canvas, sized and drawn)',
  };

  // The "Para ti" panel: the side panel's fold button or pill, or the sheet's
  // peek bar on a narrow screen.
  k.panel = () => {
    const root = screenOf("discover");
    const fold = root?.querySelector(".fy--side:not(.is-collapsed) .fy__fold");
    if (fold) return { el: fold, open: true, kind: "side" };
    const pill = root?.querySelector(".fy__pill");
    if (pill) return { el: pill, open: false, kind: "side" };
    const peek = root?.querySelector(".fy__peek");
    if (peek) return { el: peek, open: peek.getAttribute("aria-expanded") === "true", kind: "sheet" };
    return null;
  };
  return true;
}

/** Waits for the first content of the mode the app opened on and for the
 *  library, and reports the start-up timings. */
function pageStartup() {
  const k = window.__k;
  const CHUNK = { download: /DownloadView-/, listen: /ListenView-/, discover: /DiscoverView-/ };
  const find = (re) => performance.getEntriesByType("resource").filter((e) => re.test(e.name));
  return (async () => {
    // The mode bar marks the mode the app opened on.
    await k.waitFor(() => k.currentMode(), 'the mode bar (nav[aria-label="Modos"] button[aria-current])', 30000);
    const id = k.currentMode();
    const present = k.ready[id](-1);
    if (!present) await k.painted(await k.waitFor(() => k.ready[id](-1), `${k.WHAT[id]} to be rendered`, 30000));
    const observed = performance.now();
    await k.waitFor(() => find(/\/api\/library/).length > 0, "the /api/library request", 30000);
    const lib = find(/\/api\/library/)[0];
    await k.waitFor(() => document.readyState === "complete", "document.readyState complete", 30000);
    const nav = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    const chunk = find(CHUNK[id])[0];
    const bound = Math.max(lib.responseEnd, chunk?.responseEnd ?? 0, fcp?.startTime ?? 0);
    return {
      timeOrigin: performance.timeOrigin,
      mode: id,
      domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? 0),
      load: Math.round(nav?.loadEventEnd ?? 0),
      fcp: fcp ? Math.round(fcp.startTime) : null,
      libraryRequestStart: Math.round(lib.startTime),
      libraryResponseEnd: Math.round(lib.responseEnd),
      usable: Math.round(present ? bound : Math.max(bound, observed)),
      usableBasis: present ? "lower-bound" : "observed",
      viewport: `${innerWidth}x${innerHeight}`,
      nav: k.navKind(),
    };
  })();
}

/** Arms a one-shot probe on a mode button: its click -> first frame, screen
 *  shown, and the mode's own content painted. */
function pageArmSwitch(label, id) {
  const k = window.__k;
  const btn = k.navButton(label);
  const base = k.draws;
  window.__perf = new Promise((resolve, reject) => {
    btn.addEventListener(
      "click",
      (e) => {
        const t0 = e.timeStamp;
        const out = { t0 };
        const at = (name) => () => {
          out[name] = performance.now() - t0;
        };
        const frame = k.frame().then(at("frame"));
        const shown = k
          .waitFor(
            () => k.visible(id) && btn.getAttribute("aria-current") === "page",
            `the ${id} screen to be shown after clicking "${label}"`
          )
          .then(k.painted)
          .then(at("shown"));
        const content = k
          .waitFor(() => k.ready[id](base), `${k.WHAT[id]} after clicking "${label}"`)
          .then(k.painted)
          .then(at("content"));
        Promise.all([frame, shown, content]).then(() => resolve(out), reject);
      },
      { once: true, capture: true }
    );
  });
  return k.center(btn);
}

/** Arms a one-shot probe on a control: pointerdown -> end of the next frame,
 *  and whether :active is on by then (the press feedback). */
function pageArmTap(spec) {
  const k = window.__k;
  const el = spec.nav ? k.navButton(spec.nav) : k.q(spec.css, "tap target");
  window.__tapEl = el;
  window.__perf = new Promise((resolve) => {
    el.addEventListener(
      "pointerdown",
      (e) => {
        const t0 = e.timeStamp;
        requestAnimationFrame(() =>
          setTimeout(() => resolve({ frame: performance.now() - t0, active: el.matches(":active") }))
        );
      },
      { once: true, capture: true }
    );
  });
  return k.center(el);
}

/** Arms a probe on the "Para ti" panel's toggle: click -> first frame, and
 *  waits for the panel to reach the other state plus a moment for its motion. */
function pageArmPanel() {
  const k = window.__k;
  const p = k.panel();
  if (!p) {
    throw new Error(
      'missing selector: [data-screen="discover"] .fy__fold, .fy__pill or .fy__peek (the "Para ti" panel control)'
    );
  }
  window.__perf = new Promise((resolve, reject) => {
    p.el.addEventListener(
      "click",
      (e) => {
        const t0 = e.timeStamp;
        const frame = k.frame().then(() => performance.now() - t0);
        const flipped = k
          .waitFor(() => k.panel()?.open === !p.open, `the "Para ti" panel to ${p.open ? "close" : "open"}`, 5000)
          .then(() => new Promise((r) => setTimeout(r, 700)));
        Promise.all([frame, flipped]).then(([f]) => resolve({ frame: f }), reject);
      },
      { once: true, capture: true }
    );
  });
  return { ...k.center(p.el), open: p.open, kind: p.kind };
}

/** Records requestAnimationFrame intervals until stopped. */
function pageFramesStart() {
  const run = (window.__framesRun = (window.__framesRun ?? 0) + 1);
  window.__frames = [];
  window.__framesDraws = window.__k?.draws ?? 0;
  window.__scrollMax = 0;
  const tick = (ts) => {
    if (window.__framesRun !== run) return;
    window.__frames.push(ts);
    window.__scrollMax = Math.max(window.__scrollMax, window.scrollY);
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
    // How far the page got scrolled (to tell a fling that moved from one that did not).
    maxScrollPx: Math.round(window.__scrollMax),
    // Redraws of the Discover map since pageFramesStart (0 elsewhere).
    mapDraws: (window.__k?.draws ?? 0) - window.__framesDraws,
  };
}

/** What the page requested for Discover, from Resource Timing. */
function pageDiscoverResources() {
  const res = performance.getEntriesByType("resource");
  const pick = (re) =>
    res
      .filter((e) => re.test(e.name))
      .map((e) => ({
        url: e.name.replace(location.origin, ""),
        startMs: Math.round(e.startTime),
        responseEndMs: Math.round(e.responseEnd),
        durationMs: Math.round(e.duration * 10) / 10,
        transferBytes: e.transferSize,
        bodyBytes: e.encodedBodySize,
        decodedBytes: e.decodedBodySize,
      }));
  return {
    chunk: pick(/DiscoverView-.*\.js/),
    genreMap: pick(/genre-map\.json/),
    api: pick(/\/api\/discover/),
    jsonMs: window.__k?.mapJson ? Math.round(window.__k.mapJson.ms * 10) / 10 : null,
  };
}

/** Opens "Explorar la biblioteca" from the Escuchar home. */
async function pageOpenLibrary() {
  const k = window.__k;
  const root = k.q('[data-screen="listen"]:not([hidden])', "the Escuchar screen");
  const card = [...root.querySelectorAll("button.xcard")].find((b) => /Explorar la biblioteca/.test(b.textContent));
  if (!card) throw new Error('missing selector: [data-screen="listen"] button.xcard "Explorar la biblioteca"');
  card.click();
  await k.waitFor(() => root.querySelector(".lpage .vlist .vrow"), 'the library page rows (.lpage .vlist .vrow)');
  window.scrollTo(0, 0);
  await k.frame();
  // How far the page can scroll: 0 when the whole library fits on screen.
  const scrollable = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  return {
    rows: root.querySelectorAll(".vlist .vrow").length,
    total: Number(root.querySelector(".vlist [aria-setsize]")?.getAttribute("aria-setsize")),
    scrollable,
  };
}

/** Leaves the library page with its "Volver" button. */
async function pageCloseLibrary() {
  const k = window.__k;
  const root = k.q('[data-screen="listen"]:not([hidden])', "the Escuchar screen");
  const back = root.querySelector(".lpage .vback");
  if (!back) throw new Error('missing selector: [data-screen="listen"] .lpage .vback ("Volver")');
  back.click();
  await k.waitFor(() => root.querySelector(".hfeed"), 'the Escuchar home (.hfeed) after "Volver"');
  await k.frame();
  return true;
}

// ------------------------------------------------------------------ input

async function press(cdp, { x, y }) {
  if (touch) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  } else {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  }
}

async function release(cdp, { x, y }) {
  if (touch) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }
}

async function tapAt(cdp, point) {
  await press(cdp, point);
  await release(cdp, point);
}

async function moveTo(cdp, { x, y }) {
  if (touch) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  else await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
}

/** Drags in circles around (cx, cy) for `ms`, `turns` times round. */
async function dragCircles(cdp, { cx, cy, radius }, ms, turns = 2) {
  const at = (a) => ({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
  const start = at(0);
  await press(cdp, start);
  const t0 = performance.now();
  let last = start;
  for (;;) {
    const t = performance.now() - t0;
    if (t >= ms) break;
    last = at((t / ms) * turns * 2 * Math.PI);
    await moveTo(cdp, last);
    await sleep(8);
  }
  await release(cdp, last);
}

/** Turns the wheel over (cx, cy) for `ms`: negative deltaY zooms in. */
async function wheel(cdp, { cx, cy }, deltaY, ms) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY });
    await sleep(16);
  }
}

/** Taps the mode button and returns the probe's timings (ms) plus the longest
 *  frame while the screen change settles. */
async function switchMode(cdp, label, id) {
  await cdp.eval(pageFramesStart);
  const point = await cdp.eval(pageArmSwitch, label, id);
  await tapAt(cdp, point);
  let out;
  try {
    out = await cdp.eval(() => window.__perf);
  } finally {
    await sleep(600); // let the transition finish before the next step
  }
  const frames = await cdp.eval(pageFramesStop);
  return { ...out, longestFrame: frames.longestMs };
}

const MODE_LABEL = { download: "Descargar", listen: "Escuchar", discover: "Descubrir" };

/** Goes to a mode without measuring (set-up between measurements). */
async function goTo(cdp, id) {
  if ((await cdp.eval(() => window.__k.currentMode())) === id) return;
  await switchMode(cdp, MODE_LABEL[id], id);
}

const median = (xs) => {
  const s = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.floor(s.length / 2)] * 10) / 10 : null;
};
const max = (xs) => {
  const s = xs.filter((x) => x != null && !Number.isNaN(x));
  return s.length ? Math.round(Math.max(...s) * 10) / 10 : null;
};
const round = (x) => (x == null ? null : Math.round(x * 10) / 10);

/** Medians of a list of switchMode results. */
const summarize = (rs) => ({
  frameMedianMs: median(rs.map((r) => r.frame)),
  frameMaxMs: max(rs.map((r) => r.frame)),
  shownMedianMs: median(rs.map((r) => r.shown)),
  contentMedianMs: median(rs.map((r) => r.content)),
  contentMaxMs: max(rs.map((r) => r.content)),
  longestFrameMedianMs: median(rs.map((r) => r.longestFrame)),
  longestFrameMaxMs: max(rs.map((r) => r.longestFrame)),
  runs: rs.length,
});

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

/** Errors that mean "the page is not ready yet" (a navigation is under way). */
const transient = (e) => !/missing selector|timed out after/.test(e.message);

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
  const result = { page: page.url.replace(/token=[^&]+/, "token=…"), warnings: [] };
  const warn = (msg) => {
    result.warnings.push(msg);
    console.error(`ui.mjs: warning: ${msg}`);
  };
  // A desktop Chromium ignores touch input unless touch is emulated; on the
  // phone the input is real.
  if (touch && !adb) await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });

  if (args.reload) {
    // From the app's root URL, which opens on Descargar (the page may be on
    // another mode, and the mode is kept in the URL). The session cookie from the
    // first load carries over.
    // The HTTP cache is off for the whole run, so the chunks and genre-map.json
    // are really fetched.
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    launchedAt = Date.now();
    await cdp.send("Page.navigate", { url: new URL("/", page.url).href });
  }

  // The first load is /?token=…, which the backend redirects to a clean URL, and
  // a reload replaces the document: retry while there is no page to evaluate in.
  let s;
  for (let tries = 0; !s; tries++) {
    try {
      await cdp.eval(pageKit);
      s = await cdp.eval(pageStartup);
    } catch (e) {
      if (!transient(e) || tries > 200) throw e;
      await sleep(20);
    }
  }
  result.startup = {
    ...s,
    launchToNavigation: launchedAt ? Math.round(s.timeOrigin - launchedAt) : null,
    launchToUsable: launchedAt ? Math.round(s.timeOrigin + s.usable - launchedAt) : null,
  };
  delete result.startup.timeOrigin;
  result.startup.tracks = await cdp.eval(async () => (await (await fetch("/api/library")).json()).count);
  await sleep(1500); // let the boot animations finish
  await goTo(cdp, "download"); // everything below starts from Descargar

  // What Discover cost before the user opened it: after the idle preload had its
  // chance, neither genre-map.json nor /api/discover should have been requested.
  await sleep(2500);
  const before = await cdp.eval(pageDiscoverResources);

  // Tap feedback: pointerdown on a real control that shows :active -> the frame
  // with it. The press is held until the frame ends so :active can be read.
  const radio = '[aria-label="Modo de búsqueda"] [role=radio]';
  const hasRadios = await cdp.eval((sel) => document.querySelectorAll(sel).length >= 2, radio);
  const control = hasRadios ? 'Descargar "Modo de búsqueda" segments' : "mode bar button";
  const startRadio = hasRadios
    ? await cdp.eval((sel) => [...document.querySelectorAll(sel)].findIndex((b) => b.getAttribute("aria-checked") === "true"), radio)
    : -1;
  const tap = [];
  for (let i = 0; i < runs; i++) {
    const spec = hasRadios
      ? { css: `${radio}:nth-child(${(i % 2) + 1})` }
      : { nav: "Escuchar" };
    const point = await cdp.eval(pageArmTap, spec);
    await press(cdp, point);
    const t = await cdp.eval(() => window.__perf);
    // Chromium sets :active on a touch only after its show-press delay (~150 ms).
    if (touch) {
      await sleep(300);
      t.activeLater = await cdp.eval(() => window.__tapEl.matches(":active"));
    }
    tap.push(t);
    await release(cdp, point);
    await sleep(250);
    // With the mode bar as the control, the release switched mode: come back.
    if (!hasRadios) await goTo(cdp, "download");
  }
  if (hasRadios && startRadio >= 0) {
    await cdp.eval((sel, i) => document.querySelectorAll(sel)[i].click(), radio, startRadio);
  }
  result.tapFeedback = {
    control,
    medianMs: median(tap.map((t) => t.frame)),
    maxMs: max(tap.map((t) => t.frame)),
    activeShown: `${tap.filter((t) => t.active).length}/${tap.length}`,
    ...(touch && { activeAfter300ms: `${tap.filter((t) => t.activeLater).length}/${tap.length}` }),
    runs: tap.length,
  };

  // First visits (cold). Descubrir goes first, straight from Descargar, so its
  // JS chunk (not preloaded by the idle callback, which only guesses the next
  // mode) and genre-map.json are both fetched inside the measurement.
  const cold = await switchMode(cdp, "Descubrir", "discover");
  const afterCold = await cdp.eval(pageDiscoverResources);
  const clickAt = cold.t0;
  const map = afterCold.genreMap[0];
  const chunk = afterCold.chunk[0];
  const coldListen = await switchMode(cdp, "Escuchar", "listen");
  await goTo(cdp, "download");

  // Mode switch, warm: Descargar -> Escuchar -> Descubrir -> Descargar.
  const toListen = [];
  const toDiscover = [];
  const toDownload = [];
  for (let i = 0; i < runs; i++) {
    toListen.push(await switchMode(cdp, "Escuchar", "listen"));
    toDiscover.push(await switchMode(cdp, "Descubrir", "discover"));
    toDownload.push(await switchMode(cdp, "Descargar", "download"));
  }
  result.modeSwitch = {
    firstVisit: {
      discover: { frameMs: round(cold.frame), shownMs: round(cold.shown), contentMs: round(cold.content), longestFrameMs: cold.longestFrame },
      listen: { frameMs: round(coldListen.frame), shownMs: round(coldListen.shown), contentMs: round(coldListen.content), longestFrameMs: coldListen.longestFrame },
    },
    toListen: summarize(toListen),
    toDiscover: summarize(toDiscover),
    toDownload: summarize(toDownload),
  };

  // Listen scroll: open "Explorar la biblioteca" (the virtual list), fling
  // through it and back, close it.
  await goTo(cdp, "listen");
  // An empty library has no "Explorar la biblioteca" card to open.
  const lib = result.startup.tracks === 0 ? null : await cdp.eval(pageOpenLibrary);
  if (lib) await sleep(700); // the rows' entry cascade
  const vp = await cdp.eval(() => ({ w: innerWidth, h: innerHeight }));
  if (!lib) {
    result.listenScroll = { skipped: "empty library" };
  } else if (lib.scrollable < vp.h) {
    // A small library scrolls less than one screen: there is not enough list
    // to fling and no frame rate to read. Skip instead of warning.
    await cdp.eval(pageCloseLibrary);
    result.listenScroll = { skipped: `library scrolls less than one screen (${lib.total || lib.rows} rows, ${lib.scrollable} px)` };
  } else {
    const flings = [];
    // A desktop Chromium with emulated touch does not scroll for a synthesized touch
    // gesture: fall back to the mouse wheel's, and say so.
    let source = touch ? "touch" : "mouse";
    const fling = async () => {
      await cdp.eval(pageFramesStart);
      for (const dir of [-1, 1]) {
        await cdp.send("Input.synthesizeScrollGesture", {
          x: Math.round(vp.w / 2),
          y: Math.round(vp.h * 0.6),
          yDistance: dir * Math.round(vp.h * 4),
          speed: 2000,
          gestureSourceType: source,
          repeatCount: 1,
        });
      }
      return cdp.eval(pageFramesStop);
    };
    for (let i = 0; i < 3; i++) {
      let f = await fling();
      if (i === 0 && source === "touch" && !adb && !(f.maxScrollPx > vp.h)) {
        source = "mouse";
        f = await fling();
      }
      flings.push(f);
    }
    await cdp.eval(pageCloseLibrary);
    if (!(max(flings.map((f) => f.maxScrollPx)) > vp.h)) {
      warn("the library fling did not scroll the page (maxScrollPx too small): listenScroll numbers are meaningless");
    }
    result.listenScroll = {
      rowsMounted: lib.rows,
      rowsTotal: lib.total,
      gesture: source,
      flings,
      medianFps: median(flings.map((f) => f.fps)),
      medianP95Ms: median(flings.map((f) => f.p95Ms)),
      medianDroppedPct: median(flings.map((f) => f.droppedPct)),
      longestFrameMs: max(flings.map((f) => f.longestMs)),
    };
  }
  await goTo(cdp, "download");
  await sleep(300);

  // Discover: the map's first draw cold and warm (above), then pan and zoom.
  await goTo(cdp, "discover");
  await sleep(500);
  const box = await cdp.eval(() => {
    const r = window.__k.q('[data-screen="discover"] .gmap__view canvas', "the map canvas").getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const where = {
    cx: box.x + box.w * 0.38,
    cy: box.y + box.h * 0.5,
    radius: Math.min(box.w, box.h) * 0.2,
  };
  await cdp.eval(pageFramesStart);
  await dragCircles(cdp, where, 2000);
  await sleep(600); // the release's inertia
  const pan = await cdp.eval(pageFramesStop);
  if (pan.mapDraws < 5) warn(`the map was redrawn only ${pan.mapDraws} times during the drag: the pan did not register`);

  await cdp.eval(pageFramesStart);
  await wheel(cdp, where, -100, 1000);
  await wheel(cdp, where, 100, 1000);
  await sleep(400);
  const zoom = await cdp.eval(pageFramesStop);
  if (zoom.mapDraws < 5) warn(`the map was redrawn only ${zoom.mapDraws} times during the wheel zoom: the zoom did not register`);
  await cdp.eval(() => window.__k.q('[data-screen="discover"] button[aria-label="Ver todo el mapa"]', "fit button").click());
  await sleep(600);

  // The "Para ti" panel (side panel or bottom sheet): close and open.
  const panel = { close: [], open: [] };
  for (let i = 0; i < runs; i++) {
    for (let step = 0; step < 2; step++) {
      await cdp.eval(pageFramesStart);
      const point = await cdp.eval(pageArmPanel);
      await tapAt(cdp, point);
      const r = await cdp.eval(() => window.__perf);
      const frames = await cdp.eval(pageFramesStop);
      panel[point.open ? "close" : "open"].push({ frame: r.frame, longestFrame: frames.longestMs });
    }
  }
  const afterAll = await cdp.eval(pageDiscoverResources);

  result.discover = {
    cold: {
      firstDrawMs: round(cold.content),
      shownMs: round(cold.shown),
      chunkPreloaded: chunk ? chunk.startMs < clickAt : null,
      chunkMs: chunk ? { startAfterClick: round(chunk.startMs - clickAt), durationMs: chunk.durationMs, bodyBytes: chunk.bodyBytes } : null,
      genreMap: map && {
        startAfterClickMs: round(map.startMs - clickAt),
        fetchMs: map.durationMs,
        // Reading the body and JSON.parse (Response.json()); decodeMap, the
        // render and the draw follow inside responseToFirstDrawMs.
        jsonMs: afterCold.jsonMs,
        transferBytes: map.transferBytes,
        bodyBytes: map.bodyBytes,
        decodedBytes: map.decodedBytes,
        // Response end -> first draw: JSON, decodeMap, React render, canvas.
        responseToFirstDrawMs: round(clickAt + cold.content - map.responseEndMs),
      },
    },
    warm: {
      firstDrawMedianMs: median(toDiscover.map((r) => r.content)),
      firstDrawMaxMs: max(toDiscover.map((r) => r.content)),
      runs: toDiscover.length,
    },
    pan: { gesture: touch ? "touch drag" : "mouse drag", ...pan },
    zoom: { gesture: "wheel, 1 s in then 1 s out", ...zoom },
    panel: {
      kind: await cdp.eval(() => window.__k.panel()?.kind ?? null),
      closeFrameMedianMs: median(panel.close.map((p) => p.frame)),
      closeLongestFrameMs: max(panel.close.map((p) => p.longestFrame)),
      openFrameMedianMs: median(panel.open.map((p) => p.frame)),
      openLongestFrameMs: max(panel.open.map((p) => p.longestFrame)),
      runs: runs,
    },
  };
  result.discoverOnStartup = {
    // Requests made before the first visit to Descubrir (after 1.5 + 2.5 s idle).
    genreMapRequested: before.genreMap.length > 0,
    apiDiscoverRequested: before.api.length > 0,
    chunkRequested: before.chunk.length > 0 ? `at ${before.chunk[0].startMs} ms` : false,
    // Everything after the whole run, to show it does get fetched once opened.
    afterRun: {
      genreMapRequests: afterAll.genreMap.length,
      apiDiscoverRequests: afterAll.api.length,
      apiDiscoverDurationMs: afterAll.api.map((r) => r.durationMs),
    },
  };

  cdp.close();
  if (child) child.kill();

  if (args.json) console.log(JSON.stringify(result));
  else console.log(JSON.stringify(result, null, 2));
  process.exit(result.warnings.length ? 2 : 0);
}

main().catch((e) => {
  const clear = /^(missing selector|timed out after)/.test(e.message ?? "");
  console.error(clear ? `ui.mjs: ${e.message}` : e);
  process.exit(1);
});
