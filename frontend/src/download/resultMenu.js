import { canOpenAlbumSheet } from "../player/npLinks.js";
import { trackState } from "./constants.js";
import { needsResolve } from "./resolveResult.js";

/* ---------------------------------------------------------------------------
   GRUPOS DEL MENU DE UN RESULTADO

   Que se ve y en que orden depende solo del resultado: los grupos con items
   van en este orden y los vacios no se pintan. El estado de descarga llega de
   la pantalla para no leer almacenes aqui. Puro, sin React ni DOM.
   ------------------------------------------------------------------------- */

const canDownload = (t) => trackState(t) === "full" || needsResolve(t);

/* «Escuchar» es igual en Buscar y en la biblioteca: una sola copia de las
   acciones y del texto, que comparten los dos menus. */
export const PLAY_ITEMS = [
  { kind: "next", icon: "Playlist", text: "Reproducir a continuación" },
  { kind: "end", icon: "Queue", text: "Añadir al final de la cola" },
];

/* «Cerrar reproductor» va siempre el ultimo, tanto en el menu de la biblioteca
   abierto desde "Ahora suena" como en el menu de resultados de un stream. */
export const CLOSE_PLAYER_GROUP = {
  label: "Reproductor",
  items: [{ kind: "closePlayer", icon: "X", text: "Cerrar reproductor" }],
};

export function resultMenuGroups(t, { downloaded = false, fmt = "m4a" } = {}) {
  const groups = [{ label: "Escuchar", items: PLAY_ITEMS }];

  if (downloaded) {
    groups.push({
      label: "Tu biblioteca",
      items: [{ kind: "downloaded", icon: "Check", text: "Descargada", disabled: true }],
    });
  } else if (canDownload(t)) {
    groups.push({
      label: "Tu biblioteca",
      items: [{ kind: "download", icon: "DownloadSimple", text: "Descargar", sub: fmt }],
    });
  }

  groups.push({
    label: "Compartir",
    items: [{ kind: "share", icon: "Share", text: "Compartir" }],
  });

  const go = [];
  if (canOpenAlbumSheet(t)) go.push({ kind: "album", icon: "VinylRecord", text: `Ir al álbum «${t.album}»` });
  if (t?.artist) go.push({ kind: "artist", icon: "User", text: `Ir a ${t.artist}` });
  if (go.length) groups.push({ label: "Ir a", items: go });

  groups.push({
    label: "Archivo",
    items: [{ kind: "ficha", icon: "File", text: "Ver ficha del archivo" }],
  });
  return groups;
}
