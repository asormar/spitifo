import { rowKey } from "../shared/api.js";
import { engine } from "../player/engine.js";
import { canOpenAlbumSheet, npLinks } from "../player/npLinks.js";
import { resolveArtistLink } from "./artistLink.js";
import { resultTrackFor } from "./resultPlayback.js";

/* ---------------------------------------------------------------------------
   QUE HACE CADA OPCION DEL MENU ⋯ DE UNA CANCION

   La fila de Buscar, la de un album y la de Populares comparten el menu y sus
   acciones. Cada superficie inyecta lo que hace distinto (descargar, abrir el
   album, ir al artista); aqui solo se cierra el menu y se mandan las comunes.
   ------------------------------------------------------------------------- */

export async function pickResultAction(kind, {
  t, query = "", source = null,
  onDownload, onAlbum, onArtist, onFicha, show, nav, anchor, closeMenu = true,
} = {}) {
  if (!t) return;
  /* El menu de "Ahora suena" cierra la hoja y la vista en un solo unwind, asi
     que sus acciones «Ir a» no pueden pedir aqui un back por separado. */
  if (closeMenu) nav.back();
  if (kind === "download") {
    return onDownload?.(t, anchor);
  } else if (kind === "ficha") {
    if (onFicha) return onFicha(t, anchor);
    nav.open({ type: "ficha", key: rowKey(t), t, anchor });
  } else if (kind === "next" || kind === "end") {
    const pista = await resultTrackFor(t, { query, source });
    if (!pista) return show?.("No se pudo añadir a la cola");
    const idle = !engine.getState().track;
    const done = kind === "next" ? engine.playNext(pista) : engine.enqueue(pista);
    show?.(
      idle
        ? "Reproduciendo"
        : !done
        ? "Ya está en la cola"
        : kind === "next"
        ? "Sonará a continuación"
        : "Añadida a la cola"
    );
  } else if (kind === "album" && canOpenAlbumSheet(t)) {
    if (onAlbum) return onAlbum(t, anchor);
    nav.open({ ...npLinks({ result: t }, null).album.sheet, anchor });
  } else if (kind === "artist") {
    if (onArtist) return onArtist(t, anchor);
    const view = await resolveArtistLink(t.artist, [
      { artist: t.artist, artist_id: t.extra?.artist_id },
    ]);
    if (view) nav.goTo("search", view);
    else show?.(`No se encontró la página de ${t.artist}`);
  }
}
