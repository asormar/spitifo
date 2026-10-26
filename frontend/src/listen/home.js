import { hashHue } from "../player/tint.js";
import { collator, fold, groupAlbums, groupArtists } from "./library.js";
import { continueListening, mostPlayed } from "./history.js";

/* ---------------------------------------------------------------------------
   LOGICA DEL INICIO DE ESCUCHAR

   Todo lo que decide el inicio sin tocar React ni el DOM, para poder probarlo
   en Node: la busqueda agrupada y su "mejor resultado", los rankings, los
   ordenes de "Explorar la biblioteca" y los datos de "Seguir escuchando". Las
   vistas solo pintan lo que sale de aqui.
   ------------------------------------------------------------------------- */

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* Los ordenes de "Explorar la biblioteca": [clave, texto del chip]. */
export const SORTS = [
  ["az", "A–Z"],
  ["recent", "Recientes"],
  ["artist", "Artista"],
];

/* Cuantas filas admite cada ranking al abrirse con "Ver todo". */
export const TOP_ALL = 20;
export const TOP_HOME = 5;

/* --- Busqueda ------------------------------------------------------------- */

export const queryTerms = (query) => fold(query).split(/\s+/).filter(Boolean);

/* Cuanto se parece un nombre a la consulta: igual, empieza por ella, alguna
   palabra empieza por ella, o solo la contiene. 0 = no aparece. */
export function relevance(name, query) {
  const f = fold(name);
  const q = fold(query);
  if (!q || !f) return 0;
  if (f === q) return 100;
  if (f.startsWith(q)) return 80;
  if (f.split(/\s+/).some((w) => w.startsWith(q))) return 60;
  return f.includes(q) ? 40 : 0;
}

/* Artistas y albumes se agrupan UNA vez por biblioteca, no por tecla. */
export function buildIndex(entries) {
  return {
    entries,
    artists: groupArtists(entries).map((a) => ({ ...a, search: fold(a.name) })),
    albums: groupAlbums(entries).map((a) => ({
      ...a,
      search: fold(`${a.name} ${a.artist}`),
    })),
  };
}

const hasAll = (text, terms) => terms.every((t) => text.includes(t));

/* El artista pesa un poco mas que el album y este que la cancion: con el mismo
   nombre exacto, el mejor resultado es el artista. */
const ARTIST_BONUS = 6;
const ALBUM_BONUS = 3;

function pickBest(query, songs, artists, albums) {
  const candidates = [];
  for (const a of artists) {
    const score = relevance(a.name, query);
    if (score) candidates.push({ kind: "artist", item: a, score: score + ARTIST_BONUS });
  }
  for (const a of albums) {
    const score = relevance(a.name, query);
    if (score) candidates.push({ kind: "album", item: a, score: score + ALBUM_BONUS });
  }
  for (const s of songs) {
    const score = relevance(s.title, query);
    if (score) candidates.push({ kind: "song", item: s, score });
  }
  /* sort es estable: a igual puntuacion gana el que se anadio antes. */
  candidates.sort((x, y) => y.score - x.score);
  if (candidates.length) return candidates[0];
  /* Nada coincide por nombre (la consulta cruza campos): el primero de cada
     grupo, por ese orden. */
  if (artists.length) return { kind: "artist", item: artists[0], score: 0 };
  if (albums.length) return { kind: "album", item: albums[0], score: 0 };
  if (songs.length) return { kind: "song", item: songs[0], score: 0 };
  return null;
}

/* Resultados agrupados de una consulta sobre toda la biblioteca. `plays`
   (clave -> reproducciones) desempata las canciones; `lists` son las listas de
   reproduccion. Una consulta vacia no devuelve nada. */
export function searchLibrary(index, query, { lists = [], plays = {} } = {}) {
  const terms = queryTerms(query);
  const empty = { terms, songs: [], artists: [], albums: [], lists: [], best: null, empty: true };
  if (!terms.length) return empty;
  const q = terms.join(" ");

  const songs = index.entries
    .filter((e) => hasAll(e.search, terms))
    .sort(
      (a, b) =>
        relevance(b.title, q) - relevance(a.title, q) ||
        (plays[b.key] || 0) - (plays[a.key] || 0)
    );
  const artists = index.artists.filter((a) => hasAll(a.search, terms));
  const albums = index.albums.filter((a) => hasAll(a.search, terms));
  const found = lists.filter((p) => hasAll(fold(p.name), terms));
  const best = pickBest(q, songs, artists, albums);

  return {
    terms,
    songs,
    artists,
    albums,
    lists: found,
    best,
    empty: !songs.length && !artists.length && !albums.length && !found.length,
  };
}

/* --- Ordenes y rankings ----------------------------------------------------- */

const byTitle = (a, b) => collator.compare(a.title, b.title);

/* Copia ordenada: A-Z por titulo, Recientes (lo ultimo que llego primero) o por
   artista y, dentro, por titulo. Los empates conservan el orden de entrada. */
export function sortEntries(entries, mode) {
  const out = entries.slice();
  if (mode === "az") out.sort(byTitle);
  else if (mode === "artist") {
    out.sort((a, b) => collator.compare(a.artist, b.artist) || byTitle(a, b));
  } else out.sort((a, b) => b.added - a.added);
  return out;
}

/* Los videos no suenan en la cola: ni "Añadido hace poco" ni los rankings los
   ofrecen. */
const playable = (entry) => entry && entry.kind !== "video";

export function recentEntries(entries, n) {
  return sortEntries(entries.filter(playable), "recent").slice(0, Math.max(0, n));
}

/* Artistas con mas canciones primero; a igualdad, por nombre. */
export function topArtists(artists, n) {
  return artists
    .slice()
    .sort((a, b) => b.entries.length - a.entries.length || collator.compare(a.name, b.name))
    .slice(0, Math.max(0, n));
}

const newest = (group) => group.entries.reduce((m, e) => Math.max(m, e.added), 0);

/* Albumes cuyo contenido llego mas tarde primero. */
export function recentAlbums(albums, n) {
  return albums
    .slice()
    .sort((a, b) => newest(b) - newest(a))
    .slice(0, Math.max(0, n));
}

/* Las canciones de un album en el orden en que se bajaron (casi siempre es el
   de la pista); sin fecha, por titulo. */
export function albumOrder(entries) {
  return entries.slice().sort((a, b) => a.added - b.added || byTitle(a, b));
}

/* --- Historial ---------------------------------------------------------------- */

const SECONDS = 1000;
/* Lo que falta para el final por debajo de lo cual la pista cuenta como
   terminada (misma regla que continueListening). */
const FINISHED_S = 10;

/* "Seguir escuchando": las pistas a medias que siguen en la biblioteca, con su
   progreso. El historial guarda ms; aqui todo va en segundos. */
export function continueItems(state, byKey, n) {
  const out = [];
  if (!(n > 0)) return out;
  for (const rec of continueListening(state, Number.MAX_SAFE_INTEGER)) {
    const entry = byKey.get(rec.key);
    if (!playable(entry)) continue;
    const dur = (Number(rec.dur) || 0) / SECONDS || entry.duration || 0;
    const pos = Math.min(Math.max(0, (Number(rec.pos) || 0) / SECONDS), dur || Infinity);
    const left = Math.max(0, dur - pos);
    const finished = dur > 0 && left <= FINISHED_S;
    out.push({
      entry,
      pos,
      dur,
      left,
      finished,
      pct: dur > 0 ? Math.min(100, Math.round((pos / dur) * 100)) : 0,
      /* Terminada: se vuelve a oir desde el principio. */
      at: finished ? 0 : pos,
    });
    if (out.length >= n) break;
  }
  return out;
}

/* "Lo que más escuchas": por reproducciones, solo las que de verdad se han
   oido hasta contar como reproduccion. */
export function topItems(state, byKey, n) {
  const tracks = state?.tracks || {};
  const out = [];
  if (!(n > 0)) return out;
  for (const key of mostPlayed(state, Number.MAX_SAFE_INTEGER)) {
    const plays = Number(tracks[key]?.plays) || 0;
    const entry = byKey.get(key);
    if (!plays || !playable(entry)) continue;
    out.push({ entry, plays });
    if (out.length >= n) break;
  }
  return out;
}

/* --- Portadas sin imagen ------------------------------------------------------- */

/* Tono estable de una cancion (el de su album; sin album, el del artista) y de
   un grupo. El CSS lo convierte en degradado con --h. */
export const hueOf = (name) => hashHue(name);
export const albumHue = (artist, album) => hashHue(`${artist}|${album}`);
export const entryHue = (entry) =>
  entry.album ? albumHue(entry.artist, entry.album) : hueOf(entry.artist);

/* Los cuatro tonos del mosaico de una lista: las primeras canciones que siguen
   en la biblioteca; si hay menos de cuatro se repite la primera. Vacia = []. */
export function mosaicHues(keys, byKey) {
  const hues = [];
  for (const key of keys) {
    const entry = byKey.get(key);
    if (entry) hues.push(entryHue(entry));
    if (hues.length === 4) break;
  }
  while (hues.length && hues.length < 4) hues.push(hues[0]);
  return hues;
}

/* Minutos redondeados de un conjunto de canciones; null si no se conoce ninguna
   duracion. */
export function minutes(entries) {
  const total = entries.reduce((sum, e) => sum + (e.duration || 0), 0);
  return total > 0 ? Math.max(1, Math.round(total / 60)) : null;
}
