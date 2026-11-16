/* ---------------------------------------------------------------------------
   LISTA REAL DE UN ALBUM EN ESCUCHAR

   La ficha de un album pide su tracklist a iTunes una sola vez por sesion y la
   guarda en memoria: volver a abrir la pagina no repite el pedido. Sin red, con
   el album caido o sin id, simplemente no hay filas nuevas: nunca un aviso de
   error. Todo lo que decide que filas se ven es puro y se prueba en Node.
   ------------------------------------------------------------------------- */

import { API } from "../shared/api.js";
import { fold } from "./library.js";

const cache = new Map();

/* La promesa se guarda, no el resultado: dos paginas que se abran a la vez
   comparten el mismo pedido. Por eso el pedido no lleva la senal de quien lo
   pidio: si la primera pagina se desmonta, abortarlo dejaria sin lista a la
   segunda. Quien se desmonta solo ignora la respuesta. Un fallo borra la
   entrada para poder reintentar en otra visita. */
export function loadAlbumTracklist(id) {
  if (!id) return Promise.resolve(null);
  if (cache.has(id)) return cache.get(id);
  const pending = fetch(`${API}/album/${encodeURIComponent(id)}`)
    .then((r) => {
      /* Solo se guarda una respuesta buena: un 502 de iTunes no deja el album
         sin lista toda la sesion. */
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    })
    .then((d) => (d && Array.isArray(d.tracks) ? { album: d.album || null, tracks: d.tracks } : null))
    .catch(() => {
      cache.delete(id);
      return null;
    });
  cache.set(id, pending);
  return pending;
}

/* Si un album tiene varias canciones con id (puede pasar al juntar discos),
   manda el que mas se repite; a igualdad, el primero. */
export function mostCommonAlbumId(entries = []) {
  const counts = new Map();
  let best = null;
  let bestN = 0;
  for (const entry of entries) {
    const id = entry?.album_id;
    if (id == null || id === "") continue;
    const key = String(id);
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > bestN) {
      bestN = n;
      best = key;
    }
  }
  return best;
}

const sameNo = (a, b) => a != null && b != null && Number(a) === Number(b);

/* Cada pista de iTunes es nuestra si una cancion del album tiene su disco y su
   numero, o (si no) si el titulo plegado coincide. Cada cancion se usa una sola
   vez: las que sobran se dejan al final, en el orden que ya tenian. Las demas
   pistas se vuelven filas "missing" en su sitio de la lista. `num` es el puesto
   en la fila, como en el resto de la pagina. */
export function mergeAlbumTracks(entries, tracklist) {
  const songs = entries || [];
  const list = Array.isArray(tracklist) ? tracklist : [];
  if (!list.length) {
    return {
      rows: songs.map((entry, i) => ({ type: "entry", key: entry.key, entry, owned: false, num: i + 1 })),
      have: null,
      total: null,
    };
  }

  const used = new Set();
  const rows = [];
  let have = 0;
  list.forEach((track, i) => {
    const disc = track?.extra?.disc_number;
    const number = track?.extra?.track_number;
    let own = songs.find(
      (e) => !used.has(e.key) && sameNo(e.disc_no, disc) && sameNo(e.track_no, number)
    );
    const title = fold(track?.title);
    if (!own && title) own = songs.find((e) => !used.has(e.key) && fold(e.title) === title);
    if (own) {
      used.add(own.key);
      rows.push({ type: "entry", key: own.key, entry: own, owned: true });
      have += 1;
    } else {
      const d = disc == null ? 0 : Number(disc);
      const n = number == null ? i + 1 : Number(number);
      rows.push({ type: "missing", key: `missing:${d}-${n}`, title: track?.title || "", owned: false });
    }
  });
  for (const entry of songs) {
    if (!used.has(entry.key)) rows.push({ type: "entry", key: entry.key, entry, owned: false });
  }
  return { rows: rows.map((r, i) => ({ ...r, num: i + 1 })), have, total: list.length };
}
