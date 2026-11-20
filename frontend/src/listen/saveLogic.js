import { ownedEntries, trackSlot } from "../download/albumText.js";
import { trackState } from "../download/constants.js";
import { fold } from "./library.js";
import { songIdOf } from "../shared/songId.js";

/* ---------------------------------------------------------------------------
   LOGICA DE GUARDAR

   Lo que decide el corazon, el boton del disco y la pestana Ficha, sin React ni
   DOM: se prueba en Node. Un archivo de la biblioteca cuenta como guardado, asi
   que la foto del registro y las filas se miran juntas antes de pintar nada.
   ------------------------------------------------------------------------- */

/* El corazon solo existe donde suena una cancion completa. Un avance de 30 s no
   tiene corazon, y un resultado sin version completa tampoco. */
export function heartState({ kind = null, full = false, saved = false, owned = false } = {}) {
  if (kind === "preview" || !full) return { show: false, filled: false };
  return { show: true, filled: Boolean(saved || owned) };
}

/* La fila de la biblioteca que ya es esta cancion, si la hay. Primero el id
   guardado (con archivo vivo, la fila es la del archivo), despues el hueco del
   disco y, para los archivos sin etiquetas, el titulo y el artista. */
export function ownedEntryFor(t, entries = [], savedById = null) {
  if (!t) return null;
  const id = songIdOf(t);
  if (id) {
    const record = savedById?.get?.(id);
    if (record?.file_key) {
      const withFile = entries.find((e) => e.key === record.file_key);
      if (withFile) return withFile;
    }
    const byId = entries.find((e) => e.sid === id || e.key === id);
    if (byId) return byId;
  }
  const collection = t.extra?.collection_id ?? t.extra?.collectionId;
  if (collection != null) {
    const slots = ownedEntries(entries, collection);
    const slot = trackSlot(
      t.extra?.disc_number ?? t.extra?.disc_no,
      t.extra?.track_number ?? t.extra?.track_no
    );
    const at = slot && slots.get(slot);
    if (at) return at;
  }
  const title = fold(t.title);
  const artist = fold(t.artist);
  if (title && artist) {
    return entries.find((e) => fold(e.title) === title && fold(e.artist) === artist) || null;
  }
  return null;
}

/* El resultado es guardable si suena entero (el match del disco ya trae el id;
   los pendientes de resolver se resuelven al guardar). Lo que ya esta en la
   biblioteca o en el registro no se vuelve a guardar. */
export function albumSaveSelection(tracks = [], { savedIds = null, owned = null } = {}) {
  return (tracks || []).filter((t) => {
    if (!t || trackState(t) !== "full") return false;
    const id = songIdOf(t);
    if (!id || savedIds?.has?.(id)) return false;
    const slot = trackSlot(t.extra?.disc_number, t.extra?.track_number);
    if (slot && owned?.has?.(slot)) return false;
    return true;
  });
}

export function albumSaveButton(n) {
  return n > 0
    ? { text: "Guardar álbum", disabled: false }
    : { text: "Guardado", disabled: true };
}

/* La pestana Ficha: el avance mantiene su nota, un stream dice de donde suena
   y si esta guardado, y una cancion de la biblioteca sigue con su tarjeta. */
export function fichaText({ kind = null, source = null, saved = false, sid = null } = {}) {
  if (kind === "preview") {
    return { note: "Este audio es un avance de 30 s: no está en tu biblioteca." };
  }
  if (kind !== "stream") return null;
  const youtube = source === "ytdlp" || source === "youtube" || String(sid || "").startsWith("yt:");
  return {
    where: `Suena en streaming desde ${youtube ? "YouTube" : "Internet Archive"}`,
    saved: saved ? "Guardada en tu biblioteca" : "No está en tu biblioteca",
    link: Boolean(saved && sid),
  };
}

/* Con el ajuste apagado, o con la cancion ya bajada, no se encola nada. */
export const shouldEnqueue = ({ enabled = false, downloaded = false } = {}) =>
  Boolean(enabled && !downloaded);

export const saveNotice = {
  ok: "Guardada en tu biblioteca",
  fail: (name) => `No se pudo guardar «${name}»`,
  album: (n, name) => `Se guardaron ${n} ${n === 1 ? "canción" : "canciones"} de «${name}»`,
  removed: (name, file) => `Se quitó «${name}»${file ? " y se borró su archivo" : ""}`,
};
