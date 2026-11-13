import { becauseText, clock, fmtSize } from "../shared/format.js";
import { fold } from "../listen/library.js";
import { SRC, provText } from "../listen/fileCheck.js";
import { plural } from "../listen/home.js";
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

/* --- Ficha del archivo ------------------------------------------------------ */

/* "m4a" de "Tema (live).m4a"; vacio si no hay extension. */
const extOf = (filename) => {
  const name = String(filename || "");
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
};

/* "el 7 de noviembre", y con el ano si no es el actual. `modified`: segundos. */
function downloadedOn(seconds, now) {
  if (!(seconds > 0)) return "";
  const d = new Date(seconds * 1000);
  const year = d.getFullYear() !== now.getFullYear();
  const text = d.toLocaleDateString("es", { day: "numeric", month: "long", ...(year && { year: "numeric" }) });
  return `el ${text}`;
}

/* Las filas de la ficha de una cancion de la biblioteca: [{ k, v, mono }].
   Solo lo que de verdad se sabe: cada dato que falta se omite (sin raya ni
   "desconocido"). `full` (la pestana Ficha) suma el nombre del archivo y la
   fecha; `sheet` (la hoja del menu) lleva el nombre pero no la fecha ni las
   escuchas. Con registro guardado, la ficha dice de donde salen los datos:
   «Procedencia» en la tarjeta; «Ficha» y «Archivo» por separado en la pestana y
   la hoja. `entry` es la fila normalizada de la biblioteca; `storage`, donde
   se guarda la musica ("Google Drive" o "este dispositivo"). */
export function fileFacts(entry, { plays = 0, storage = "", now = new Date(), full = false, sheet = false } = {}) {
  if (!entry) return [];
  const rows = [];
  const split = full || sheet;
  if (SRC[entry.metaSrc]) {
    if (split) {
      rows.push({ k: "Ficha", v: SRC[entry.metaSrc] });
      rows.push({ k: "Archivo", v: SRC[entry.fileSrc] || SRC[entry.metaSrc] });
    } else {
      rows.push({ k: "Procedencia", v: provText(entry) });
    }
  }
  const audio = [
    extOf(entry.filename),
    entry.sizeMb == null ? "" : fmtSize(entry.sizeMb),
    entry.duration ? clock(Math.round(entry.duration)) : "",
  ].filter(Boolean);
  if (audio.length) rows.push({ k: "Audio", v: audio.join(" · ") });
  if (storage) rows.push({ k: "Guardado en", v: storage[0].toUpperCase() + storage.slice(1) });
  if (split && entry.filename) rows.push({ k: "Nombre", v: entry.filename, mono: true });
  const when = full ? downloadedOn(entry.added, now) : "";
  if (when) rows.push({ k: "Descargado", v: when });
  if (!sheet && plays > 0) rows.push({ k: "Escuchada", v: plural(plays, "reproducción", "reproducciones") });
  return rows;
}

/* --- Si te gusta, prueba ---------------------------------------------------- */

/* La foto de "Para ti" que Descubrir dejo en el dispositivo
   ({ genres, artists }). Se lee directa y sin pedir nada: importar reco.js
   traeria al chunk el de Descubrir y su mapa. null = no hay (o no se puede
   leer). La clave es la de reco.js. */
const RECO_KEY = "spitifo:reco";

export function readReco(storage = typeof localStorage === "undefined" ? null : localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem(RECO_KEY));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

const words = (name) => fold(name).replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/* `a` aparece en `b` como palabras enteras (o son iguales): "Nick Cave" esta en
   "Nick Cave & The Bad Seeds"; "Eco" no esta en "Ecos". */
function inside(a, b) {
  const x = words(a);
  const y = words(b);
  return Boolean(x) && Boolean(y) && ` ${y} `.includes(` ${x} `);
}

/* Un mismo artista escrito de otra forma (en un sentido o en el otro). */
const same = (a, b) => inside(a, b) || inside(b, a);

/* Hasta 3 artistas de "Para ti" cuya razon nombra a `artist`: [{ name, reason }].
   Sin el mismo artista con otro nombre ni "[unknown]". Sin datos, []. */
export function relatedTo(artist, reco, limit = 3) {
  const list = Array.isArray(reco?.artists) ? reco.artists : [];
  if (!words(artist)) return [];
  const out = [];
  for (const c of list) {
    const name = typeof c?.name === "string" ? c.name : "";
    const why = Array.isArray(c?.because) ? c.because.filter((s) => typeof s === "string" && s) : [];
    if (!words(name) || fold(name) === "[unknown]" || same(name, artist)) continue;
    if (!why.some((w) => same(w, artist))) continue;
    out.push({ name, reason: becauseText(why) });
    if (out.length === limit) break;
  }
  return out;
}
