import { mixName } from "../listen/mixes.js";

/* ---------------------------------------------------------------------------
   LO QUE DICE "AHORA SUENA"

   Textos de la vista que salen del estado del motor, sin DOM: se prueban en
   Node.

   `source` es "tipo:nombre" y lo pone quien lanza la cola (engine.play):
     album:X  artist:X  list:X  search:X  mix:clave  library:  library:Etiqueta
   El nombre es todo lo que sigue al primer ":" (puede llevar mas).
   ------------------------------------------------------------------------- */

/* La meta de una pista es "artista · album" (el album puede faltar). */
export function splitMeta(meta = "") {
  const at = meta.indexOf(" · ");
  return at < 0
    ? { artist: meta, album: "" }
    : { artist: meta.slice(0, at), album: meta.slice(at + 3) };
}

const HEAD = "Sonando desde";

/* { head, name } de "Sonando desde". Sin origen (o con uno vacio) una cancion
   de la biblioteca cae al album y, sin album, al artista; un avance de 30 s no
   viene de ningun sitio de la biblioteca. */
export function sourceCaption(source, track) {
  const { artist, album } = splitMeta(track?.meta);
  if (track?.kind === "preview") return { head: "Avance de 30 s", name: artist };

  const at = typeof source === "string" ? source.indexOf(":") : -1;
  const kind = at < 0 ? "" : source.slice(0, at);
  const name = at < 0 ? "" : source.slice(at + 1).trim();

  if (kind === "library") return { head: HEAD, name: name || "Tu biblioteca" };
  if (kind === "mix" && name) return { head: HEAD, name: `Mezcla · ${mixName(name)}` };
  if (kind === "search" && name) return { head: HEAD, name: `Resultados de «${name}»` };
  if ((kind === "album" || kind === "artist" || kind === "list") && name) {
    return { head: HEAD, name };
  }
  return { head: HEAD, name: album || artist };
}

/* La nota al final de la cola. Una cola sin fin (las mezclas) da la vuelta
   sola, sin repeat. */
export const queueNote = ({ repeat, endless }) =>
  repeat === "all" || endless ? "Al terminar vuelve a empezar." : "No hay nada más en la cola.";
