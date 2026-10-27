/* ---------------------------------------------------------------------------
   MAPA DE GENEROS: matematica pura

   Sin React ni DOM: se prueba en node. El lienzo (mapCanvas.js) solo dibuja y
   mueve la vista; todo lo que decide dónde cae un punto, qué se toca, qué
   etiqueta cabe o a dónde vuela la cámara vive acá.

   Convenciones
     mundo   cuadrado 0..1 (x, y). El JSON trae enteros 0..65535.
     vista   { x, y, k }: centro en el mundo y píxeles CSS por unidad de mundo.
     tamaño  { w, h } del lienzo en píxeles CSS.
   ------------------------------------------------------------------------- */

export const CLUSTERS = 16;
/* Acercamiento máximo, en veces sobre el encuadre de todo el mapa. */
export const MAX_ZOOM = 40;
/* Margen del encuadre y holgura de paneo, en unidades de mundo. */
export const FIT_PAD = 0.04;
export const SLACK = 0.12;
export const MAX_LABELS = 200;

/* Minúsculas sin acentos ni mayúsculas: "Bossa Nová" y "bossa nova" coinciden. */
export function normalize(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/* --- Decodificación --------------------------------------------------------- */

/* Rejilla uniforme en CSR (inicio por celda + índices): se arma una vez y sirve
   para tocar un género sin recorrer los miles. */
export function buildGrid(xs, ys, cells) {
  const n = xs.length;
  const g = cells || Math.max(8, Math.min(128, Math.round(Math.sqrt(n / 3))));
  const at = (v) => Math.min(g - 1, Math.max(0, Math.floor(v * g)));
  const start = new Uint32Array(g * g + 1);
  for (let i = 0; i < n; i++) start[at(ys[i]) * g + at(xs[i]) + 1]++;
  for (let c = 0; c < g * g; c++) start[c + 1] += start[c];
  const fill = start.slice(0, g * g);
  const items = new Uint32Array(n);
  for (let i = 0; i < n; i++) items[fill[at(ys[i]) * g + at(xs[i])]++] = i;
  return { cells: g, start, items };
}

/* Columnas JSON -> arreglos tipados. Lanza si el archivo no es el esperado, para
   que la pantalla muestre el error en vez de dibujar basura. */
export function decodeMap(raw) {
  const names = raw?.n;
  const count = Array.isArray(names) ? names.length : 0;
  const cols = [raw?.x, raw?.y, raw?.c, raw?.w];
  if (!count || cols.some((a) => !Array.isArray(a) || a.length !== count)) {
    throw new Error("El mapa de géneros no tiene el formato esperado");
  }
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  const c = new Uint8Array(count);
  const w = new Uint8Array(count);
  const rStart = new Uint32Array(count + 1);
  const flat = [];
  for (let i = 0; i < count; i++) {
    xs[i] = raw.x[i] / 65535;
    ys[i] = raw.y[i] / 65535;
    c[i] = Math.min(CLUSTERS - 1, Math.max(0, raw.c[i] | 0));
    w[i] = Math.min(100, Math.max(0, Math.round(raw.w[i]) || 0));
    /* Un índice fuera de rango o repetido se descarta: nunca rompe el dibujo. */
    const seen = new Set();
    for (const j of raw.r?.[i] || []) {
      if (Number.isInteger(j) && j >= 0 && j < count && j !== i && !seen.has(j)) {
        seen.add(j);
        flat.push(j);
      }
    }
    rStart[i + 1] = flat.length;
  }
  /* Los más centrales primero: es el orden en que compiten por una etiqueta. */
  const order = Uint32Array.from({ length: count }, (_, i) => i).sort(
    (a, b) => w[b] - w[a] || a - b
  );
  /* Por color, para dibujar un trazo por color y no uno por punto. */
  const clStart = new Uint32Array(CLUSTERS + 1);
  for (let i = 0; i < count; i++) clStart[c[i] + 1]++;
  for (let k = 0; k < CLUSTERS; k++) clStart[k + 1] += clStart[k];
  const fill = clStart.slice(0, CLUSTERS);
  const clIdx = new Uint32Array(count);
  for (let i = 0; i < count; i++) clIdx[fill[c[i]]++] = i;

  return {
    count,
    names,
    norm: names.map(normalize),
    mb: raw.mb || [],
    x: xs,
    y: ys,
    c,
    w,
    rStart,
    rIdx: Uint32Array.from(flat),
    order,
    clStart,
    clIdx,
    grid: buildGrid(xs, ys),
  };
}

export function related(data, i) {
  return data.rIdx.subarray(data.rStart[i], data.rStart[i + 1]);
}

/* Nombre normalizado -> indice. Con nombres repetidos gana el primero. */
export function genreIndex(data) {
  const map = new Map();
  data.norm.forEach((name, i) => {
    if (!map.has(name)) map.set(name, i);
  });
  return map;
}

/* "Para explorar": generos vecinos de los del usuario que el usuario aun no
   tiene. Cada genero del usuario (los primeros `from`, en su orden) aporta sus
   vecinos mas centrales y se reparten por turnos, para que el primero no se
   quede con todos los sitios. Devuelve [{ i, near }]: `near` es el genero del
   usuario del que cuelga. */
export function exploreGenres(data, mine, limit = 6, from = 5) {
  const own = new Set(mine);
  const lists = mine.slice(0, from).map((near) => ({
    near,
    rest: Array.from(related(data, near))
      .filter((j) => !own.has(j))
      .sort((a, b) => data.w[b] - data.w[a] || a - b),
  }));
  const out = [];
  const taken = new Set();
  for (let round = 0; out.length < limit && lists.some((l) => l.rest.length); round++) {
    for (const l of lists) {
      while (l.rest.length && taken.has(l.rest[0])) l.rest.shift();
      const j = l.rest.shift();
      if (j === undefined) continue;
      taken.add(j);
      out.push({ i: j, near: l.near });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/* --- Vista ------------------------------------------------------------------ */

export const fitScale = (size, pad = FIT_PAD) => Math.min(size.w, size.h) / (1 + 2 * pad);

export function limits(size) {
  const min = fitScale(size);
  return { min, max: min * MAX_ZOOM };
}

export const toScreen = (v, size, wx, wy) => ({
  x: (wx - v.x) * v.k + size.w / 2,
  y: (wy - v.y) * v.k + size.h / 2,
});

export const toWorld = (v, size, sx, sy) => ({
  x: (sx - size.w / 2) / v.k + v.x,
  y: (sy - size.h / 2) / v.k + v.y,
});

/* Si el cuadro cabe entero en un eje, ese eje queda centrado; si no, el centro
   no puede salirse del mundo más la holgura. */
function clampAxis(c, extent, slack) {
  const lo = -slack;
  const hi = 1 + slack;
  if (extent >= hi - lo) return 0.5;
  return Math.min(hi - extent / 2, Math.max(lo + extent / 2, c));
}

export function clampView(v, size, lim = limits(size), slack = SLACK) {
  const k = Math.min(lim.max, Math.max(lim.min, v.k));
  return { k, x: clampAxis(v.x, size.w / k, slack), y: clampAxis(v.y, size.h / k, slack) };
}

export function panBy(v, size, dx, dy, lim = limits(size)) {
  return clampView({ k: v.k, x: v.x - dx / v.k, y: v.y - dy / v.k }, size, lim);
}

/* El punto del mundo bajo (sx, sy) no se mueve al escalar. */
export function zoomAt(v, size, sx, sy, factor, lim = limits(size)) {
  const k = Math.min(lim.max, Math.max(lim.min, v.k * factor));
  const p = toWorld(v, size, sx, sy);
  return clampView(
    { k, x: p.x - (sx - size.w / 2) / k, y: p.y - (sy - size.h / 2) / k },
    size,
    lim
  );
}

/* Vista con (wx, wy) en la pantalla en (sx, sy). Sin sx/sy, centrado. */
export function centerOn(size, wx, wy, k, lim, sx = size.w / 2, sy = size.h / 2) {
  return clampView(
    { k, x: wx - (sx - size.w / 2) / k, y: wy - (sy - size.h / 2) / k },
    size,
    lim
  );
}

export const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 4);

/* Vuelo entre dos vistas (e = 0..1, ya suavizado). El zoom es exponencial y el
   centro avanza con el mismo ritmo en pantalla: el destino no se sale del
   cuadro a mitad de camino aunque el acercamiento sea grande. */
export function flyView(a, b, e) {
  if (e <= 0) return a;
  if (e >= 1) return b;
  const k = a.k * Math.pow(b.k / a.k, e);
  const span = 1 / a.k - 1 / b.k;
  const s = Math.abs(span) < 1e-12 ? e : (1 / a.k - 1 / k) / span;
  return { k, x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
}

/* --- Inercia ---------------------------------------------------------------- */

/* Velocidad (px/s) con las muestras de los últimos `win` ms del arrastre. */
export function releaseVelocity(samples, now, win = 90) {
  const recent = samples.filter((s) => now - s.t <= win);
  if (recent.length < 2) return { vx: 0, vy: 0 };
  const a = recent[0];
  const b = recent[recent.length - 1];
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return { vx: 0, vy: 0 };
  return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
}

/* Frenado exponencial: devuelve la velocidad nueva y el desplazamiento exacto
   de este paso (no depende de la tasa de fotogramas). */
export function inertiaStep(vx, vy, dtMs, tau = 0.325) {
  const dt = dtMs / 1000;
  const f = Math.exp(-dt / tau);
  const run = tau * (1 - f);
  return { vx: vx * f, vy: vy * f, dx: vx * run, dy: vy * run };
}

/* --- Tocar un género -------------------------------------------------------- */

/* El más cercano a (wx, wy) dentro de `radius` (unidades de mundo), o -1. */
export function hitTest(grid, xs, ys, wx, wy, radius) {
  const { cells, start, items } = grid;
  const at = (v) => Math.min(cells - 1, Math.max(0, Math.floor(v * cells)));
  const x0 = at(wx - radius);
  const x1 = at(wx + radius);
  const y0 = at(wy - radius);
  const y1 = at(wy + radius);
  let best = -1;
  let bestD = radius * radius;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const c = cy * cells + cx;
      for (let p = start[c]; p < start[c + 1]; p++) {
        const i = items[p];
        const dx = xs[i] - wx;
        const dy = ys[i] - wy;
        const d = dx * dx + dy * dy;
        if (d <= bestD) {
          bestD = d;
          best = i;
        }
      }
    }
  }
  return best;
}

/* --- Etiquetas con nivel de detalle ---------------------------------------- */

/* Recorre los géneros del más al menos central y coloca la etiqueta a la derecha
   del punto (o a la izquierda si no cabe). Una rejilla de pantalla rechaza las
   que chocan con una ya colocada, así que el detalle crece solo al acercar:
   hay más sitio. `first` se coloca antes y no compite (género tocado, sus
   relacionados, los destacados). `center` es el punto de pantalla donde cae el
   centro de la vista (por defecto, el del lienzo: cambia si un panel tapa un
   lado).
   Devuelve [{ i, x, y, left }]: x es el borde donde empieza el texto. */
export function placeLabels({
  order,
  xs,
  ys,
  view,
  size,
  measure,
  radius,
  first = [],
  max = MAX_LABELS,
  height = 14,
  gap = 4,
  cell = 40,
  center = { x: size.w / 2, y: size.h / 2 },
}) {
  const gw = Math.ceil(size.w / cell);
  const gh = Math.ceil(size.h / cell);
  const bins = new Array(gw * gh);
  const rects = [];
  const out = [];
  const ox = center.x - view.x * view.k;
  const oy = center.y - view.y * view.k;
  const half = height / 2;

  const tryPlace = (i) => {
    const sx = xs[i] * view.k + ox;
    const sy = ys[i] * view.k + oy;
    if (sx < 0 || sx > size.w || sy < half || sy > size.h - half) return false;
    const w = measure(i);
    const r = radius(i) + gap;
    let left = false;
    let x0 = sx + r;
    if (x0 + w > size.w - 2) {
      left = true;
      x0 = sx - r - w;
    }
    if (x0 < 2) return false;
    const y0 = sy - half;
    const x1 = x0 + w;
    const y1 = sy + half;
    const c0 = Math.floor(x0 / cell);
    const c1 = Math.min(gw - 1, Math.floor(x1 / cell));
    const r0 = Math.max(0, Math.floor(y0 / cell));
    const r1 = Math.min(gh - 1, Math.floor(y1 / cell));
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const bin = bins[cy * gw + cx];
        if (!bin) continue;
        for (const q of bin) {
          const o = rects[q];
          if (x0 < o[2] && x1 > o[0] && y0 < o[3] && y1 > o[1]) return false;
        }
      }
    }
    const id = rects.length;
    rects.push([x0, y0, x1, y1]);
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) (bins[cy * gw + cx] ||= []).push(id);
    }
    out.push({ i, x: left ? x1 : x0, y: sy, left });
    return true;
  };

  for (const i of first) tryPlace(i);
  const taken = new Set(first);
  for (let p = 0; p < order.length && out.length < max; p++) {
    const i = order[p];
    if (!taken.has(i)) tryPlace(i);
  }
  return out;
}

/* --- Buscador --------------------------------------------------------------- */

/* Prefijo del nombre > prefijo de una palabra > contiene. Dentro de cada grupo,
   el más central primero y, a igualdad, el nombre más corto. */
export function searchGenres(data, query, limit = 8) {
  const q = normalize(query);
  if (!q) return [];
  const groups = [[], [], []];
  for (let i = 0; i < data.count; i++) {
    const at = data.norm[i].indexOf(q);
    if (at < 0) continue;
    const prev = at > 0 ? data.norm[i][at - 1] : "";
    groups[at === 0 ? 0 : prev === " " || prev === "-" ? 1 : 2].push(i);
  }
  const byRank = (a, b) =>
    data.w[b] - data.w[a] || data.norm[a].length - data.norm[b].length || a - b;
  const out = [];
  for (const g of groups) {
    g.sort(byRank);
    for (const i of g) {
      if (out.length >= limit) return out;
      out.push(i);
    }
  }
  return out;
}

/* --- Tarjeta ---------------------------------------------------------------- */

/* Esquina de la tarjeta junto al punto (ax, ay), siempre dentro del mapa:
   a la derecha del punto, o a la izquierda si no cabe. */
export function placeCard(ax, ay, card, size, r = 6, margin = 8) {
  let x = ax + r + 10;
  if (x + card.w > size.w - margin) x = ax - r - 10 - card.w;
  x = Math.min(size.w - card.w - margin, Math.max(margin, x));
  const y = Math.min(size.h - card.h - margin, Math.max(margin, ay - 20));
  return { x, y };
}

/* "360ms" o "0.36s" -> milisegundos. */
export function parseMs(text, fallback = 360) {
  const m = /^\s*([\d.]+)\s*(ms|s)\s*$/.exec(text || "");
  if (!m) return fallback;
  return m[2] === "s" ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
}
