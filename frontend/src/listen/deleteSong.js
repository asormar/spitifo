import { engine } from "../player/engine.js";
import { deleteKeys, failedNotice } from "./deletion.js";
import { saved } from "./saved.js";
import { saveNotice } from "./saveLogic.js";

/* ---------------------------------------------------------------------------
   BORRADO CON DESHACER

   Vivia en Overlays.jsx, pero el corazon de Buscar y el de "Ahora suena" tienen
   que quitar canciones sin arrastrarse con ellos el chunk de los menus: por eso
   esta aqui, con sus dependencias pequeñas (deleteKeys, saved y el motor).
   ------------------------------------------------------------------------- */

/* La misma secuencia para una cancion y para un album: ocultar las filas ya
   (archivos e ids guardados), ensenar el aviso con Deshacer y mandar las
   peticiones SOLO si vence la ventana. Si falla algo, vuelve solo lo que no
   se pudo quitar. */
export function deferredDelete({ files = [], sids = [], name, notice, show, hideKeys, restoreFiles, refreshLibrary }) {
  const allKeys = [...files, ...sids];
  const removed = hideKeys(allKeys);
  show(notice, {
    label: "Deshacer",
    run: () => restoreFiles(removed),
    commit: async () => {
      try {
        const bad = new Set();
        if (files.length) {
          const { failed } = await deleteKeys(files);
          failed.forEach((f) => bad.add(f.key));
        }
        /* Android puede aceptar el borrado de un archivo de otra app sin
           hacerlo. Manda lo que liste la biblioteca al recargar: lo que siga
           ahi no se borro, diga lo que diga la respuesta. Ademas suelta las
           claves pendientes, guardadas incluidas. */
        const fresh = await refreshLibrary({ release: allKeys });
        if (fresh) fresh.forEach((f) => files.includes(f.key) && bad.add(f.key));
        const savedOk = !sids.length || (!bad.size && (await saved.remove(sids)));
        const back = [
          ...removed.filter((r) => !r.song && bad.has(r.key)),
          ...(savedOk ? [] : removed.filter((r) => r.song)),
        ];
        if (back.length) {
          restoreFiles(back);
          show(failedNotice(name));
          return;
        }
        const ok = files.filter((k) => !bad.has(k));
        if (ok.length) engine.purge(ok);
      } catch {
        restoreFiles(removed);
        show(failedNotice(name));
      }
    },
  });
}

/* "Quitar de tu biblioteca" de una sola entrada: con archivo se borra tambien
   y el aviso lo dice; sin archivo solo sale del registro de guardadas. */
export function removeEntry(entry, { show, hideKeys, restoreFiles, refreshLibrary }) {
  if (!entry) return;
  const files = entry.downloaded ? [entry.key] : [];
  const sids = entry.sid ? [entry.sid] : [];
  deferredDelete({
    files,
    sids,
    name: entry.title || "sin título",
    notice: saveNotice.removed(entry.title || "sin título", files.length > 0),
    show,
    hideKeys,
    restoreFiles,
    refreshLibrary,
  });
}
