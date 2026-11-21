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

/* «Ir a <artista>» sin id espera una busqueda en la red. El menu se desmonta
   con el primer atras, asi que un ref suyo no sirve para saber si sigue abierto:
   el token lo da el padre (App), que sobrevive al desmontaje. Si el usuario se
   movio mientras se resolvia, no se navega NI se muestra el aviso del fallo.
   El resolver se inyecta para probar la carrera sin red. */
export async function goToArtistWhenCurrent({
  name, entries = [], resolve = resolveArtistLink, locationToken, onView, onMiss,
} = {}) {
  const token = locationToken?.();
  const view = await resolve(name, entries);
  if (locationToken && locationToken() !== token) return false;
  if (view) onView?.(view);
  else onMiss?.(name);
  return true;
}

export async function pickResultAction(kind, {
  t, query = "", source = null,
  onDownload, onAlbum, onArtist, onFicha, show, nav, anchor, closeMenu = true, locationToken,
  resolveArtist = resolveArtistLink,
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
    return goToArtistWhenCurrent({
      name: t.artist,
      entries: [{ artist: t.artist, artist_id: t.extra?.artist_id }],
      locationToken,
      resolve: resolveArtist,
      onView: (view) => nav.goTo("search", view),
      onMiss: (name) => show?.(`No se encontró la página de ${name}`),
    });
  }
}
