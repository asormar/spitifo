/* ---------------------------------------------------------------------------
   COLOR DE FONDO DE "AHORA SUENA"

   El fondo toma el color del cuadrante mas saturado de la portada (el matiz
   vivo, no el promedio turbio de toda la imagen), oscurecido hasta que el
   texto blanco se lea sobre el. Sin portada, el color sale de un hash del
   nombre del artista: la misma cancion siempre tiene el mismo fondo. Todo son
   funciones puras (sin canvas ni DOM): quien dibuja la imagen en un canvas es
   la vista, aqui solo se calcula, y por eso se puede probar en Node.
   ------------------------------------------------------------------------- */

import { toneColor } from "../shared/cover.js";

/* Casi negro del tema oscuro (--bg): hacia el se mezcla el color de la portada. */
const BASE = [14, 14, 24];

/* Contraste minimo del blanco sobre el fondo: el titulo pide 7.5:1 (--dim, el
   texto secundario, sube al 92 % de alpha y con eso le alcanza). */
const MIN_CONTRAST = 7.5;

/* Media de los pixeles opacos de un ImageData (RGBA). Un pixel transparente no
   tiene color: contarlo oscureceria las portadas con bordes vacios. */
export function averageColor(data) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n += 1;
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null;
}

/* Luminancia relativa de WCAG. */
export function luminance([r, g, b]) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/* Contraste del blanco sobre `rgb`. */
export const contrastWithWhite = (rgb) => 1.05 / (luminance(rgb) + 0.05);

/* Mezcla hacia BASE en pasos del 5 % hasta alcanzar el contraste: lo minimo
   que hace falta, para que una portada ya oscura conserve su color. */
export function darken(rgb) {
  for (let t = 0; t < 1; t += 0.05) {
    const out = rgb.map((v, i) => Math.round(v + (BASE[i] - v) * t));
    if (contrastWithWhite(out) >= MIN_CONTRAST) return out;
  }
  return BASE;
}

export const rgbCss = ([r, g, b]) => `rgb(${r} ${g} ${b})`;

/* Sin portada, el fondo es el color de genero de la portada generada (la del
   artista, ver shared/cover.js) al 50 % sobre el casi negro: el blanco se lee
   sobre el en las 16 (6:1 como minimo). Va como texto CSS: --genre-N cambia con
   el tema y lo resuelve el navegador. */
export const toneTint = (tone) => `color-mix(in oklab, var(--genre-${toneColor(tone)}) 50%, #0e0e18)`;

/* Media de un cuadrante (la mitad del lado, en pixeles) de un ImageData
   cuadrado de `size` x `size`, o null si no tiene pixeles opacos. */
function quadrantAverage(data, size, qx, qy, half) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = qy; y < qy + half; y += 1) {
    for (let x = qx; x < qx + half; x += 1) {
      const i = (y * size + x) * 4;
      if (i + 3 >= data.length || data[i + 3] === 0) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
  }
  return n ? [r / n, g / n, b / n] : null;
}

/* Saturacion HSV (0-1) de un color medio, sin convertir a HSV completo: solo
   el componente que hace falta para comparar cuadrantes. */
function saturation([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

/* El cuadrante mas saturado de un ImageData cuadrado (por defecto 24x24): el
   matiz vivo de la portada, como extrae Spotify, en vez del promedio turbio de
   toda la imagen (una portada casi negra con un logo brillante ya no se
   queda en gris). Devuelve null sin pixeles opacos en ningun cuadrante. */
export function maxSatQuadrant(data, size = 24) {
  const half = size / 2;
  const quads = [
    [0, 0],
    [half, 0],
    [0, half],
    [half, half],
  ];
  let best = null;
  let bestSat = -1;
  for (const [qx, qy] of quads) {
    const avg = quadrantAverage(data, size, qx, qy, half);
    if (!avg) continue;
    const sat = saturation(avg);
    if (sat > bestSat) {
      bestSat = sat;
      best = avg.map(Math.round);
    }
  }
  return best;
}

/* Del ImageData de la portada al color de fondo, o null si no hay pixeles. */
export function artTint(data) {
  const vibrant = maxSatQuadrant(data);
  return vibrant ? rgbCss(darken(vibrant)) : null;
}
