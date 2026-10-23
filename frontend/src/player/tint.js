/* ---------------------------------------------------------------------------
   COLOR DE FONDO DE "AHORA SUENA"

   El fondo toma el color medio de la portada, oscurecido hasta que el texto
   blanco se lea sobre el. Sin portada, el color sale de un hash del nombre del
   artista: la misma cancion siempre tiene el mismo fondo. Todo son funciones
   puras (sin canvas ni DOM): quien dibuja la imagen en un canvas es la vista,
   aqui solo se calcula, y por eso se puede probar en Node.
   ------------------------------------------------------------------------- */

/* Negro azulado del tema oscuro: hacia el se mezcla el color de la portada. */
const BASE = [11, 15, 20];

/* Contraste minimo del blanco sobre el fondo. El texto principal pide 4.5, pero
   el secundario va en blanco al 85 % y por debajo de 6 se queda corto. */
const MIN_CONTRAST = 6;

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

/* Tono 0-359 estable para un nombre (hash de cadena de 32 bits). */
export function hashHue(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

/* Saturacion y luz fijas: el peor tono (amarillo) da mas de 5:1 con blanco. */
export const fallbackTint = (name) => `hsl(${hashHue(name)} 45% 28%)`;

/* Del ImageData de la portada al color de fondo, o null si no hay pixeles. */
export function artTint(data) {
  const avg = averageColor(data);
  return avg ? rgbCss(darken(avg)) : null;
}
