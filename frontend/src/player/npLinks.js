import { albumId, fold } from "../listen/library.js";

/* ---------------------------------------------------------------------------
   ARTISTA Y ALBUM EN "AHORA SUENA"

   A donde lleva tocar cada nombre. Una cancion de la biblioteca va a la pagina
   GENERAL del artista en iTunes (o se busca por nombre si no tiene id); su
   album sigue yendo a Escuchar. Un streaming o un avance va a iTunes y a la
   ficha del disco (las mismas de Buscar). Un credito con varios artistas se
   parte y cada nombre lleva a su propia pagina. Puro, sin React, para probarlo
   en Node. Sin destino, el nombre se pinta como texto.
   ------------------------------------------------------------------------- */

const UNKNOWN = new Set(["", "varios", "artista desconocido", "desconocido"]);

/* Separadores de colaboracion, igual que split_artists de artistinfo.py: & y ,
   como simbolos, y feat/ft/featuring/con/vs/y/x como palabras con limite y sin
   distinguir mayusculas. El grupo captura el separador para reconstruir el
   credito original sin perder comas ni " feat. ". */
const COLLAB = /(\s*(?:&|,)\s*|\s+\b(?:feat|ft|featuring|con|vs|y|x)\b\.?\s+)/i;

/* Partes de un credito con el separador que las precede: [{ name, sep }], vacio
   en la primera. Solo se parte si TODAS las partes tienen 2 caracteres o mas
   (asi "Malcolm X" queda entero) y se descartan las repetidas. */
export function splitArtistCredit(name) {
  const text = String(name ?? "").trim();
  if (!text) return [];
  const bits = text.split(COLLAB);
  const parts = [];
  for (let i = 0; i < bits.length; i += 2) {
    const part = bits[i].trim();
    if (part) parts.push({ name: part, sep: i === 0 ? "" : bits[i - 1] });
  }
  if (parts.length < 2 || parts.some((p) => p.name.length < 2)) {
    return [{ name: text, sep: "" }];
  }
  const seen = new Set();
  return parts.filter((p) => {
    const key = fold(p.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* Enlace de una parte. El artista principal usa el id de iTunes cuando existe;
   los demas se resuelven siempre por nombre exacto. Los desconocidos no enlazan. */
const partLink = (name, id) =>
  UNKNOWN.has(name.trim().toLowerCase())
    ? null
    : id != null
      ? { name, tab: "search", view: { type: "itunesartist", id, name } }
      : { name, resolve: true };

export function npLinks(track, entry) {
  let artist = null;
  let artists = [];
  let album = null;

  if (entry) {
    const parts = splitArtistCredit(entry.artist);
    artists = parts.map((p, i) => ({ ...p, link: partLink(p.name, i === 0 ? entry.artist_id : null) }));
    artist = artists[0]?.link || null;
    album = entry.album
      ? { name: entry.album, tab: "library", view: { type: "album", id: albumId(entry) } }
      : null;
  } else {
    const r = track?.result;
    if (r) {
      const x = r.extra || {};
      const parts = splitArtistCredit(r.artist);
      artists = parts.map((p, i) => ({ ...p, link: partLink(p.name, i === 0 ? x.artist_id : null) }));
      artist = artists[0]?.link || null;
      album = r.album && x.collection_id != null
        ? {
          name: r.album,
          sheet: {
            type: "albumsheet",
            id: String(x.collection_id),
            from: "listen",
            album: {
              id: x.collection_id,
              title: r.album,
              artist: (r.artist || "").trim(),
              year: r.year,
              track_count: x.track_count,
              artwork_url: r.artwork_url,
            },
          },
        }
        : null;
    }
  }
  return { artist, artists, album };
}

/* Un resultado solo lleva a una ficha de album si npLinks pudo construirla:
   hace falta `extra.collection_id`. La usa «Ahora suena» y el menu ⋯ de Buscar
   para que «Ir al álbum» no aparezca cuando no abriria nada. */
export const canOpenAlbumSheet = (t) => Boolean(npLinks({ result: t }, null).album?.sheet);
