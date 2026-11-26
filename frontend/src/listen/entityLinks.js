import { albumId, artistId, fold } from "./library.js";

/* ---------------------------------------------------------------------------
   UN DESTINO POR ENTIDAD (fase 14)

   Los ids son los mismos que usan groupArtists/groupAlbums al construir el
   indice: un nombre resuelve a una sola pagina, venga del menu ⋯, de los
   metadatos de una fila, de una ficha de album o de "Ahora suena".
   ------------------------------------------------------------------------- */

export function artistView(name, entries = []) {
  if (typeof name !== "string" || !name.trim()) return null;
  const local = entries.some((e) => fold(e.artist) === fold(name));
  if (!local) return null;
  return { type: "artist", id: artistId({ artist: name }), name };
}

export function albumView(artist, album) {
  if (!album) return null;
  return { type: "album", id: albumId({ artist, album }), name: album, artist };
}

/* Los artistas relacionados salen de los datos de recomendacion que ya hay
   (nombre, generos y motivo): se descarta el propio artista y se ordena por
   coincidencia de genero y por el peso del candidato. */
export function relatedArtists(name, artists = [], limit = 6) {
  if (!name || !Array.isArray(artists)) return [];
  const mine = new Set(fold(name).split(/\s+/));
  return artists
    .filter((a) => a && a.name && fold(a.name) !== fold(name))
    .map((a) => {
      const genres = Array.isArray(a.genres) ? a.genres.map(fold) : [];
      const shared = genres.filter((g) => mine.has(g) || g.includes(fold(name))).length;
      return { name: a.name, score: (a.score || 0) + shared * 10, because: a.because || [] };
    })
    .filter((a) => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
