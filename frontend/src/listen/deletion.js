import { API } from "../shared/api.js";
import { fmtSize } from "../shared/format.js";

/* ---------------------------------------------------------------------------
   BORRADO DE LA BIBLIOTECA

   La peticion se envia al terminar la ventana de "Deshacer" (ver deferred.js).
   Los textos de la hoja de confirmacion son puros para poder probarlos sin un
   montaje de React: el tamano solo se muestra si las filas lo traen.
   ------------------------------------------------------------------------- */

export async function deleteKeys(keys) {
  const r = await fetch(`${API}/library/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys }),
  });
  if (!r.ok) throw new Error(`delete ${r.status}`);
  const d = await r.json();
  return { deleted: d.deleted || [], failed: d.failed || [] };
}

/* La etiqueta de storage que llega de /api/health es "Google Drive" o la ruta
   local; el backend describe la nube con ese mismo prefijo. */
export const isDrive = (storage) => /^Google Drive/.test(storage || "");

export function albumDeleteCopy({ name, storage, count, sizeMb }) {
  const where = isDrive(storage) ? "de tu Drive" : "de este dispositivo";
  const size = Number.isFinite(sizeMb) ? fmtSize(sizeMb) : null;
  return {
    title: `¿Borrar «${name}» ${where}?`,
    body: count === 1
      ? "La canción también sale de las listas donde esté. Puedes descargarla otra vez desde Buscar."
      : "Las canciones también salen de las listas donde estén. Puedes descargarlas otra vez desde Buscar.",
    facts: [
      { label: "Canciones", value: String(count) },
      ...(size === null ? [] : [{ label: "Espacio que se libera", value: size }]),
    ],
    confirm: count === 1 ? "Borrar 1 canción" : `Borrar ${count} canciones`,
  };
}

/* El aviso de fallo conserva el buen proyecto del texto de exito. */
export const failedNotice = (name) => `No se pudo borrar «${name}»`;
