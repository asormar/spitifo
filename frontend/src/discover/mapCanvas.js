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

   OBSTACULO. Un panel puede tapar un lado del lienzo (el panel "Para ti"). La
   camara trabaja en el rectangulo que queda a la vista (`vsz`) y su centro cae
   en (cx, cy): encuadrar, volar a un genero, hacer zoom con los botones y el
   limite del paneo usan ese rectangulo, no el lienzo entero. Los puntos
   siguen dibujandose bajo el panel (el cristal los deja ver).
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
  /* Lo que tapa un panel en cada lado, el rectangulo visible y su centro. */
  let ob = { l: 0, t: 0, r: 0, b: 0 };
  let vsz = { w: 1, h: 1 };
  let cx = 0;
  let cy = 0;
  let theme = readTheme(host);
  let fonts = [];
  let sel = -1;
  let hov = -1;
  let highlight = NO_HIGHLIGHT;
  /* Generos de la fila elegida (anillo fuerte) y de la fila bajo el puntero
     (anillo suave). */
  let focusSet = NO_HIGHLIGHT;
  let previewSet = NO_HIGHLIGHT;
  let narrow = false;
  let raf = 0;
  let last = 0;
  let anim = null;
  let glide = null;
  let lastTap = null;
  let zf = 1;
  /* Etiquetas: el primer cuadro lleva solo los puntos (ver deferLabels). Su
     disposicion se guarda mientras la vista, el tema y los resaltados no
     cambien: pasar el puntero por el mapa no la recalcula entera. */
  let labelsOn = false;
  let labelAlpha = 1;
  let fade = null;
  let layout = null;
  let deferRaf = 0;
  let deferTimer = 0;
  const widths = new Float32Array(data.count).fill(-1);
  /* Radio base por peso; el zoom lo agranda despacio (ver dotR). */
  const baseR = Float32Array.from(data.w, (w) => 1.4 + w * 0.026);
  const dotR = (i) => Math.min(16, baseR[i] * zf);

  const applyTheme = (next) => {
    theme = next;
    fonts = TIERS.map((px) => `${px}px ${theme.font}`);
    widths.fill(-1);
    layout = null;
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

  /* Cuanto puede medir el texto de un genero sin medirlo: ya medido, exacto;
     si no, entre 0.18 y 1.25 veces el tamano de la letra por caracter. Con eso
     placeLabels descarta sin medir lo que ya choca (medir es lo caro). */
  const span = (i) => {
    if (widths[i] >= 0) return [widths[i], widths[i]];
    const em = data.names[i].length * TIERS[tierOf(data.w[i])];
    return [em * 0.18, em * 1.25];
  };

  /* Rectangulo visible y centro de la vista: se recalculan al cambiar el
     tamano o el obstaculo. */
  function syncFrame() {
    vsz = { w: Math.max(40, size.w - ob.l - ob.r), h: Math.max(40, size.h - ob.t - ob.b) };
    cx = ob.l + vsz.w / 2;
    cy = ob.t + vsz.h / 2;
    lim = limits(vsz);
  }

  /* Con la tarjeta en hoja inferior (pantalla estrecha) el centro útil sube. */
  const inset = () => (narrow && sel >= 0 ? size.h * 0.42 : 0);

  /* --- Dibujo --------------------------------------------------------------- */

  function draw() {
    const { w, h } = size;
    if (!w || !h) return;
    const { k } = view;
    const xs = data.x;
    const ys = data.y;
    const ox = cx - view.x * k;
    const oy = cy - view.y * k;
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

    /* Vista previa (puntero sobre una fila): anillo suave, sin etiquetas. */
    if (previewSet.size) {
      ctx.beginPath();
      for (const i of previewSet) {
        const sx = xs[i] * k + ox;
        const sy = ys[i] * k + oy;
        if (sx < 0 || sx > w || sy < 0 || sy > h) continue;
        const r = dotR(i) + 4.5;
        ctx.moveTo(sx + r, sy);
        ctx.arc(sx, sy, r, 0, TAU);
      }
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 2;
      ctx.strokeStyle = theme.accent;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* Fila elegida: aro de la superficie y encima otro grueso del acento, como
       el resaltado del diseno; sus etiquetas compiten primero. */
    if (focusSet.size) {
      const marked = [];
      for (const i of focusSet) {
        const sx = xs[i] * k + ox;
        const sy = ys[i] * k + oy;
        if (sx < 0 || sx > w || sy < 0 || sy > h) continue;
        marked.push([sx, sy, dotR(i)]);
        if (first.length < 40) first.unshift(i);
      }
      ctx.lineWidth = 4;
      ctx.strokeStyle = theme.halo;
      ctx.beginPath();
      for (const [sx, sy, r] of marked) {
        ctx.moveTo(sx + r + 2, sy);
        ctx.arc(sx, sy, r + 2, 0, TAU);
      }
      ctx.stroke();
      ctx.lineWidth = 2.75;
      ctx.strokeStyle = theme.accent;
      ctx.beginPath();
      for (const [sx, sy, r] of marked) {
        ctx.moveTo(sx + r + 5.4, sy);
        ctx.arc(sx, sy, r + 5.4, 0, TAU);
      }
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

    if (labelsOn && labelAlpha > 0) {
      /* Etiquetas: tope de ~200 y nivel de detalle por colisión (ver placeLabels). */
      const key = [view.x, view.y, view.k, w, h, cx, cy, lim.min, first.join(",")].join("|");
      if (!layout || layout.key !== key) {
        layout = {
          key,
          labels: placeLabels({
            order: data.order,
            xs,
            ys,
            view,
            size,
            measure,
            span,
            radius: dotR,
            first,
            center: { x: cx, y: cy },
          }),
        };
      }
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      ctx.strokeStyle = theme.halo;
      for (const l of layout.labels) {
        const text = data.names[l.i];
        ctx.font = fonts[tierOf(data.w[l.i])];
        ctx.textAlign = l.left ? "right" : "left";
        const main = priority.has(l.i);
        ctx.globalAlpha = 0.85 * labelAlpha;
        ctx.strokeText(text, l.x, l.y);
        ctx.globalAlpha = (focus >= 0 && !main ? 0.5 : 1) * labelAlpha;
        ctx.fillStyle = main ? theme.ink : theme.muted;
        ctx.fillText(text, l.x, l.y);
      }
      ctx.globalAlpha = 1;
    }

    onAnchor(sel >= 0 ? anchor(sel) : null);
  }

  /* El primer cuadro es solo los puntos: colocar las etiquetas (medir y
     chocar) es lo mas caro de dibujar y el mapa ya se entiende sin ellas. En
     cuanto ese cuadro esta en pantalla entran con un fundido corto. */
  function deferLabels() {
    deferRaf = requestAnimationFrame(() => {
      deferRaf = 0;
      deferTimer = setTimeout(() => {
        deferTimer = 0;
        labelsOn = true;
        fade = reduced() ? null : { t0: null };
        labelAlpha = fade ? 0 : 1;
        schedule();
      }, 0);
    });
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(64, Math.max(0, now - last));
    last = now;
    if (fade) {
      fade.t0 ??= now;
      const t = (now - fade.t0) / 180;
      labelAlpha = t >= 1 ? 1 : easeOut(t);
      if (t >= 1) fade = null;
    }
    if (anim) {
      const t = (now - anim.t0) / anim.dur;
      view = t >= 1 ? anim.to : flyView(anim.from, anim.to, easeOut(t));
      if (t >= 1) anim = null;
    } else if (glide) {
      const s = inertiaStep(glide.vx, glide.vy, dt);
      const next = panBy(view, vsz, s.dx, s.dy, lim);
      const blocked = next.x === view.x && next.y === view.y;
      view = next;
      glide = { vx: s.vx, vy: s.vy };
      if (blocked || Math.hypot(s.vx, s.vy) < 15) glide = null;
    }
    draw();
    if (anim || glide || fade) raf = requestAnimationFrame(frame);
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
    to = clampView(to, vsz, lim);
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
      x: (data.x[i] - view.x) * view.k + cx,
      y: (data.y[i] - view.y) * view.k + cy,
      r: dotR(i),
    };
  }

  function pick(sx, sy, touch) {
    const wx = (sx - cx) / view.k + view.x;
    const wy = (sy - cy) / view.k + view.y;
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
      animateTo(zoomAt(goal(), vsz, p.x - ob.l, p.y - ob.t, 2.2, lim));
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
      view = panBy(view, vsz, p.x - from.x, p.y - from.y, lim);
      gesture.samples.push({ t: e.timeStamp, x: p.x, y: p.y });
      if (gesture.samples.length > 8) gesture.samples.shift();
      schedule();
    } else if (gesture?.kind === "pinch" && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      view = zoomAt(
        panBy(view, vsz, mx - gesture.mx, my - gesture.my, lim),
        vsz,
        mx - ob.l,
        my - ob.t,
        d / gesture.d,
        lim
      );
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
    view = zoomAt(view, vsz, p.x - ob.l, p.y - ob.t, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), lim);
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
    animateTo(zoomAt(goal(), vsz, vsz.w / 2, vsz.h / 2, factor, lim));
  const fit = () => animateTo({ x: 0.5, y: 0.5, k: lim.min });

  return {
    resize(w, h, ratio) {
      if (!w || !h) return;
      const firstSize = !size.w;
      const atFit = firstSize || view.k <= lim.min * 1.001;
      size = { w, h };
      dpr = ratio;
      syncFrame();
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
      view = clampView(atFit ? { x: 0.5, y: 0.5, k: lim.min } : view, vsz, lim);
      /* Al instante: cambiar el tamano vacia el lienzo y quien llama (el
         ResizeObserver) corre antes de pintar, asi no sale un cuadro en blanco. */
      draw();
      if (firstSize && !labelsOn) deferLabels();
    },
    /* Un panel tapa parte del lienzo: { left, top, right, bottom } en px. El
       mapa no se mueve (el mismo punto sigue bajo el mismo pixel); si estaba
       encuadrado entero, se vuelve a encuadrar en lo que queda a la vista. */
    setObstacle({ left = 0, top = 0, right = 0, bottom = 0 } = {}) {
      const next = { l: Math.max(0, left), t: Math.max(0, top), r: Math.max(0, right), b: Math.max(0, bottom) };
      if (next.l === ob.l && next.t === ob.t && next.r === ob.r && next.b === ob.b) return;
      const fitted = size.w > 0 && goal().k <= lim.min * 1.001;
      const [oldX, oldY] = [cx, cy];
      stopMotion();
      ob = next;
      syncFrame();
      if (!size.w) return;
      view = clampView(
        { k: view.k, x: view.x + (cx - oldX) / view.k, y: view.y + (cy - oldY) / view.k },
        vsz,
        lim
      );
      if (fitted) animateTo({ x: 0.5, y: 0.5, k: lim.min });
      schedule();
    },
    setFocusSet(set) {
      focusSet = set || NO_HIGHLIGHT;
      schedule();
    },
    setPreviewSet(set) {
      previewSet = set || NO_HIGHLIGHT;
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
      animateTo(centerOn(vsz, data.x[i], data.y[i], k, lim, vsz.w / 2, (vsz.h - inset()) / 2));
    },
    /* Un toque en la parte baja: sube el género para que la hoja no lo tape. */
    reveal(i) {
      const room = inset();
      if (!room) return;
      const a = anchor(i);
      if (a.y < ob.t + vsz.h - room - 28) return;
      const v = goal();
      animateTo(
        centerOn(vsz, data.x[i], data.y[i], v.k, lim, Math.min(vsz.w - 28, Math.max(28, a.x - ob.l)), (vsz.h - room) / 2)
      );
    },
    zoomBy,
    fit,
    /* Teclado: flechas mueven, +/- acercan, 0 encuadra todo. true = lo atendió. */
    key(e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return false;
      const step = size.w * 0.2;
      const pan = (dx, dy) => {
        stopMotion();
        view = panBy(view, vsz, dx, dy, lim);
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
      cancelAnimationFrame(deferRaf);
      clearTimeout(deferTimer);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    },
  };
}
