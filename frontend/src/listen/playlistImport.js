import { fold } from "./library.js";

/* ---------------------------------------------------------------------------
   IMPORTAR UNA LISTA (sin API de Spotify)

   El usuario exporta su propia cuenta (p. ej. Exportify) y sube el CSV, o
   sube un M3U. spitifo solo lee titulo, artista y album y los busca en la
   biblioteca: lo que no este se muestra como fila pendiente, nunca se mete
   en silencio. Modulo puro, se prueba en Node.
   ------------------------------------------------------------------------- */

/* CSV de verdad: comillas, comas dentro, comillas dobles y saltos de linea
   dentro de un campo. Un CSV senillo partido por `,` romperia titulos. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = String(text ?? "").replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((v) => v !== "")) rows.push(row);
  }
  return rows;
}

const headers = {
  title: ["trackname", "name", "title", "titulo", "track", "song", "cancion"],
  artist: ["artistname", "artist", "artists", "artista", "interprete", "performer"],
  album: ["albumname", "album"],
};

const headerKey = (value) => fold(value).replace(/[^a-z]/g, "");

function columnMap(head) {
  const out = {};
  head.forEach((cell, i) => {
    const key = headerKey(cell);
    for (const [name, aliases] of Object.entries(headers)) {
      if (out[name] === undefined && aliases.some((a) => key.includes(a))) out[name] = i;
    }
  });
  return out;
}

/* Exportify y exportaciones parecidas: solo importan las columnas de texto.
   Sin cabecera reconocible se intenta (titulo, artista, album) por posicion. */
export function parseSpotifyCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const cols = columnMap(rows[0]);
  const hasHeader = Object.keys(cols).length > 0;
  const body = hasHeader ? rows.slice(1) : rows;
  const at = hasHeader ? cols : { title: 0, artist: 1, album: 2 };
  const tracks = [];
  for (const row of body) {
    const title = String(at.title != null ? row[at.title] ?? "" : "").trim();
    if (!title) continue;
    tracks.push({
      title,
      artist: String(at.artist != null ? row[at.artist] ?? "" : "").trim(),
      album: String(at.album != null ? row[at.album] ?? "" : "").trim(),
    });
  }
  return tracks;
}

/* M3U / M3U8: `#EXTINF:segundos,Artista - Titulo`, con `#EXTART` opcional,
   o una ruta que se convierte en nombre de archivo. */
export function parseM3u(text) {
  const tracks = [];
  let artist = "";
  const input = String(text ?? "").replace(/^\uFEFF/, "");
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#EXTM3U")) continue;
    if (line.startsWith("#EXTART:")) { artist = line.slice(8).trim(); continue; }
    if (line.startsWith("#")) {
      if (!line.startsWith("#EXTINF:")) continue;
      const info = line.slice(8).split(",");
      const label = info.slice(1).join(",").trim();
      const parts = label.split(/\s+-\s+/);
      const name = parts.length > 1 ? parts.slice(1).join(" - ") : label;
      artist = parts.length > 1 ? parts[0] : artist;
      if (name) tracks.push({ title: name, artist, album: "" });
      continue;
    }
    if (tracks.length && !tracks[tracks.length - 1].path) {
      tracks[tracks.length - 1].path = line;
      continue;
    }
    const name = line.split(/[\\/]/).pop().replace(/\.[^.]+$/, "") || line;
    tracks.push({ title: name, artist, album: "" });
  }
  return tracks.map(({ title, artist: a, album }) => ({ title, artist: a || "", album: album || "" }));
}

export const parseImport = (text, kind) =>
  kind === "m3u" ? parseM3u(text) : parseSpotifyCsv(text);

/* Busca cada pista importada en la biblioteca. Titulo exacto gana; el artista
   tiene que coincidir si los dos estan presentes (no colgamos un "Despechá"
   cualquiera). Devuelve los indices que no se encontraron. */
export function matchTracks(tracks, entries) {
  const matches = new Map();
  const missing = [];
  const pool = entries || [];
  tracks.forEach((track, i) => {
    const qTitle = fold(track.title);
    const qArtist = fold(track.artist);
    let best = null;
    let bestScore = 0;
    for (const entry of pool) {
      const title = fold(entry.title || "");
      const artist = fold(entry.artist || "");
      if (qArtist && artist && !artist.includes(qArtist) && !qArtist.includes(artist)) continue;
      const score = title === qTitle ? 100
        : title.startsWith(qTitle) ? 70
          : title.includes(qTitle) ? 40 : 0;
      if (score > bestScore) { best = entry; bestScore = score; }
    }
    if (best) matches.set(i, best);
    else missing.push(i);
  });
  return { matches, missing };
}

export const importSummary = (tracks, matches) => ({
  total: tracks.length,
  found: matches.size,
  missing: tracks.length - matches.size,
});
