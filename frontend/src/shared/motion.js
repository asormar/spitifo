/* ---------------------------------------------------------------------------
   MOVIMIENTO REDUCIDO (U-motion-interaction-3)

   Un solo sitio decide si una animacion corre. El CSS ya baja todo a 1ms con
   `prefers-reduced-motion`, pero JS seguia esperando 180-500ms antes de avisar
   de que algo termino: el elemento ya era invisible y todavia bloqueaba el
   siguiente toque. Aqui `motion(ms)` devuelve 0 en ese caso y `motionAfter`
   llama a la funcion en el MISMO tick, sin temporizador colgado.
   ------------------------------------------------------------------------- */

export const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Duracion real de una animacion: 0 con movimiento reducido, `ms` si no. */
export function motion(ms) {
  return reducedMotion() ? 0 : ms;
}

/* Programa `fn` tras `ms`, o ahora mismo si el movimiento esta reducido.
   Devuelve siempre una funcion de cancelacion: con 0 no hay temporizador que
   cancelar, pero la firma no cambia para quien la guarda en una ref. */
export function motionAfter(fn, ms) {
  const wait = motion(ms);
  if (!wait) {
    fn();
    return () => {};
  }
  const id = setTimeout(fn, wait);
  return () => clearTimeout(id);
}
