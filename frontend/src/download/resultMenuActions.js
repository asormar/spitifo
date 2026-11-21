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
   acciones. Las dependencias llegan por parametro: ninguna pantalla decide aqui
   como se encola, se avisa ni se cierra el menu (nav.back).
   ------------------------------------------------------------------------- */

export async function pickResultAction(kind, { t, query = "", name = "", enqueue, show, nav, anchor } = {}) {
  if (!t) return;
  nav.back();
  if (kind === "download") {
    if (t.extra?.webpage_url) {
      if (enqueue) enqueue(t);
      else queueStore.enqueue({ items: [trackSpec(t, name)] });
    } else {
      show?.("Solo hay 30 s de esta canción");
    }
  } else if (kind === "ficha") {
    nav.open({ type: "ficha", key: rowKey(t), t, anchor });
  } else if (kind === "next" || kind === "end") {
    const pista = await resultTrackFor(t, { query });
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
    nav.open({ ...npLinks({ result: t }, null).album.sheet, anchor });
  } else if (kind === "artist") {
    const view = await resolveArtistLink(t.artist, [
      { artist: t.artist, artist_id: t.extra?.artist_id },
    ]);
    if (view) nav.goTo("search", view);
    else show?.(`No se encontró la página de ${t.artist}`);
  }
}
