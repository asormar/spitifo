import { percent } from "../shared/format.js";
import { CLUSTERS, normalize } from "./map.js";

/* ---------------------------------------------------------------------------
   GENEROS PARA LOS ATAJOS DE BUSCAR

   Lo que hace falta para pintar «Explorar por genero» sin decodificar el mapa
   entero (decodeMap arma rejillas y orden: caro). Sale del JSON crudo
   (genre-map.json: n = nombres, c = columna del cluster) y de los generos del
   usuario (share = fraccion 0..1). Sin React ni DOM: se prueba en Node.
   ------------------------------------------------------------------------- */

/* Color de un genero que el mapa no pudo dar: el cluster 2 de la paleta. */
export const FALLBACK_CLUSTER = 2;
export const TILES = 6;

/* Los generos mas escuchados que el mapa conoce, con su cluster:
   [{ name, share, pct, c }]. `raw` es el JSON del mapa; sin el (todavia no llego
   o fallo) se devuelven los primeros con el color de reserva y siguen siendo
   pulsables: abrir Descubrir no depende del color. */
export function genreTiles(genres, raw, limit = TILES) {
  const sorted = [...genres].sort((a, b) => b.share - a.share);
  const names = raw?.n;
  const clusters = raw?.c;
  if (!Array.isArray(names) || !Array.isArray(clusters)) {
    return sorted.slice(0, limit).map((g) => ({ ...g, pct: percent(g.share), c: FALLBACK_CLUSTER }));
  }
  /* Solo se normalizan los nombres del usuario (decenas), y el recorrido de los
     del mapa se corta en cuanto aparecen todos. */
  const found = new Map(sorted.map((g) => [normalize(g.name), -1]));
  let missing = found.size;
  for (let i = 0; i < names.length && missing > 0; i++) {
    const key = normalize(names[i]);
    if (found.get(key) === -1) {
      found.set(key, i);
      missing -= 1;
    }
  }
  return sorted
    .filter((g) => found.get(normalize(g.name)) >= 0)
    .slice(0, limit)
    .map((g) => {
      const c = clusters[found.get(normalize(g.name))] | 0;
      return { ...g, pct: percent(g.share), c: Math.min(CLUSTERS - 1, Math.max(0, c)) };
    });
}
