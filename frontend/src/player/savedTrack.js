import { API, keyUrl } from "../shared/api.js";
import { fold, toTrack } from "../listen/library.js";
import { auditionKey, streamKey } from "../download/streamTrack.js";

/* ---------------------------------------------------------------------------
   PISTAS DE CANCIONES GUARDADAS

   Lo que el motor necesita para reproducir una cancion de la biblioteca que
   puede no tener archivo. modulo puro: las funciones no tocan window ni hacen
   peticiones, se prueban en Node.
   ------------------------------------------------------------------------- */

const UNKNOWN = "Artista desconocido";
const WATCH = (id) => `https://www.youtube.com/watch?v=${id}`;

/* La fila de una lista: la clave es el id de la cancion, no una URL. Si la
   cancion ya tiene archivo, la fila apunta a la entrada de la biblioteca para
   que la portada y el "suena ahora" sean los de siempre. */
export function savedEntry(song) {
  if (!song?.id) return null;
  const title = song.title || "sin título";
  const artist = song.artist || UNKNOWN;
  return {
    key: song.id,
    kind: "stream",
    sid: song.id,
    song,
    title,
    artist,
    album: song.album || "",
    duration: song.duration ?? null,
    artworkUrl: song.artwork_url || null,
    thumbKey: null,
    downloaded: false,
    search: fold(`${title} ${artist} ${song.album || ""}`),
    titleKey: fold(title),
  };
}

/* Los ids de iTunes del registro con los nombres de un resultado de Buscar. */
const ITUNES_EXTRA = {
  track_id: "track_id",
  collection_id: "collection_id",
  artist_id: "artist_id",
  track_no: "track_number",
  disc_no: "disc_number",
  track_count: "track_count",
};

/* La pista lleva un resultado con la forma de uno de Buscar: con el se
   descarga (en el backend la fuente de YouTube es "ytdlp", no "youtube"), se
   enlazan artista y album en "Ahora suena" y songIdOf vuelve al mismo id. */
export function resultOf(song) {
  const yt = song.id.startsWith("yt:");
  const sourceId = String(song.source_id || song.id.slice(3));
  const extra = {};
  for (const [from, to] of Object.entries(ITUNES_EXTRA)) {
    if (song.itunes?.[from] != null) extra[to] = song.itunes[from];
  }
  extra.needs_resolve = true;
  let id = sourceId;
  if (yt) {
    extra.webpage_url = WATCH(sourceId);
  } else {
    const cut = sourceId.indexOf("/");
    id = sourceId.slice(0, cut);
    extra.filename = sourceId.slice(cut + 1);
    extra.item_ids = [id];
  }
  return {
    source: yt ? "ytdlp" : "archive",
    source_id: id,
    title: song.title || "sin título",
    artist: song.artist || UNKNOWN,
    album: song.album || null,
    duration_s: song.duration ?? null,
    artwork_url: song.artwork_url || null,
    extra,
  };
}

export function savedTrack(song, byKey = null) {
  if (!song?.id) return null;
  const title = song.title || "sin título";
  const artist = song.artist || UNKNOWN;
  const sourceId = song.source_id || song.id.slice(3);
  const meta = song.album && song.album !== title
    ? `${artist} · ${song.album}`
    : artist;

  /* Con archivo descargado suena el archivo. La clave sigue siendo el id para
     que la fila de la lista y el motor coincidan y el historial use la misma
     identidad estable. */
  const entry = byKey?.get?.(song.file_key);
  if (song.file_key && entry) {
    return {
      ...toTrack(entry, keyUrl),
      key: song.id,
      sid: song.id,
      artist,
      result: resultOf(song),
      song,
    };
  }

  if (song.id.startsWith("yt:")) {
    const url = WATCH(sourceId);
    return {
      key: streamKey(url),
      src: `${API}/stream?url=${encodeURIComponent(url)}`,
      title,
      label: title,
      meta,
      duration: song.duration ?? null,
      artwork: song.artwork_url || null,
      kind: "stream",
      sid: song.id,
      artist,
      result: resultOf(song),
      song,
    };
  }
  if (song.id.startsWith("ia:")) {
    const path = String(sourceId).split("/").map(encodeURIComponent).join("/");
    return {
      key: auditionKey({ source_id: sourceId }),
      src: `https://archive.org/download/${path}`,
      title,
      label: title,
      meta,
      duration: song.duration ?? null,
      artwork: song.artwork_url || null,
      kind: "stream",
      sid: song.id,
      artist,
      result: resultOf(song),
      song,
    };
  }
  return null;
}

/* Cola de una lista: las entradas de la biblioteca siguen con toTrack y los
   ids guardados se convierten en pistas reproducibles. */
export function tracksFor(entries, byKey, savedById, keyUrlFn = keyUrl) {
  return (entries || []).filter((e) => e && e.kind !== "video").map((e) => {
    if (e.sid) {
      const track = savedTrack(e.song || savedById?.get?.(e.sid), byKey);
      if (track) return track;
    }
    return toTrack(e, keyUrlFn);
  });
}
