/* ---------------------------------------------------------------------------
   CACHES CON TOPE

   Varios Map/Set a nivel de modulo (portadas, formatos, avisos de fallo...)
   viven toda la sesion y antes no tenian limite: una sesion larga los hacia
   crecer sin parar. Esto les pone un tope fijo con desalojo FIFO (se tira la
   clave mas vieja), que para un cache de "ya lo pedi" o "esto fallo" es
   suficiente: no hace falta un LRU real, solo dejar de crecer.

   Puras, sin window ni document: se prueban en Node.
   ------------------------------------------------------------------------- */

/* Pone `value` en `set` y, si se pasa de `cap`, saca la mas vieja. */
export function addBoundedSet(set, value, cap) {
  set.add(value);
  if (set.size > cap) set.delete(set.values().next().value);
}

/* Pone `key`/`value` en `map` y, si se pasa de `cap`, saca la mas vieja. */
export function setBoundedMap(map, key, value, cap) {
  map.set(key, value);
  if (map.size > cap) map.delete(map.keys().next().value);
}
