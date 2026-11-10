/* ---------------------------------------------------------------------------
   TINTA DE LAS ETIQUETAS DEL MAPA

   Cada etiqueta lleva el color de su genero. En claro el color puro no llega a
   contraste sobre blanco, asi que se acerca 68 % al negro (mezcla sRGB simple);
   en oscuro el color puro ya sobra. Sin DOM: lo prueba mapInk.test.js contra
   los valores literales de tokens.css.
   ------------------------------------------------------------------------- */

const HEX = /^#([0-9a-f]{6})$/i;
const KEEP = 0.68;

/* `hex` del genero y `theme` ("light" | "dark", el color-scheme de la app).
   Lo que no es #rrggbb vuelve igual. */
export function labelInk(hex, theme) {
  const m = HEX.exec(hex);
  if (theme === "dark" || !m) return hex;
  const n = parseInt(m[1], 16);
  const part = (shift) =>
    Math.round(((n >> shift) & 255) * KEEP)
      .toString(16)
      .padStart(2, "0");
  return `#${part(16)}${part(8)}${part(0)}`;
}
