import { API } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   MUESTRAS DE UN GENERO

   El mapa no trae canciones: la muestra sale de la misma busqueda de iTunes
   que usa Descargar, que devuelve previews de 30 s. Es una busqueda por texto,
   asi que con nombres raros llegan canciones que se llaman como el genero; por
   eso se mezclan artistas en vez de tomar los primeros tal cual.
   ------------------------------------------------------------------------- */

export const SAMPLE_COUNT = 10;
const SEARCH_LIMIT = 25;

/* Resultados de /api/search -> pistas del motor, una por artista primero y
   el resto despues, sin repetir preview. */
export function pickSamples(results, genre, n = SAMPLE_COUNT) {
  const seen = new Set();
  const artists = new Set();
  const first = [];
  const rest = [];
  for (const t of Array.isArray(results) ? results : []) {
    const url = t?.preview_url;
    if (typeof url !== "string" || !url || seen.has(url)) continue;
    seen.add(url);
    const artist = (t.artist || "").trim().toLowerCase();
    (artist && artists.has(artist) ? rest : first).push(t);
    if (artist) artists.add(artist);
  }
  return [...first, ...rest].slice(0, Math.max(0, n)).map((t) => ({
    key: `preview:${t.preview_url}`,
    src: t.preview_url,
    title: t.title || "sin título",
    label: `el preview de ${t.title || "este resultado"}`,
    meta: `${t.artist || "artista desconocido"} · muestra de ${genre}`,
    duration: 30,
    artwork: t.artwork_url,
    kind: "preview",
  }));
}

/* Una busqueda por genero y sesion: volver a pedir la muestra no repite la red. */
const cache = new Map();

export function fetchSamples(genre, { fetchFn = (...a) => fetch(...a) } = {}) {
  const name = String(genre || "").trim();
  if (!name) return Promise.resolve([]);
  if (!cache.has(name)) {
    const params = new URLSearchParams({ q: name, source: "itunes", limit: String(SEARCH_LIMIT) });
    const request = fetchFn(`${API}/search?${params}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`search: HTTP ${r.status}`);
        const d = await r.json();
        return pickSamples(d.results, name);
      })
      .catch((e) => {
        /* Un fallo no se guarda: el siguiente intento vuelve a la red. */
        cache.delete(name);
        throw e;
      });
    cache.set(name, request);
  }
  return cache.get(name);
}
