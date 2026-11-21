import { rowKey } from "../shared/api.js";
import { engine } from "../player/engine.js";
import { canOpenAlbumSheet, npLinks } from "../player/npLinks.js";
import { resolveArtistLink } from "./artistLink.js";
import { resultTrackFor } from "./resultPlayback.js";
import { queueStore } from "./queueStore.js";
import { trackSpec } from "./albumText.js";

/* ---------------------------------------------------------------------------
   QUE HACE CADA OPCION DEL MENU ⋯ DE UNA CANCION

   La fila de Buscar, la de un album y la de Populares comparten el menu y sus
   acciones. Cada superficie inyecta lo que hace distinto (descargar, abrir el
   album, ir al artista); aqui solo se cierra el menu y se mandan las comunes.
   ------------------------------------------------------------------------- */

export async function pickResultAction(kind, {
  t, query = "", name = "", source = null,
  onDownload, onAlbum, onArtist, show, nav, anchor,
} = {}) {
  if (!t) return;
  nav.back();
  if (kind === "download") {
    if (onDownload) return onDownload(t, anchor);
    if (t.extra?.webpage_url) queueStore.enqueue({ items: [trackSpec(t, name)] });
    else show?.("Solo hay 30 s de esta canción");
  } else if (kind === "ficha") {
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
