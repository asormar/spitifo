import { albumId, artistId } from "../listen/library.js";

/* ---------------------------------------------------------------------------
   ARTISTA Y ALBUM EN "AHORA SUENA"

   A donde lleva tocar cada nombre. Una cancion de la biblioteca va a sus
   paginas de Escuchar; una en streaming o un avance, a la pagina del artista
   en iTunes y a la ficha del disco (las mismas de Buscar). Puro, sin React,
   para probarlo en Node. Sin destino, el nombre se pinta como texto.
   ------------------------------------------------------------------------- */

const UNKNOWN = new Set(["", "varios", "artista desconocido", "desconocido"]);

export function npLinks(track, entry) {
  if (entry) {
    return {
      artist: entry.artist && !UNKNOWN.has(entry.artist.trim().toLowerCase())
        ? { name: entry.artist, tab: "library", view: { type: "artist", id: artistId(entry) } }
        : null,
      album: entry.album
        ? { name: entry.album, tab: "library", view: { type: "album", id: albumId(entry) } }
        : null,
    };
  }
  const r = track?.result;
  if (!r) return { artist: null, album: null };
  const x = r.extra || {};
  const name = (r.artist || "").trim();
  let artist = null;
  if (name && !UNKNOWN.has(name.toLowerCase())) {
    artist = x.artist_id != null
      ? { name, tab: "search", view: { type: "itunesartist", id: x.artist_id, name } }
      /* Sin id: se busca el nombre y solo vale una coincidencia exacta. */
      : { name, resolve: true };
  }
  const album = r.album && x.collection_id != null
    ? {
      name: r.album,
      sheet: {
        type: "albumsheet",
        id: String(x.collection_id),
        from: "listen",
        album: {
          id: x.collection_id,
          title: r.album,
          artist: name,
          year: r.year,
          track_count: x.track_count,
          artwork_url: r.artwork_url,
        },
      },
    }
    : null;
  return { artist, album };
}

/* Un resultado solo lleva a una ficha de album si npLinks pudo construirla:
   hace falta `extra.collection_id`. La usa «Ahora suena» y el menu ⋯ de Buscar
   para que «Ir al álbum» no aparezca cuando no abriria nada. */
export const canOpenAlbumSheet = (t) => Boolean(npLinks({ result: t }, null).album?.sheet);
