import { exactArtist, artistIdFromEntries } from "./artistLogic.js";
import { searchArtists } from "./artistApi.js";

/* ---------------------------------------------------------------------------
   «MAS DE <ARTISTA>» DESDE ESCUCHAR

   Con el id de iTunes guardado en alguna cancion se abre la pagina directa.
   Si no lo hay, se busca el nombre y solo vale una coincidencia exacta (sin
   tildes ni mayusculas). Sin coincidencia se cae a una busqueda normal.
   ------------------------------------------------------------------------- */

/* Puro: que hacer con una respuesta de /api/artists/search?q=<name>&limit=1. */
export function linkFromSearch(name, results) {
  const hit = exactArtist(name, results);
  return hit ? { type: "itunesartist", id: hit.id, name: hit.name, genre: hit.genre } : null;
}

/* Async: id guardado -> pagina directa; si no, buscar el nombre. Devuelve la
   vista de la pagina o null cuando no se encontro una coincidencia exacta. */
export async function resolveArtistLink(name, entries, search = searchArtists) {
  const id = artistIdFromEntries(entries, name);
  if (id != null) return { type: "itunesartist", id, name };
  try {
    const results = await search(name, 1);
    return linkFromSearch(name, results);
  } catch {
    return null;
  }
}
