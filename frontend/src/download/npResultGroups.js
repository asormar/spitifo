import { CLOSE_PLAYER_GROUP, resultMenuGroups } from "./resultMenuActions.js";

/* ---------------------------------------------------------------------------
   GRUPOS DEL MENU ⋯ DE UN STREAM SUELTO EN "AHORA SUENA"

   Los de Buscar y, al final, cerrar el reproductor (la misma accion que la X
   de la pastilla). Vive aqui, en el grafo de Overlays: la clave y el tipo del
   menu que usa NowPlaying estan en player/npMenu.js y no importan estos grupos.
   Asi resultMenuGroups solo tiene un importador en este grafo y no se parte en
   un chunk compartido entre las dos vistas perezosas.
   ------------------------------------------------------------------------- */

export function npMenuGroups(t, { fmt = "m4a", downloaded = false } = {}) {
  return [...resultMenuGroups(t, { fmt, downloaded }), CLOSE_PLAYER_GROUP];
}
