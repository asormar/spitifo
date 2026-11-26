/* ---------------------------------------------------------------------------
   UNA SOLA ACCION PARA «NUEVA LISTA» (fase 14)

   Las listas viven en Tu biblioteca. El riel de PC, la casilla del telefono,
   el estante y la propia pagina «Ver todo» llaman a esta misma funcion: el
   destino es la pagina de listas con el campo de nombre abierto. Antes habia
   tres codigos distintos, uno de ellos sin pasar por la navegacion.
   ------------------------------------------------------------------------- */

export const NEW_LIST_VIEW = Object.freeze({ type: "all", what: "lists", naming: true });

export function openNewList(nav, ctx) {
  /* `ctx.goTo` sustituye la entrada de arriba (la pagina de listas sigue
     siendo la misma, solo cambia el foco), por eso no deja historial nuevo. */
  if (ctx?.goTo) {
    ctx.goTo(NEW_LIST_VIEW);
    return;
  }
  nav.goTo("library", NEW_LIST_VIEW);
}
