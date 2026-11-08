import { createRequestSlot } from "../shared/requestSlot.js";

/* Pedido de busqueda desde otra pantalla (el mapa de generos de Descubrir, la
   barra de arriba). Buscar lo consume al montarse o en cuanto se avisa. */
const slot = createRequestSlot();

export const requestSearch = slot.request;
export const takeSearch = slot.take;
export const subscribeSearch = slot.subscribe;
