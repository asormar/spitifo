/* ---------------------------------------------------------------------------
   BORRADO DIFERIDO

   El aviso de borrado tiene "Deshacer": la peticion real solo se envia si la
   ventana del aviso termina sin que lo deshagan. Si la app se cierra antes, se
   descarta sin disparar: no se borra nada, que es justo lo que se quiere.
   Puro (sin React ni DOM) para poder probarlo con temporizadores falsos.
   ------------------------------------------------------------------------- */

export function createDeferred(run) {
  let timer = null;
  let closed = false;

  return {
    start(ms) {
      if (closed || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        closed = true;
        run();
      }, ms);
    },
    /* Otro aviso pisa a este, o la pagina se desmonta: lo que esperaba se
       ejecuta ya. Cancelarlo dejaria la fila oculta sin borrar el archivo. */
    flush() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      closed = true;
      run();
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      closed = true;
    },
    get pending() {
      return timer !== null;
    },
  };
}
