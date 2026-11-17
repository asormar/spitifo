/* El chunk de la tarjeta de primera ejecucion. Solo se pide cuando la tarjeta
   va a pintarse de verdad (biblioteca vacia y no descartada), asi el arranque
   no paga ni un byte de aqui. */
export const loadFirstRunChunk = () => import("./FirstRunCard.jsx");
