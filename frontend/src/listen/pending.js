/* ---------------------------------------------------------------------------
   BORRADOS PENDIENTES

   Una fila borrada se oculta en el acto, pero el archivo sigue en el servidor
   durante la ventana de "Deshacer" y mientras dura la peticion (en Drive, unos
   segundos). Si en ese rato se recarga la biblioteca (termina una descarga),
   la fila volvia a aparecer. Estas claves se filtran de cada recarga hasta que
   el borrado termina o se deshace. Puro, sin React, para probarlo en Node.
   ------------------------------------------------------------------------- */

export function createPendingDeletes() {
  const keys = new Set();
  return {
    hide(list) {
      list.forEach((k) => keys.add(k));
    },
    release(list) {
      (list || []).forEach((k) => keys.delete(k));
    },
    filter(files) {
      return keys.size ? files.filter((f) => !keys.has(f.key)) : files;
    },
    get size() {
      return keys.size;
    },
  };
}
