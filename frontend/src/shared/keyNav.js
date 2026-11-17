/* Puro: navegacion por teclado en listas (de resultados y virtual). */
export function nextIndexForKey(key, current, count, page = 0) {
  if (!count) return current;
  const step = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }[key];
  if (step) return Math.max(0, Math.min(count - 1, current + step));
  return key === "Home" ? 0 : key === "End" ? count - 1 : current;
}

/* Mueve el foco al indice destino. `count` es el total (el DOM de la lista
   virtual solo trae una ventana); `after` permite desplazar antes de enfocar. */
export function listKey(e, rowSel, count, page = 0, after) {
  if (e.defaultPrevented || !/^(ArrowDown|ArrowUp|PageDown|PageUp|Home|End)$/.test(e.key)) return;
  const row = e.target.closest?.(rowSel);
  if (!row) return;
  const rows = [...e.currentTarget.querySelectorAll(rowSel)];
  const i = row.dataset.index != null ? +row.dataset.index : rows.indexOf(row);
  const next = nextIndexForKey(e.key, i, count || rows.length, page);
  if (next === i) return;
  e.preventDefault();
  if (after) after(next);
  else rows[next].focus({ preventScroll: true });
}
