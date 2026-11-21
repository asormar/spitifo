/* ---------------------------------------------------------------------------
   CLAVE Y TIPO DEL MENU ⋯ DE "AHORA SUENA"

   Decide el estado de la pista, no el componente: aqui es puro y se prueba en
   Node. Solo lo importa NowPlaying. Los grupos del menu de resultados (que si
   necesitan resultMenuGroups) viven en download/npResultGroups.js, del lado de
   Overlays, para que las dos vistas perezosas no compartan este modulo.
   ------------------------------------------------------------------------- */

/* La clave del menu: la de la fila de la biblioteca, o la ficha guardada, o
   el sid del stream. Siempre la misma que usara la fila al abrir el menu. */
export function npMenuKey({ library, byKey, record, key, sid }) {
  return library || byKey.has(key) ? key : record?.file_key || sid || key;
}

/* "menu" = el de Tu biblioteca; "npmenu" = el de resultados; null = no hay
   ⋯ que abrir (no hay entrada ni resultado que pueda alimentar el menu). */
export function npMenuKind({ byKey, record, result, menuKey }) {
  const key = menuKey ?? record?.file_key;
  if (byKey.has(key) || record) return "menu";
  if (result) return "npmenu";
  return null;
}
