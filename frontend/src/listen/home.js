import { coverTone } from "../shared/cover.js";
import { clock } from "../shared/format.js";
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
export const songs = (n) => plural(n, "canción", "canciones");

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

/* Cuanto se parece un nombre YA PLEGADO (fold()) a una consulta YA PLEGADA:
   igual, empieza por ella, alguna palabra empieza por ella, o solo la
   contiene. 0 = no aparece. Separada de relevance() para que buscar en la
   biblioteca grande no vuelva a plegar la MISMA consulta en cada candidato
   (P-large-library-scale-2): quien recorre muchos candidatos pliega la
   consulta una vez y llama a esta version con los dos lados ya plegados. */
function relevanceFolded(f, q) {
  if (!q || !f) return 0;
  if (f === q) return 100;
  if (f.startsWith(q)) return 80;
  if (f.split(/\s+/).some((w) => w.startsWith(q))) return 60;
  return f.includes(q) ? 40 : 0;
}

/* Cuanto se parece un nombre a la consulta. Pliega los dos lados: para un
   solo candidato (fuera del bucle de busqueda) no hace falta separar el
   plegado de la comparacion. */
export function relevance(name, query) {
  return relevanceFolded(fold(name), fold(query));
}

/* Artistas y albumes se agrupan UNA vez por biblioteca, no por tecla.
   `search` sigue siendo el texto combinado para filtrar (hasAll); `nameFold`
   es solo el nombre, plegado una vez, para relevance() en pickBest. En
   artistas `search` YA es el nombre solo: no hace falta otro campo. */
export function buildIndex(entries) {
  return {
    entries,
    artists: groupArtists(entries).map((a) => ({ ...a, search: fold(a.name) })),
    albums: groupAlbums(entries).map((a) => ({
      ...a,
      search: fold(`${a.name} ${a.artist}`),
      nameFold: fold(a.name),
    })),
  };
}

const hasAll = (text, terms) => terms.every((t) => text.includes(t));

/* El artista pesa un poco mas que el album y este que la cancion: con el mismo
   nombre exacto, el mejor resultado es el artista. */
const ARTIST_BONUS = 6;
const ALBUM_BONUS = 3;

function pickBest(query, songs, artists, albums) {
  /* `query` ya llega plegada (viene de queryTerms().join(" ") en
     searchLibrary): plegarla otra vez por candidato era el costo que mas
     pesaba al escribir con la biblioteca grande. */
  const q = fold(query);
  const candidates = [];
  for (const a of artists) {
    const score = relevanceFolded(a.search, q);
    if (score) candidates.push({ kind: "artist", item: a, score: score + ARTIST_BONUS });
  }
  for (const a of albums) {
    const score = relevanceFolded(a.nameFold, q);
    if (score) candidates.push({ kind: "album", item: a, score: score + ALBUM_BONUS });
  }
  for (const s of songs) {
    const score = relevanceFolded(s.titleKey, q);
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

/* `plays` desempata por reproducciones: puede llegar como objeto plano (los
   tests, y quien arme uno a mano) o como el Map mutable y estable de
   history.js (ListenProvider pasa ESE, sin convertirlo: volverlo objeto en
   cada busqueda recrearia justo el costo que se evito en record()). */
const playsFor = (plays, key) => (plays instanceof Map ? plays.get(key) : plays?.[key]) || 0;

/* Las canciones que casan con todas las palabras, de mas a menos parecidas al
   titulo y, a igualdad, de mas a menos reproducidas. La relevancia se calcula
   una vez por cancion (no por comparacion): con la biblioteca grande es lo que
   mas pesa al escribir. */
function rankSongs(index, terms, plays) {
  /* terms ya son tokens plegados (queryTerms pliega antes de separar), asi
     que q YA esta plegada: relevanceFolded no vuelve a plegarla por
     cancion, solo usa el titleKey precalculado de cada una. */
  const q = fold(terms.join(" "));
  return index.entries
    .filter((e) => hasAll(e.search, terms))
    .map((e) => [relevanceFolded(e.titleKey, q), e])
    .sort((a, b) => b[0] - a[0] || playsFor(plays, b[1].key) - playsFor(plays, a[1].key))
    .map((p) => p[1]);
}

/* Solo las canciones de una consulta: lo que necesita Buscar, sin agrupar
   artistas, albumes ni listas. */
export function searchSongs(index, query, plays = {}) {
  const terms = queryTerms(query);
  return terms.length ? rankSongs(index, terms, plays) : [];
}

/* Resultados agrupados de una consulta sobre toda la biblioteca. `plays`
   (clave -> reproducciones) desempata las canciones; `lists` son las listas de
   reproduccion. Una consulta vacia no devuelve nada. */
export function searchLibrary(index, query, { lists = [], plays = {} } = {}) {
  const terms = queryTerms(query);
  const empty = { terms, songs: [], artists: [], albums: [], lists: [], best: null, empty: true };
  if (!terms.length) return empty;
  const q = terms.join(" ");

  const songs = rankSongs(index, terms, plays);
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

/* Cache por version de biblioteca (la identidad del array `entries`, que solo
   cambia cuando la biblioteca de verdad cambio) y modo de orden: "Todas tus
   canciones" vuelve a montarse al entrar y salir de la pagina, y sin esta
   cache volvia a correr Intl.Collator sobre 20k filas cada vez aunque nada
   hubiera cambiado (P-large-library-scale-4). Un WeakMap no retiene el array
   viejo cuando la biblioteca se recarga de verdad. */
const sortCache = new WeakMap();

/* Copia ordenada: A-Z por titulo, Recientes (lo ultimo que llego primero) o por
   artista y, dentro, por titulo. Los empates conservan el orden de entrada. */
export function sortEntries(entries, mode) {
  let byMode = sortCache.get(entries);
  const cached = byMode?.get(mode);
  if (cached) return cached;
  const out = entries.slice();
  if (mode === "az") out.sort(byTitle);
  else if (mode === "artist") {
    out.sort((a, b) => collator.compare(a.artist, b.artist) || byTitle(a, b));
  } else out.sort((a, b) => b.added - a.added);
  if (!byMode) {
    byMode = new Map();
    sortCache.set(entries, byMode);
  }
  byMode.set(mode, out);
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

/* Las canciones de un album en orden de disco y pista, cuando las hay. Las que
   no tienen numero (las bajadas antes de guardarlo) van detras, en el orden de
   siempre: fecha y, a igualdad, titulo. Si ninguna tiene numero, queda el orden
   de siempre para todas. */
const hasNo = (e) => Number.isInteger(e.disc_no) || Number.isInteger(e.track_no);
const noOf = (e, key) => (Number.isInteger(e[key]) ? e[key] : 0);
const byAdded = (a, b) => a.added - b.added || byTitle(a, b);

export function albumOrder(entries) {
  return entries.slice().sort((a, b) => {
    const na = hasNo(a);
    const nb = hasNo(b);
    if (na !== nb) return na ? -1 : 1;
    if (na) {
      const byDisc = noOf(a, "disc_no") - noOf(b, "disc_no");
      const byTrack = noOf(a, "track_no") - noOf(b, "track_no");
      if (byDisc || byTrack) return byDisc || byTrack;
    }
    return byAdded(a, b);
  });
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
  /* Una guardada con archivo puede tener escuchas bajo la clave del archivo y
     bajo su id: las dos resuelven a la MISMA entrada. Gana la mas reciente. */
  const seen = new Set();
  if (!(n > 0)) return out;
  for (const rec of continueListening(state, Number.MAX_SAFE_INTEGER)) {
    const entry = byKey.get(rec.key);
    if (!playable(entry) || seen.has(entry)) continue;
    seen.add(entry);
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
  const summed = new Map();
  if (!(n > 0)) return [];
  for (const key of mostPlayed(state, Number.MAX_SAFE_INTEGER)) {
    const plays = Number(tracks[key]?.plays) || 0;
    const entry = byKey.get(key);
    if (!plays || !playable(entry)) continue;
    /* Dos claves, una cancion: se juntan sus reproducciones antes de ordenar. */
    const row = summed.get(entry) || { entry, plays: 0, last: 0 };
    row.plays += plays;
    row.last = Math.max(row.last, Number(tracks[key]?.last) || 0);
    summed.set(entry, row);
  }
  return [...summed.values()]
    .sort((a, b) => b.plays - a.plays || b.last - a.last)
    .slice(0, Math.max(0, n));
}

/* "Seguir escuchando": lo que dice la tarjeta bajo el titulo. La que suena
   nunca esta "escuchada": va contando hacia atras. */
export function progressLabel({ finished, left }, current = false) {
  return finished && !current ? "Escuchada" : `${clock(left)} restantes`;
}

/* --- Tu biblioteca ---------------------------------------------------------------- */

export function libraryCounts(index, lists) {
  return {
    songs: index.entries.length,
    lists: lists.length,
    albums: index.albums.length,
    artists: index.artists.length,
  };
}

/* Cuantos artistas y albumes entran en "Todo" de la rejilla de PC. */
export const GRID_ALL = 12;

/* El filtro de la rejilla de PC: pulsar el activo vuelve a "all". */
export const toggleFilter = (current, pressed) => (current === pressed ? "all" : pressed);

/* Las tarjetas de la rejilla de PC. "all" mezcla todas las listas con los
   primeros artistas y albumes recientes; un filtro concreto los trae todos (la
   vista los pinta de a poco). Cada tarjeta es { kind, item }. */
export function libraryGrid(index, lists, filter = "all", n = GRID_ALL) {
  const of = (kind) => (item) => ({ kind, item });
  if (filter === "lists") return lists.map(of("list"));
  if (filter === "artists") return index.artists.map(of("artist"));
  if (filter === "albums") return index.albums.map(of("album"));
  return [
    ...lists.map(of("list")),
    ...topArtists(index.artists, n).map(of("artist")),
    ...recentAlbums(index.albums, n).map(of("album")),
  ];
}

/* --- Portadas sin imagen ------------------------------------------------------- */

/* Tono estable de una cancion (el de su album; sin album, el del artista) y de
   un grupo (ver shared/cover.js: color por artista, trama por album). */
export const toneOf = (name) => coverTone(name);
export const albumTone = (artist, album) => coverTone(artist, album);
export const entryTone = (entry) =>
  entry.album ? albumTone(entry.artist, entry.album) : toneOf(entry.artist);

/* Los cuatro tonos del mosaico de una lista: las primeras canciones que siguen
   en la biblioteca; si hay menos de cuatro se repite la primera. Vacia = []. */
export function mosaicTones(keys, byKey) {
  const tones = [];
  for (const key of keys) {
    const entry = byKey.get(key);
    if (entry) tones.push(entryTone(entry));
    if (tones.length === 4) break;
  }
  while (tones.length && tones.length < 4) tones.push(tones[0]);
  return tones;
}

/* Minutos redondeados de un conjunto de canciones; null si no se conoce ninguna
   duracion. */
export function minutes(entries) {
  const total = entries.reduce((sum, e) => sum + (e.duration || 0), 0);
  return total > 0 ? Math.max(1, Math.round(total / 60)) : null;
}
