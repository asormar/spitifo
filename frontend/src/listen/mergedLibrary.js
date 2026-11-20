import { fold, normalizeLibrary } from "./library.js";
import { savedEntry } from "../player/savedTrack.js";

/* ---------------------------------------------------------------------------
   BIBLIOTECA UNICA: ARCHIVOS + GUARDADAS

   El registro de guardadas y los archivos son dos fuentes: una cancion puede
   estar en las dos (tiene archivo) o solo en una. Aqui se juntan UNA vez, al
   llegar de /api/library y /api/saved, para que las vistas no repitan la
   resolucion. modulo puro, sin React ni DOM: se prueba en Node.
   ------------------------------------------------------------------------- */

export function mergeLibrary(files, savedById) {
  const base = normalizeLibrary(files);
  const fileByKey = new Map(base.map((e) => [e.key, e]));
  const records = savedById && typeof savedById.values === "function"
    ? [...savedById.values()]
    : [];

  /* Un guardado con archivo vivo es UNA fila: la del archivo, con el id y el
     registro pegados. byKey apunta a la MISMA entrada por la clave del archivo
     y por el id, para que listas e historial resuelvan igual. */
  const linked = new Map();
  for (const song of records) {
    if (!song?.file_key || !fileByKey.has(song.file_key) || linked.has(song.file_key)) continue;
    /* Los nombres los manda lo que se guardo: una descarga de YouTube trae
       etiquetas como «Tema (Official Video)» y la fila no puede cambiar de
       nombre al bajarla. Lo que el registro no tenga sale del archivo. */
    const f = fileByKey.get(song.file_key);
    const title = song.title || f.title;
    const artist = song.artist || f.artist;
    const album = song.album || f.album;
    linked.set(song.file_key, {
      ...f, title, artist, album, sid: song.id, song,
      search: fold(`${title} ${artist} ${album}`),
    });
  }

  const entries = base.map((e) => linked.get(e.key) || e);
  for (const song of records) {
    if (!song?.id || (song.file_key && linked.has(song.file_key))) continue;
    /* Sin archivo vivo: la fila es el stream. La fecha del registro manda en
       "Anadido hace poco", no la de un archivo que ya no esta. */
    entries.push({
      ...savedEntry(song),
      added: Number(song.added_at) || 0,
      downloaded: false,
    });
  }

  const byKey = new Map();
  for (const entry of entries) {
    byKey.set(entry.key, entry);
    if (entry.sid) byKey.set(entry.sid, entry);
  }
  return { entries, byKey };
}
