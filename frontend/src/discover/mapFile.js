/* ---------------------------------------------------------------------------
   ARCHIVO DEL MAPA DE GENEROS

   genre-map.json viaja con la app (ver ADR 0003) y se pide una vez por sesion.
   Vive aparte del chunk de Descubrir para que App lo pida en el mismo gesto que
   el chunk (los dos viajan en paralelo en vez de uno tras otro). Solo se pide
   cuando el usuario abre Descubrir: nunca antes.

   No se importa como modulo: son datos, no codigo, y asi no engordan ningun
   chunk. Si falla, se olvida la promesa para que "Reintentar" vuelva a pedirlo.
   ------------------------------------------------------------------------- */

let file = null;

/* El JSON ya leido y analizado (columnas sin decodificar). Pedirlo antes de
   tiempo es un adelanto: un fallo no se avisa (quien lo adelanta lo ignora) y
   la pantalla lo vuelve a intentar, y lo muestra, cuando lo necesite. */
export function fetchMapFile() {
  if (!file) {
    file = fetch(`${import.meta.env.BASE_URL}genre-map.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`genre-map.json: HTTP ${r.status}`);
        return r.json();
      })
      .catch((e) => {
        file = null;
        throw e;
      });
  }
  return file;
}

/* Un archivo que no tiene el formato esperado se olvida junto con el error. */
export function forgetMapFile() {
  file = null;
}
