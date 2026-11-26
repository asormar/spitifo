import { EXAMPLES } from "../download/constants.js";

/* Las sugerencias son las mismas consultas que Buscar ya sabe resolver: no se
   inventa un catalogo nuevo ni se prometen canciones sin verificar. Puro, sin
   React ni DOM: se prueba en Node. */
export function starterExamples(n = 3) {
  return EXAMPLES.slice(0, Math.max(0, n));
}
