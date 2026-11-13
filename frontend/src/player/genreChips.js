import { useEffect, useState } from "react";
import { fetchMapFile } from "../discover/mapFile.js";
import { API } from "../shared/api.js";
import { fold } from "../listen/library.js";

/* ---------------------------------------------------------------------------
   "EN EL MAPA DE GENEROS" (tarjeta de Ahora suena)

   Los generos reales del artista que suena, los que el perfilador ya guardo
   (GET /api/artist/genres: no arranca nada ni toca la red), cruzados con el
   mapa. Importa SOLO mapFile.js (un fetch del JSON, compartido con Descubrir):
   map.js, genres.js y reco.js traerian el chunk de Descubrir entero.

   Sin datos no hay tarjeta: ni artista perfilado, ni generos en el mapa, ni
   mapa. El JSON del mapa (189 KB) se pide solo cuando hay algo que mostrar.
   ------------------------------------------------------------------------- */

const MAX_CHIPS = 4;
const CLUSTERS = 16;
/* Una respuesta vacia vence pronto: el perfilador va artista por artista y el
   que hoy no tiene datos puede tenerlos en minutos. */
export const EMPTY_TTL = 30_000;

/* Nombre plegado -> indice del mapa, una vez por archivo. */
const indexes = new WeakMap();
function indexOf(raw) {
  let index = indexes.get(raw);
  if (!index) {
    index = new Map();
    raw.n.forEach((name, i) => {
      const key = fold(name);
      if (!index.has(key)) index.set(key, i);
    });
    indexes.set(raw, index);
  }
  return index;
}

/* Los generos que el mapa conoce, de mas a menos peso, con su color:
   [{ name, cluster }]. `genres`: [{ name, share }]; `raw`: el JSON del mapa. */
export function chipsFor(genres, raw, limit = MAX_CHIPS) {
  if (!Array.isArray(genres) || !raw || !Array.isArray(raw.n)) return [];
  const index = indexOf(raw);
  const seen = new Set();
  const out = [];
  const ordered = [...genres].sort((a, b) => (Number(b?.share) || 0) - (Number(a?.share) || 0));
  for (const genre of ordered) {
    const i = index.get(fold(genre?.name));
    if (i === undefined || seen.has(i)) continue;
    seen.add(i);
    const cluster = Math.min(CLUSTERS - 1, Math.max(0, Math.trunc(Number(raw.c?.[i])) || 0));
    out.push({ name: raw.n[i], cluster });
    if (out.length === limit) break;
  }
  return out;
}

/* Respuestas por nombre: una con generos vale toda la sesion; una vacia, 30 s. */
export function createGenreCache(now = () => Date.now()) {
  const map = new Map();
  return {
    get(name) {
      const hit = map.get(name);
      if (!hit) return undefined;
      if (!hit.genres.length && now() - hit.at > EMPTY_TTL) {
        map.delete(name);
        return undefined;
      }
      return hit.genres;
    },
    set(name, genres) {
      map.set(name, { genres, at: now() });
    },
  };
}

const cache = createGenreCache();
const inflight = new Map();

/* Generos del artista: de la cache o del backend. Un fallo cuenta como vacio y
   no se guarda. */
export function loadGenres(name, { cache: store = cache, fetcher = fetch } = {}) {
  const hit = store.get(name);
  if (hit !== undefined) return Promise.resolve(hit);
  let pending = inflight.get(name);
  if (!pending) {
    pending = fetcher(`${API}/artist/genres?name=${encodeURIComponent(name)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body) => {
        const genres = Array.isArray(body?.genres) ? body.genres : [];
        store.set(name, genres);
        return genres;
      })
      .catch(() => [])
      .finally(() => inflight.delete(name));
    inflight.set(name, pending);
  }
  return pending;
}

/* Los chips de la tarjeta; [] mientras carga y cuando no hay nada que mostrar. */
export function useArtistGenres(artist) {
  const [chips, setChips] = useState([]);
  useEffect(() => {
    let live = true;
    setChips([]);
    if (!artist) return undefined;
    loadGenres(artist)
      .then((genres) => (genres.length ? fetchMapFile().then((raw) => chipsFor(genres, raw)) : []))
      .catch(() => [])
      .then((list) => {
        if (live) setChips(list);
      });
    return () => {
      live = false;
    };
  }, [artist]);
  return chips;
}
