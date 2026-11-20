/* Receta de las portadas generadas (sin imagen): el color sale de la paleta de
   16 colores de genero por un hash estable del artista, y una de 4 tramas suaves
   por un hash del album. Un "tono" empaqueta las dos cosas en un entero
   0..63: color = tono % 16, trama = tono >> 4. El CSS (home.css, .cv) pinta el
   resto con --c y la clase cv-p<trama>. */

export const GENRE_COLORS = 16;
export const PATTERNS = 4;

/* Hash de cadena de 32 bits sin signo. */
export function hash32(text) {
  let h = 0;
  for (const ch of String(text || "")) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0;
  return h;
}

/* "Varios", "Various Artists"...: no es una persona. Si el color saliera de
   ahi, todos los recopilatorios serian la misma portada magenta con una V. */
const GENERIC_ARTIST = /^(?:varios(?: artistas)?|various(?: artists)?|va|artista desconocido|unknown artist|desconocido)$/i;
export const isGenericArtist = (name) => GENERIC_ARTIST.test(String(name || "").trim());

/* De quien es la portada: el artista, o el album cuando el artista es generico. */
export const coverOwner = (artist, album) => (isGenericArtist(artist) && album ? album : artist);

/* Tono de una portada: el color es del artista (todos sus albumes comparten
   color) y la trama, del album; sin album, la trama sale del artista. Con un
   artista generico el color sale del album. */
export function coverTone(artist, album) {
  const who = coverOwner(artist, album) ?? "";
  const color = hash32(who) % GENRE_COLORS;
  const pattern = hash32(album ? `${who}|${album}` : `${who}#`) % PATTERNS;
  return color + GENRE_COLORS * pattern;
}

export const toneColor = (tone) => tone % GENRE_COLORS;
export const tonePattern = (tone) => Math.floor(tone / GENRE_COLORS) % PATTERNS;

/* Lo que el JSX pone en la portada: la variable --c y la clase de la trama. */
export const toneVars = (tone) => ({ "--c": `var(--genre-${toneColor(tone)})` });
export const toneClass = (tone) => `cv-p${tonePattern(tone)}`;
