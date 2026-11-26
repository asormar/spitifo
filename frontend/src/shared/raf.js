/* ---------------------------------------------------------------------------
   COALESCER POR CUADRO

   Envuelve una funcion sin argumentos para que, sin importar cuantas veces se
   la llame dentro del mismo cuadro (un scroll rapido dispara el evento mucho
   mas seguido que 60/120 veces por segundo en algunos dispositivos), corra
   como maximo UNA vez por requestAnimationFrame. VirtualList la usa para que
   medir el scroll (dos getBoundingClientRect, una lectura de layout forzada)
   no se pague en cada evento de scroll, solo una vez por cuadro
   (P-large-library-scale-11). Modulo puro (aparte de rAF/cancelAnimationFrame,
   que existen en jsdom): se prueba en Node con esas dos funciones simuladas.
   ------------------------------------------------------------------------- */

export function rafThrottle(fn) {
  let id = 0;
  const wrapped = () => {
    if (id) return;
    id = requestAnimationFrame(() => {
      id = 0;
      fn();
    });
  };
  wrapped.cancel = () => {
    cancelAnimationFrame(id);
    id = 0;
  };
  return wrapped;
}
