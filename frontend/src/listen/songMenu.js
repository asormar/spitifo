/* ---------------------------------------------------------------------------
   GRUPOS DEL MENU DE UNA CANCION DE LA BIBLIOTECA

   La misma forma que resultMenuGroups: grupos con etiqueta y items, en este
   orden, y los que no tienen items no se pintan. Lo destructivo va separado al
   final y "Cerrar reproductor", solo desde "Ahora suena", detras de todo. Puro,
   sin React ni DOM: se prueba en Node.
   ------------------------------------------------------------------------- */

import { CLOSE_PLAYER_GROUP, PLAY_ITEMS } from "../download/resultMenuActions.js";

const streamable = (song) => song?.id && /^(yt:|ia:)/.test(song.id);

export function songMenuGroups(entry, { fmt = "m4a", closePlayer = false, pc = false } = {}) {
  const groups = [{ label: "Escuchar", items: PLAY_ITEMS }];

  const library = [{ kind: "list", icon: "ListPlus", text: "Añadir a una lista…" }];
  const saved = !!entry?.sid;
  const downloaded = !!entry?.downloaded;
  if (saved && !downloaded && streamable(entry?.song)) {
    library.push({ kind: "download", icon: "DownloadSimple", text: "Descargar", sub: fmt });
  } else if (saved && downloaded) {
    library.push({ kind: "undownload", icon: "Prohibit", text: "Quitar descarga" });
  }
  groups.push({ label: "Tu biblioteca", items: library });

  const go = [];
  if (entry?.album) go.push({ kind: "album", icon: "VinylRecord", text: "Ir al álbum" });
  if (entry?.artist) go.push({ kind: "artist", icon: "User", text: "Ir al artista" });
  if (go.length) groups.push({ label: "Ir a", items: go });

  /* La direccion de la pagina es compartible: el⋮ de cada entidad ofrece
     «Compartir» con el sistema o el portapapeles. */
  groups.push({
    label: "Compartir",
    items: [{ kind: "share", icon: "ShareNetwork", text: "Compartir esta página" }],
  });

  const file = [{ kind: "photo", icon: "UploadSimple", text: "Cambiar foto" }];
  /* La ficha del archivo solo existe cuando la cancion lo tiene descargado. */
  if (downloaded) file.push({ kind: "file", icon: "File", text: pc ? "Ver la ficha del archivo" : "Ficha del archivo" });
  groups.push({ label: "Archivo", items: file });

  groups.push({
    label: "Quitar",
    items: [{ kind: "remove", icon: "Trash", text: "Quitar de tu biblioteca", danger: true }],
  });

  /* Abierto desde "Ahora suena": el cierre de la pastilla va siempre el ultimo. */
  if (closePlayer) groups.push(CLOSE_PLAYER_GROUP);
  return groups;
}
