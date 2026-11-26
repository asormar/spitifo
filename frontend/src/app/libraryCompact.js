/* ---------------------------------------------------------------------------
   FORMA COMPACTA DE /api/library

   El backend puede mandar las filas en columnas (`fields`+`rows`) en vez de
   un objeto por archivo (P-large-library-scale-1, P-large-library-scale-8):
   a 20k pistas, repetir ~20 nombres de campo en cada fila es la mayor parte
   del peso. Aqui se expande esa forma a los objetos de siempre (lo que
   `normalizeEntry` y el resto de Escuchar ya esperan) y, al reves, se compacta
   para guardar el espejo de `localStorage` sin importar que forma mando el
   backend (uno viejo que ignora `?shape=compact` sigue dando `files`).

   COMPACT_FIELDS espeja backend/app/main.py:COMPACT_FIELDS. El orden importa:
   lo usa `fields.forEach((name, i) => ...)`, no el nombre en si.
   Modulo puro: se prueba en Node.
   ------------------------------------------------------------------------- */

export const COMPACT_FIELDS = [
  "key", "filename", "folder", "bytes", "duration_s", "title", "artist",
  "album", "track_no", "disc_no", "album_id", "modified", "kind",
  "thumb_key", "has_audio", "thumb_s", "verdict", "meta_src", "file_src",
  "real",
];

/* `size_mb` no viaja en la forma compacta: es `bytes` redondeado, no hace
   falta mandarlo dos veces. Se recalcula igual que `library_scan` en el
   backend (el mismo redondeo a 2 decimales). */
function sizeMbOf(bytes) {
  return typeof bytes === "number" ? Math.round((bytes / 1_048_576) * 100) / 100 : null;
}

export function expandCompactLibrary(fields, rows) {
  const names = Array.isArray(fields) && fields.length ? fields : COMPACT_FIELDS;
  return (rows || []).map((row) => {
    const file = {};
    names.forEach((name, i) => {
      file[name] = row[i] ?? null;
    });
    if (file.size_mb == null) file.size_mb = sizeMbOf(file.bytes);
    return file;
  });
}

export function compactLibraryRows(files, fields = COMPACT_FIELDS) {
  return (files || []).map((f) => fields.map((name) => (f[name] === undefined ? null : f[name])));
}
