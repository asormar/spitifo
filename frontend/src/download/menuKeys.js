/* ---------------------------------------------------------------------------
   TECLAS DE UN MENU

   Flechas recorren los items, Inicio y Fin saltan a los extremos. Cada menu
   elige su selector: el de resultados salta los deshabilitados y el de
   resoluciones (sin items deshabilitados) toma todos. Escape y el atras los
   cierra la pila de navegacion, no este modulo.
   ------------------------------------------------------------------------- */

const KEYS = { ArrowDown: 1, ArrowUp: -1 };

export function menuKeys(e, root, selector = '[role="menuitem"]') {
  const items = [...root.querySelectorAll(selector)];
  if (!items.length) return;
  const at = items.indexOf(document.activeElement);
  const to =
    e.key in KEYS
      ? (at + KEYS[e.key] + items.length) % items.length
      : e.key === "Home"
      ? 0
      : e.key === "End"
      ? items.length - 1
      : null;
  if (to === null) return;
  e.preventDefault();
  items[to].focus();
}
