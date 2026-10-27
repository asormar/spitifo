/* ---------------------------------------------------------------------------
   GESTOS DE "PARA TI": matematica pura

   Sin React ni DOM: se prueba en node. La hoja inferior, el panel lateral y el
   deslizar una fila deciden aca; los componentes solo pasan posiciones y
   velocidades (px y px/s, las que da releaseVelocity en map.js).

   Convenciones
     offset   distancia de la hoja hacia ABAJO desde su posicion abierta del
              todo: 0 = completa, mayor = mas escondida. Ir hacia abajo es
              velocidad positiva.
   ------------------------------------------------------------------------- */

/* Alto de la barra cuando la hoja esta recogida. */
export const PEEK = 56;
export const HALF_RATIO = 0.45;
export const FULL_RATIO = 0.85;
/* Por encima de esta velocidad (px/s) un soltar es un "lanzamiento": elige el
   siguiente punto en esa direccion sin importar cuanto se arrastro. */
export const FLING = 500;
/* Cuanto se proyecta la inercia hacia adelante al soltar sin lanzar (s). */
const PROJECT_S = 0.12;
/* Un punto a menos de esto del dedo cuenta como "donde ya estaba". */
const NEAR = 24;

export const SNAPS = ["full", "half", "peek"];

/* Alturas visibles de la hoja para un mapa de `mapH` px y su offset. La hoja
   mide siempre `full`; recoger es desplazarla hacia abajo. */
export function sheetGeometry(mapH) {
  const full = Math.max(PEEK + 120, Math.round(mapH * FULL_RATIO));
  const half = Math.min(full - 40, Math.max(PEEK + 80, Math.round(mapH * HALF_RATIO)));
  const heights = { full, half, peek: PEEK };
  const offsets = { full: 0, half: full - half, peek: full - PEEK };
  return { full, heights, offsets };
}

/* Offset limitado a [lo, hi]; pasado el borde se frena (resistencia) en vez de
   seguir al dedo. */
export function resist(offset, lo, hi, k = 0.3) {
  if (offset < lo) return lo - (lo - offset) * k;
  if (offset > hi) return hi + (offset - hi) * k;
  return offset;
}

/* A que punto va la hoja al soltarla.
   - `offset`: donde esta ahora; `velocity`: px/s (positiva = hacia abajo).
   - `points`: offsets de los puntos de parada, ascendentes.
   Un lanzamiento elige el siguiente punto en su direccion (saltandose el que
   ya tenia debajo del dedo); si no, el mas cercano a donde llegaria. */
export function pickSnap(offset, velocity, points) {
  const list = [...points].sort((a, b) => a - b);
  const nearest = (x) => list.reduce((best, p) => (Math.abs(p - x) < Math.abs(best - x) ? p : best), list[0]);
  if (Math.abs(velocity) >= FLING) {
    if (velocity > 0) return list.find((p) => p > offset + NEAR) ?? list[list.length - 1];
    return [...list].reverse().find((p) => p < offset - NEAR) ?? list[0];
  }
  return nearest(offset + velocity * PROJECT_S);
}

/* Nombre del punto ("full" | "half" | "peek") para un offset ya elegido. */
export function snapName(offset, offsets) {
  return SNAPS.reduce((best, n) => (Math.abs(offsets[n] - offset) < Math.abs(offsets[best] - offset) ? n : best), "peek");
}

/* Un arrastre que empieza dentro de la lista: mueve la hoja o desplaza la
   lista? Con la hoja completa la lista manda, salvo que este arriba del todo y
   se tire hacia abajo; sin completar, la lista no se desplaza y todo arrastre
   es de la hoja. */
export function listDrag({ scrollTop, dy, atFull }) {
  if (!atFull) return "sheet";
  return scrollTop <= 0 && dy > 0 ? "sheet" : "scroll";
}

/* Eje de un gesto: cuando el movimiento es claramente del eje pedido el gesto
   "start"; si gana el otro eje, "cancel" (el scroll del navegador se lo
   queda); hasta pasar `slop` px, null. */
export function lockAxis(dx, dy, axis, slop = 6) {
  const major = Math.abs(axis === "x" ? dx : dy);
  const minor = Math.abs(axis === "x" ? dy : dx);
  if (Math.max(major, minor) < slop) return null;
  return major >= minor ? "start" : "cancel";
}

/* Desplazamiento de una fila al deslizarla: solo hacia la izquierda, con un
   poco de resistencia hacia la derecha. */
export function swipeOffset(dx, width) {
  if (dx > 0) return Math.min(24, dx * 0.2);
  return Math.max(-width, dx);
}

/* Soltar una fila: "dismiss" si paso del 35 % de su ancho o se lanzo hacia la
   izquierda con cierto recorrido; si no, "snap" (vuelve a su sitio). */
export function swipeDecision(dx, width, velocity = 0, ratio = 0.35) {
  if (!(width > 0)) return "snap";
  if (dx <= -width * ratio) return "dismiss";
  if (velocity <= -700 && dx <= -40) return "dismiss";
  return "snap";
}

/* Progreso 0..1 del aviso "No me interesa" que se destapa detras de la fila. */
export const swipeProgress = (dx, width) => (width > 0 ? Math.min(1, Math.max(0, -dx / (width * 0.35))) : 0);

/* Panel lateral: se recoge si se arrastra a la derecha mas de un cuarto de su
   ancho o se lanza hacia la derecha. */
export function panelDecision(dx, width, velocity = 0) {
  if (dx >= width * 0.25 || (velocity >= 600 && dx >= 24)) return "collapse";
  return "stay";
}

/* La pestana recogida vuelve si se arrastra hacia la izquierda. */
export const tabDecision = (dx, velocity = 0) =>
  dx <= -28 || (velocity <= -500 && dx <= -12) ? "expand" : "stay";
