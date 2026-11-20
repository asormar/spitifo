/* ---------------------------------------------------------------------------
   OPCIONES DEL MENU DE UNA CANCION

   Que se ve y en que orden depende solo del estado de la fila: las opciones de
   siempre, y al final lo que corresponda a guardada/descargada. Puro, sin
   React ni DOM: se prueba en Node.
   ------------------------------------------------------------------------- */

const streamable = (song) => Boolean(song?.id && /^(yt:|ia:)/.test(song.id));

export function menuKinds(entry) {
  const out = ["next", "end", "list"];
  if (entry?.album) out.push("album");
  if (entry?.artist) out.push("artist");
  /* Cambiar foto va antes de lo que descarga o borra. */
  out.push("photo");
  const saved = Boolean(entry?.sid);
  const downloaded = Boolean(entry?.downloaded);
  if (saved && !downloaded && streamable(entry?.song)) out.push("download");
  if (saved && downloaded) out.push("undownload");
  if (downloaded) out.push("file");
  out.push("remove");
  return out;
}
