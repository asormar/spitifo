import { API, errMsg, rowKey } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   LOS TRES PEDIDOS DE LOS ALBUMES

   La busqueda la hace Buscar en paralelo con las canciones; el detalle y el
   emparejamiento los hace la ficha (en su chunk). Los tres comparten el mismo
   fetch pelado y el mismo manejo de errores.
   ------------------------------------------------------------------------- */

/* GET /api/albums/search -> { query, albums: [...] }. iTunes caido devuelve
   una lista vacia (no un error), asi que no hay estante en ese caso. */
export async function searchAlbums(q, signal) {
  const r = await fetch(`${API}/albums/search?q=${encodeURIComponent(q)}&limit=8`, { signal });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errMsg(d, "no se pudieron buscar los álbumes"));
  return Array.isArray(d.albums) ? d.albums : [];
}

/* GET /api/album/{id}: la lista real del disco, con has_full todavia null. */
export async function fetchAlbumDetail(id, signal) {
  const r = await fetch(`${API}/album/${encodeURIComponent(id)}`, { signal });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errMsg(d, "no se pudo abrir el álbum"));
  return d;
}

/* Pedido comun de las dos rutas de match: misma URL base y mismo error. */
async function _matchFetch(id, signal, stream) {
  const url = `${API}/album/${encodeURIComponent(id)}/match${stream ? "?stream=1" : ""}`;
  const r = await fetch(url, { signal });
  if (!r.ok) {
    throw new Error(errMsg(await r.json().catch(() => ({})),
      "no se pudieron buscar las versiones completas"));
  }
  return r;
}

/* GET /api/album/{id}/match: puede tardar 5-15 s (busca video por pista). */
export async function fetchAlbumMatch(id, signal) {
  const r = await _matchFetch(id, signal, false);
  return r.json().catch(() => ({}));
}

/* Lee NDJSON: une trozos y parte por lineas, inclusive una linea partida en
   dos chunks. Cada objeto se pasa a onEvento. */
async function leerNdjson(reader, onEvento) {
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const ls = buf.split("\n");
    buf = ls.pop();  // el ultimo puede estar incompleto
    for (const l of ls) if (l.trim()) onEvento(JSON.parse(l));
  }
  if (buf.trim()) onEvento(JSON.parse(buf + dec.decode()));
}

/* GET /api/album/{id}/match?stream=1: onTracks por cada lote de pistas
   recien matcheadas; resuelve con el mismo payload que fetchAlbumMatch. */
export async function streamAlbumMatch(id, { signal, onTracks } = {}) {
  const r = await _matchFetch(id, signal, true);
  /* WebView viejo sin ReadableStream: se espera a la respuesta completa. */
  if (!r.body?.getReader) {
    await r.body?.cancel?.();
    return fetchAlbumMatch(id, signal);
  }
  const reader = r.body.getReader();
  let cab = null, final = null;
  try {
    await leerNdjson(reader, (ev) => {
      if (ev.type === "album") cab = ev;
      else if (ev.type === "tracks") onTracks?.(ev.tracks);
      else if (ev.type === "done") final = ev;
    });
  } finally { reader.releaseLock?.(); }
  /* Sin `done` (server viejo o corte): ultimo recurso, pedido normal. */
  return final && cab
    ? { album: cab.album, tracks: final.tracks, ytdlp: cab.ytdlp, full: final.full }
    : fetchAlbumMatch(id, signal);
}

/* Reemplaza cada fila base por su version recien matcheada, conservando el
   orden de la lista que ya se mostraba. Las claves nuevas van al final. */
export function mergeMatchedTracks(base = [], updates = []) {
  if (!updates.length) return base;
  const pos = new Map();
  base.forEach((t, i) => pos.set(rowKey(t), i));
  const salida = base.slice();
  for (const t of updates) {
    const k = rowKey(t);
    if (pos.has(k)) salida[pos.get(k)] = t;
    else {
      pos.set(k, salida.length);
      salida.push(t);
    }
  }
  return salida;
}
