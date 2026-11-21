import { resultMenuGroups } from "../download/resultMenu.js";

/* ---------------------------------------------------------------------------
   MENU ⋯ DE "AHORA SUENA"

   Que menu se abre y que grupos lleva Decide el estado de la pista, no el
   componente: aqui es puro y se prueba en Node. Una cancion con entrada en la
   biblioteca usa el menu de Tu biblioteca; un stream suelto cae al menu de
   resultados de Buscar. Los dos terminan con «Cerrar reproductor».
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

/* Grupos del menu de resultados bajo "Ahora suena": los de Buscar y, al final,
   cerrar el reproductor (la misma accion que la X de la pastilla). */
export function npMenuGroups(t, { fmt = "m4a", downloaded = false } = {}) {
  return [
    ...resultMenuGroups(t, { fmt, downloaded }),
    { label: "Reproductor", items: [{ kind: "closePlayer", icon: "x", text: "Cerrar reproductor" }] },
  ];
}
