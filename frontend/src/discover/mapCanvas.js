import {
  CLUSTERS,
  centerOn,
  clampView,
  easeOut,
  flyView,
  hitTest,
  inertiaStep,
  limits,
  panBy,
  parseMs,
  placeLabels,
  related,
  releaseVelocity,
  zoomAt,
} from "./map.js";

/* ---------------------------------------------------------------------------
   LIENZO DEL MAPA

   Dibuja y mueve la vista; no sabe de React. Todo el estado de la cámara vive
   acá en variables, nunca en estado de React: un gesto cambia la vista 60 veces
   por segundo y no debe renderizar nada. Se redibuja solo cuando algo cambia,
   con un requestAnimationFrame que junta todos los avisos del fotograma.
   ------------------------------------------------------------------------- */

const TAU = Math.PI * 2;
const TAP_SLOP = 6;
/* Tamaños de etiqueta según la importancia del género (px). */
const TIERS = [11, 12.5, 14];
const tierOf = (w) => (w >= 66 ? 2 : w >= 33 ? 1 : 0);
/* Al volar a un género no se aleja: se acerca al menos hasta aquí (veces el
   encuadre completo). */
const FLY_ZOOM = 7;
const NO_HIGHLIGHT = new Set();

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Colores, fuente y duración del movimiento salen de los tokens de la app. Se
   leen al montar y cuando cambia el tema (el atributo data-theme de <html>). */
export function readTheme(el) {
  const cs = getComputedStyle(el);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    palette: Array.from({ length: CLUSTERS }, (_, i) => v(`--genre-${i}`, "#7a8a99")),
    ink: v("--ink", "#14202b"),
    muted: v("--muted", "#3c4c5a"),
    halo: v("--surface", "#ffffff"),
    accent: v("--accent", "#d3402b"),
    font: v("--font-body", "system-ui, sans-serif"),
    moveMs: parseMs(v("--t-move", "360ms")),
  };
}

export function createMapCanvas({ canvas, host, data, onPick, onAnchor }) {
  const ctx = canvas.getContext("2d");
  let size = { w: 0, h: 0 };
  let dpr = 1;
  let lim = limits({ w: 1, h: 1 });
  let view = { x: 0.5, y: 0.5, k: 1 };
  let theme = readTheme(host);
  let fonts = [];
  let sel = -1;
  let hov = -1;
  let highlight = NO_HIGHLIGHT;
  let narrow = false;
  let raf = 0;
  let last = 0;
  let anim = null;
  let glide = null;
  let lastTap = null;
  let zf = 1;
  const widths = new Float32Array(data.count).fill(-1);
  /* Radio base por peso; el zoom lo agranda despacio (ver dotR). */
  const baseR = Float32Array.from(data.w, (w) => 1.4 + w * 0.026);
  const dotR = (i) => Math.min(16, baseR[i] * zf);

  const applyTheme = (next) => {
    theme = next;
    fonts = TIERS.map((px) => `${px}px ${theme.font}`);
    widths.fill(-1);
  };
  applyTheme(theme);

  /* Ancho del texto, medido una vez por género con la fuente de su nivel. */
  const measure = (i) => {
    if (widths[i] < 0) {
      ctx.font = fonts[tierOf(data.w[i])];
      widths[i] = ctx.measureText(data.names[i]).width;
    }
    return widths[i];
  };

  /* Con la tarjeta en hoja inferior (pantalla estrecha) el centro útil sube. */
  const inset = () => (narrow && sel >= 0 ? size.h * 0.42 : 0);

  /* --- Dibujo --------------------------------------------------------------- */

  function draw() {
    const { w, h } = size;
    if (!w || !h) return;
    const { k } = view;
    const xs = data.x;
    const ys = data.y;
    const ox = w / 2 - view.x * k;
    const oy = h / 2 - view.y * k;
    zf = 1 + 0.45 * Math.log2(k / lim.min);
    const focus = sel >= 0 ? sel : hov;
    const rel = focus >= 0 ? related(data, focus) : null;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    /* Puntos: un trazo por color. Con un género en foco el resto se apaga. */
    ctx.globalAlpha = focus >= 0 ? 0.3 : 0.88;
    for (let c = 0; c < CLUSTERS; c++) {
      ctx.beginPath();
      for (let p = data.clStart[c]; p < data.clStart[c + 1]; p++) {
        const i = data.clIdx[p];
        const sx = xs[i] * k + ox;
        const sy = ys[i] * k + oy;
        const r = dotR(i);
        if (sx < -r || sx > w + r || sy < -r || sy > h + r) continue;
        ctx.moveTo(sx + r, sy);
        ctx.arc(sx, sy, r, 0, TAU);
      }
      ctx.fillStyle = theme.palette[c];
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* "Tus géneros" (sesión 23): un anillo del acento. Solo los visibles. */
    const first = [];
    const priority = new Set();
    if (highlight.size) {
      ctx.beginPath();
      for (const i of highlight) {
        const sx = xs[i] * k + ox;
        const sy = ys[i] * k + oy;
        if (sx < 0 || sx > w || sy < 0 || sy > h) continue;
        const r = dotR(i) + 3;
        ctx.moveTo(sx + r, sy);
        ctx.arc(sx, sy, r, 0, TAU);
        if (first.length < 40) first.push(i);
      }
      ctx.lineWidth = 1.75;
      ctx.strokeStyle = theme.accent;
      ctx.stroke();
    }

    /* Foco: aristas a sus relacionados y los puntos a plena opacidad. */
    if (focus >= 0) {
      const fx = xs[focus] * k + ox;
      const fy = ys[focus] * k + oy;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = theme.ink;
      ctx.beginPath();
      for (const j of rel) {
        ctx.moveTo(fx, fy);
        ctx.lineTo(xs[j] * k + ox, ys[j] * k + oy);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = theme.halo;
      for (const j of rel) {
        ctx.beginPath();
        ctx.arc(xs[j] * k + ox, ys[j] * k + oy, dotR(j) + 1, 0, TAU);
        ctx.fillStyle = theme.palette[data.c[j]];
        ctx.fill();
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(fx, fy, dotR(focus) + 2, 0, TAU);
      ctx.fillStyle = theme.palette[data.c[focus]];
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = theme.ink;
      ctx.stroke();
      first.unshift(focus, ...rel);
    }
    first.forEach((i) => priority.add(i));

    /* Etiquetas: tope de ~200 y nivel de detalle por colisión (ver placeLabels). */
    const labels = placeLabels({
      order: data.order,
      xs,
      ys,
      view,
      size,
      measure,
      radius: dotR,
      first,
    });
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = theme.halo;
    for (const l of labels) {
      const text = data.names[l.i];
      ctx.font = fonts[tierOf(data.w[l.i])];
      ctx.textAlign = l.left ? "right" : "left";
      const main = priority.has(l.i);
      ctx.globalAlpha = 0.85;
      ctx.strokeText(text, l.x, l.y);
      ctx.globalAlpha = focus >= 0 && !main ? 0.5 : 1;
      ctx.fillStyle = main ? theme.ink : theme.muted;
      ctx.fillText(text, l.x, l.y);
    }
    ctx.globalAlpha = 1;

    onAnchor(sel >= 0 ? anchor(sel) : null);
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(64, Math.max(0, now - last));
    last = now;
    if (anim) {
      const t = (now - anim.t0) / anim.dur;
      view = t >= 1 ? anim.to : flyView(anim.from, anim.to, easeOut(t));
      if (t >= 1) anim = null;
    } else if (glide) {
      const s = inertiaStep(glide.vx, glide.vy, dt);
      const next = panBy(view, size, s.dx, s.dy, lim);
      const blocked = next.x === view.x && next.y === view.y;
      view = next;
      glide = { vx: s.vx, vy: s.vy };
      if (blocked || Math.hypot(s.vx, s.vy) < 15) glide = null;
    }
    draw();
    if (anim || glide) raf = requestAnimationFrame(frame);
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  const stopMotion = () => {
    anim = null;
    glide = null;
  };

  /* Cámara animada con la duración del token --t-move. Con movimiento reducido
     (o sin cambio) salta directo. */
  function animateTo(to) {
    to = clampView(to, size, lim);
    glide = null;
    if (reduced() || (to.x === view.x && to.y === view.y && to.k === view.k)) {
      anim = null;
      view = to;
    } else {
      last = performance.now();
      anim = { from: view, to, t0: last, dur: theme.moveMs };
    }
    schedule();
  }

  const goal = () => (anim ? anim.to : view);

  /* --- Consultas --------------------------------------------------------- */

  function anchor(i) {
    return {
      x: (data.x[i] - view.x) * view.k + size.w / 2,
      y: (data.y[i] - view.y) * view.k + size.h / 2,
      r: dotR(i),
    };
  }

  function pick(sx, sy, touch) {
    const wx = (sx - size.w / 2) / view.k + view.x;
    const wy = (sy - size.h / 2) / view.k + view.y;
    return hitTest(data.grid, data.x, data.y, wx, wy, (touch ? 22 : 12) / view.k);
  }

  /* --- Entrada -------------------------------------------------------------- */

  const pts = new Map();
  let gesture = null;

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function setHover(p) {
    const hit = pick(p.x, p.y, false);
    if (hit === hov) return;
    hov = hit;
    canvas.style.cursor = hit >= 0 ? "pointer" : "";
    schedule();
  }

  function onTap(p, touch, t) {
    const prev = lastTap;
    if (prev && t - prev.t < 320 && Math.hypot(p.x - prev.x, p.y - prev.y) < 30) {
      lastTap = null;
      animateTo(zoomAt(goal(), size, p.x, p.y, 2.2, lim));
      return;
    }
    lastTap = { t, x: p.x, y: p.y };
    onPick(pick(p.x, p.y, touch));
  }

  function onDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    stopMotion();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* Puntero ya liberado: el gesto sigue con los eventos del lienzo. */
    }
    const p = local(e);
    pts.set(e.pointerId, p);
    if (pts.size === 1) {
      gesture = {
        kind: "pan",
        moved: false,
        sx: p.x,
        sy: p.y,
        touch: e.pointerType !== "mouse",
        samples: [{ t: e.timeStamp, x: p.x, y: p.y }],
      };
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      gesture = { kind: "pinch", d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
  }

  function onMove(e) {
    const p = local(e);
    const prev = pts.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === "mouse") setHover(p);
      return;
    }
    pts.set(e.pointerId, p);
    if (gesture?.kind === "pan" && pts.size === 1) {
      if (!gesture.moved) {
        if (Math.hypot(p.x - gesture.sx, p.y - gesture.sy) < TAP_SLOP) return;
        gesture.moved = true;
        canvas.style.cursor = "grabbing";
      }
      const from = gesture.samples.length === 1 ? { x: gesture.sx, y: gesture.sy } : prev;
      view = panBy(view, size, p.x - from.x, p.y - from.y, lim);
      gesture.samples.push({ t: e.timeStamp, x: p.x, y: p.y });
      if (gesture.samples.length > 8) gesture.samples.shift();
      schedule();
    } else if (gesture?.kind === "pinch" && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      view = zoomAt(panBy(view, size, mx - gesture.mx, my - gesture.my, lim), size, mx, my, d / gesture.d, lim);
      gesture = { kind: "pinch", d, mx, my };
      schedule();
    }
  }

  function release(e, cancelled) {
    const p = local(e);
    if (!pts.delete(e.pointerId)) return;
    canvas.style.cursor = hov >= 0 ? "pointer" : "";
    const g = gesture;
    if (g?.kind === "pan") {
      gesture = null;
      if (cancelled) return;
      if (!g.moved) {
        onTap(p, g.touch, e.timeStamp);
      } else if (!reduced()) {
        g.samples.push({ t: e.timeStamp, x: p.x, y: p.y });
        const v = releaseVelocity(g.samples, e.timeStamp);
        if (Math.hypot(v.vx, v.vy) > 120) {
          /* Velocidad en px de pantalla: mismo signo que el arrastre, que es
             lo que espera panBy. */
          glide = { vx: v.vx, vy: v.vy };
          last = performance.now();
          schedule();
        }
      }
    } else if (g?.kind === "pinch" && pts.size === 1) {
      /* Queda un dedo: sigue arrastrando, sin tap ni inercia. */
      const [rest] = pts.values();
      gesture = { kind: "pan", moved: true, sx: rest.x, sy: rest.y, touch: true, samples: [{ t: e.timeStamp, x: rest.x, y: rest.y }] };
    } else if (pts.size === 0) {
      gesture = null;
    }
  }

  function onWheel(e) {
    e.preventDefault();
    stopMotion();
    const p = local(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * size.h : e.deltaY;
    view = zoomAt(view, size, p.x, p.y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), lim);
    setHover(p);
    schedule();
  }

  const onLeave = () => {
    if (pts.size || hov < 0) return;
    hov = -1;
    canvas.style.cursor = "";
    schedule();
  };
  const onUp = (e) => release(e, false);
  const onCancel = (e) => release(e, true);

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("pointerleave", onLeave);
  /* No pasivo: el zoom con la rueda no debe desplazar la página. */
  canvas.addEventListener("wheel", onWheel, { passive: false });

  /* --- API ------------------------------------------------------------------ */

  const zoomBy = (factor) =>
    animateTo(zoomAt(goal(), size, size.w / 2, size.h / 2, factor, lim));
  const fit = () => animateTo({ x: 0.5, y: 0.5, k: lim.min });

  return {
    resize(w, h, ratio) {
      if (!w || !h) return;
      const atFit = !size.w || view.k <= lim.min * 1.001;
      size = { w, h };
      dpr = ratio;
      lim = limits(size);
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
      view = clampView(atFit ? { x: 0.5, y: 0.5, k: lim.min } : view, size, lim);
      schedule();
    },
    /* Sincrono: la cortina del tema captura la pagina nueva sin esperar al
       siguiente fotograma. */
    refreshTheme() {
      applyTheme(readTheme(host));
      draw();
    },
    setHighlight(set) {
      highlight = set || NO_HIGHLIGHT;
      schedule();
    },
    setNarrow(value) {
      narrow = value;
    },
    setSelected(i) {
      sel = i;
      schedule();
    },
    /* Vuela al género y lo deja centrado; no se aleja si ya estaba más cerca. */
    flyTo(i) {
      const k = Math.max(goal().k, lim.min * FLY_ZOOM);
      animateTo(centerOn(size, data.x[i], data.y[i], k, lim, size.w / 2, (size.h - inset()) / 2));
    },
    /* Un toque en la parte baja: sube el género para que la hoja no lo tape. */
    reveal(i) {
      const room = inset();
      if (!room) return;
      const a = anchor(i);
      if (a.y < size.h - room - 28) return;
      const v = goal();
      animateTo(centerOn(size, data.x[i], data.y[i], v.k, lim, Math.min(size.w - 28, Math.max(28, a.x)), (size.h - room) / 2));
    },
    zoomBy,
    fit,
    /* Teclado: flechas mueven, +/- acercan, 0 encuadra todo. true = lo atendió. */
    key(e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return false;
      const step = size.w * 0.2;
      const pan = (dx, dy) => {
        stopMotion();
        view = panBy(view, size, dx, dy, lim);
        schedule();
      };
      switch (e.key) {
        case "ArrowLeft":
          pan(step, 0);
          return true;
        case "ArrowRight":
          pan(-step, 0);
          return true;
        case "ArrowUp":
          pan(0, step);
          return true;
        case "ArrowDown":
          pan(0, -step);
          return true;
        case "+":
        case "=":
          zoomBy(1.6);
          return true;
        case "-":
        case "_":
          zoomBy(1 / 1.6);
          return true;
        case "0":
          fit();
          return true;
        default:
          return false;
      }
    },
    anchor,
    destroy() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    },
  };
}
