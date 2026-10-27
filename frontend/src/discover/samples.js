import { API } from "../shared/api.js";
import { normalize } from "./map.js";

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
   el resto despues, sin repetir preview. `metaOf(track)` cambia la segunda
   linea (por defecto "artista · muestra de <genero>"). */
export function pickSamples(results, genre, n = SAMPLE_COUNT, metaOf) {
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
    meta: metaOf ? metaOf(t) : `${t.artist || "artista desconocido"} · muestra de ${genre}`,
    duration: 30,
    artwork: t.artwork_url,
    kind: "preview",
  }));
}

/* Muestra de UN artista: la busqueda es por texto y trae tambien canciones de
   otros que se llaman parecido o lo nombran. Se queda con las del artista cuyo
   nombre, sin acentos ni mayusculas, es el mismo; si ninguna lo es, con todo
   lo que llego (mejor una muestra aproximada que ninguna). */
export function pickArtistSamples(results, artist, n = SAMPLE_COUNT) {
  const list = Array.isArray(results) ? results : [];
  const want = normalize(artist);
  const same = list.filter((t) => normalize(t?.artist) === want);
  return pickSamples(same.length ? same : list, artist, n, (t) => `${t.artist || artist} · muestra`);
}

/* Una busqueda por texto y sesion: volver a pedir la muestra no repite la red. */
const cache = new Map();

function search(key, name, pick, fetchFn) {
  if (!cache.has(key)) {
    const params = new URLSearchParams({ q: name, source: "itunes", limit: String(SEARCH_LIMIT) });
    const request = fetchFn(`${API}/search?${params}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`search: HTTP ${r.status}`);
        const d = await r.json();
        return pick(d.results, name);
      })
      .catch((e) => {
        /* Un fallo no se guarda: el siguiente intento vuelve a la red. */
        cache.delete(key);
        throw e;
      });
    cache.set(key, request);
  }
  return cache.get(key);
}

export function fetchSamples(genre, { fetchFn = (...a) => fetch(...a) } = {}) {
  const name = String(genre || "").trim();
  if (!name) return Promise.resolve([]);
  return search(`genre:${name}`, name, pickSamples, fetchFn);
}

export function fetchArtistSamples(artist, { fetchFn = (...a) => fetch(...a) } = {}) {
  const name = String(artist || "").trim();
  if (!name) return Promise.resolve([]);
  return search(`artist:${name}`, name, pickArtistSamples, fetchFn);
}
