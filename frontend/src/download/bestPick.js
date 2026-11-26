import { fold } from "../listen/library.js";

/* ---------------------------------------------------------------------------
   MEJOR RESULTADO (pura, sin React ni DOM)

   Se puntua la primera pagina: titulo exacto > artista exacto > difuso. Antes
   solo se armaba la tarjeta cuando el texto nombraba por entero al primer
   artista, asi que buscar el titulo de una cancion no daba tarjeta y los demas
   modos se quedaban sin estantes. Ahora gana el tipo que de verdad coincidio.
   ------------------------------------------------------------------------- */

const same = (a, b) => Boolean(a && b && fold(a) === fold(b));

const asArray = (x) => (Array.isArray(x) ? x.filter(Boolean) : []);

const songOf = (t) => ({
  kind: "song",
  item: t,
  title: t.title || "sin título",
  sub: [t.artist, t.album].filter(Boolean).join(" · "),
  artwork_url: t.artwork_url || null,
  verdict: "match",
});

const artistOf = (a) => ({
  kind: "artist",
  item: a,
  title: a.name || "sin artista",
  sub: a.genre || "",
  artwork_url: a.artwork_url || null,
  verdict: null,
});

const albumOf = (a) => ({
  kind: "album",
  item: a,
  title: a.title || "sin álbum",
  sub: a.artist || "",
  artwork_url: a.artwork_url || null,
  verdict: null,
});

/* `album` se clasifica como en vivo solo cuando el backend lo marca asi; el
   texto del titulo no basta para cambiarle el tipo a una busqueda. */
const isLive = (a) => a?.extra?.is_live === true;

export function pickBest({ artists = [], albums = [], results = [], query = "" } = {}) {
  const q = String(query ?? "").trim();
  if (!q) return null;
  const songs = asArray(results);
  const ars = asArray(artists);
  const abs = asArray(albums);

  const exactSong = songs.find((t) => same(q, t.title));
  if (exactSong) return songOf(exactSong);

  const exactArtist = ars.find((a) => same(q, a.name));
  if (exactArtist) return artistOf(exactArtist);

  const exactAlbum = abs.find((a) => same(q, a.title));
  if (exactAlbum) return albumOf(exactAlbum);

  /* Difuso acotado: empieza por lo escrito. El orden de las listas ya es el
     ranking de iTunes, asi que no se reordena. */
  const key = fold(q);
  const starts = (v) => fold(v).startsWith(key);
  const fuzzySong = songs.find((t) => starts(t.title) || starts(t.artist));
  if (fuzzySong) return { ...songOf(fuzzySong), verdict: null };

  const fuzzyArtist = ars.find((a) => starts(a.name));
  if (fuzzyArtist) return artistOf(fuzzyArtist);

  const fuzzyAlbum = abs.find((a) => starts(a.title));
  return fuzzyAlbum ? albumOf(fuzzyAlbum) : null;
}
