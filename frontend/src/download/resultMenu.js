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
  { kind: "next", icon: "next", text: "Reproducir a continuación" },
  { kind: "end", icon: "queue", text: "Añadir al final de la cola" },
];

export function resultMenuGroups(t, { downloaded = false, fmt = "m4a" } = {}) {
  const groups = [{ label: "Escuchar", items: PLAY_ITEMS }];

  if (downloaded) {
    groups.push({
      label: "Tu biblioteca",
      items: [{ kind: "downloaded", icon: "check", text: "Descargada", disabled: true }],
    });
  } else if (canDownload(t)) {
    groups.push({
      label: "Tu biblioteca",
      items: [{ kind: "download", icon: "dl", text: "Descargar", sub: fmt }],
    });
  }

  const go = [];
  if (canOpenAlbumSheet(t)) go.push({ kind: "album", icon: "disc", text: `Ir al álbum «${t.album}»` });
  if (t?.artist) go.push({ kind: "artist", icon: "user", text: `Ir a ${t.artist}` });
  if (go.length) groups.push({ label: "Ir a", items: go });

  groups.push({
    label: "Archivo",
    items: [{ kind: "ficha", icon: "file", text: "Ver ficha del archivo" }],
  });
  return groups;
}
