import { ownedEntries, trackSlot } from "../download/albumText.js";
import { trackState } from "../download/constants.js";
import { needsResolve } from "../download/resolveResult.js";
import { songIdOf } from "../shared/songId.js";

/* ---------------------------------------------------------------------------
   LOGICA DE GUARDAR

   Lo que decide el corazon, el boton del disco y la pestana Ficha, sin React ni
   DOM: se prueba en Node. Un archivo de la biblioteca cuenta como guardado, asi
   que la foto del registro y las filas se miran juntas antes de pintar nada.
   ------------------------------------------------------------------------- */

/* Un resultado de Buscar se puede guardar si suena entero, si hay que resolverlo
   (guardar ya resuelve) o si ya trae una identidad estable. El avance suelto de
   iTunes, sin archivo ni resolucion, no se puede guardar: no hay cancion que
   identificar. Puro, sin React ni DOM. */
export const canSaveResult = (t) => Boolean(t) && (
  trackState(t) === "full" || needsResolve(t) || Boolean(songIdOf(t))
);

/* El corazon existe donde hay una cancion guardable, aunque la fila suene solo
   30 s mientras llega la completa. La pista del motor que ES un avance sigue sin
   el: ahi no hay cancion que guardar todavia. */
export function heartState({ kind = null, full = false, saved = false, owned = false } = {}) {
  if (kind === "preview" || !full) return { show: false, filled: false };
  return { show: true, filled: Boolean(saved || owned) };
}

/* La fila de la biblioteca que ya es esta cancion, si la hay: por el id
   guardado (con archivo vivo, la fila es la del archivo) o por el hueco del
   disco de iTunes. NO por titulo y artista: el corazon lleno quita la cancion
   y borra su archivo, y «Creep» en directo no es «Creep». Con `byKey` (el mapa
   de la biblioteca) el id se busca sin recorrer todas las filas. */
export function ownedEntryFor(t, entries = [], savedById = null, byKey = null) {
  if (!t) return null;
  const id = songIdOf(t);
  if (id) {
    const record = savedById?.get?.(id);
    const find = (k) => (byKey ? byKey.get(k) : entries.find((e) => e.key === k || e.sid === k));
    const hit = (record?.file_key && find(record.file_key)) || find(id);
    if (hit) return hit;
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
