import { createRequestSlot } from "../shared/requestSlot.js";

/* Pedido de genero desde otra pantalla (un atajo de Buscar): abrir Descubrir
   con ese genero elegido en el mapa. Descubrir lo consume al montarse o en
   cuanto se avisa (ver searchRequest.js, el camino contrario). */
const slot = createRequestSlot();

export const requestGenre = slot.request;
export const takeGenre = slot.take;
export const subscribeGenre = slot.subscribe;
