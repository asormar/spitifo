import { fetchErr } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   AVISOS DE BUSCAR (puro, sin React ni DOM)

   El texto que llegaba del fetch se mostraba en ingles crudo y sin salida. Aqui
   se convierte a espanol y se dan los textos de los estados que antes callaban.
   ------------------------------------------------------------------------- */

export const SEARCH_FAIL = "No se pudo buscar. Comprueba la conexión e inténtalo de nuevo.";
export const SHELF_FAIL = "No pudimos cargar artistas y álbumes; las canciones sí están.";
export const OFFLINE_TEXT =
  "Sin conexión: tus descargas siguen disponibles; la búsqueda volverá cuando vuelva la red.";

export const searchErrorText = (e) => fetchErr(e, SEARCH_FAIL);
export const shelfErrorText = () => SHELF_FAIL;
export const offlineText = () => OFFLINE_TEXT;
export const typoHead = (query) => `No encontré nada para «${query}»`;
export const typoBody = () => "Prueba con menos palabras o con el nombre del artista solo.";
