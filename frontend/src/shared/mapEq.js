/* ---------------------------------------------------------------------------
   IGUALDAD DE MAPAS POR CONTENIDO

   saved.js y art.js piden su registro entero en cada recarga forzada (una
   descarga terminada necesita enlazar su archivo con lo guardado en el
   servidor, aunque nada haya cambiado de verdad la mayoria de las veces). Sin
   esto, cada recarga entregaba un Map NUEVO aunque el contenido fuera
   identico, y eso invalidaba el merge de la biblioteca entera en
   ListenProvider (P-large-library-scale-6, P-render-main-thread-7). Modulo
   puro: se prueba en Node.
   ------------------------------------------------------------------------- */

export function sameMap(a, b) {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key)) return false;
    const other = b.get(key);
    if (value === other) continue;
    if (JSON.stringify(value) !== JSON.stringify(other)) return false;
  }
  return true;
}
