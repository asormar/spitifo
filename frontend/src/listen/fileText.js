import { clock } from "../shared/format.js";
import { checkOf, songsOnly } from "./fileCheck.js";

/* Los textos de un archivo (ficha, hoja, album): solo lo cargan las pantallas que
   los muestran, no el arranque. Las pastillas viven en fileCheck.js. */

/* De donde viene la ficha o el audio. */
export const SRC = {
  itunes: "iTunes",
  archive: "Internet Archive",
  wikimedia: "Wikimedia",
  jamendo: "Jamendo",
  youtube: "YouTube",
};

/* "Procedencia": «iTunes», o «Ficha: iTunes · Archivo: YouTube» si difieren. */
export function provText(entry) {
  const meta = SRC[entry?.metaSrc];
  if (!meta) return "";
  const file = SRC[entry.fileSrc];
  return file && file !== meta ? `Ficha: ${meta} · Archivo: ${file}` : meta;
}

/* La frase bajo la pastilla. `card`: la tarjeta de Ahora suena (con la
   duracion); sin ella, la hoja del archivo. Con audio de YouTube se comparo el
   titulo del video, no las etiquetas: decir «etiquetas» seria falso. */
export function checkText(entry, { card = false } = {}) {
  const v = checkOf(entry);
  const title = entry?.title;
  if (v === "match") {
    if (entry.fileSrc === "youtube") return `El título del vídeo coincide con la ficha: «${title}».`;
    if (card) {
      const time = entry.duration ? `, ${clock(Math.round(entry.duration))}` : "";
      return `El audio es «${title}»${time}, igual que la ficha.`;
    }
    return `Leímos las etiquetas del audio: es «${title}», igual que la ficha.`;
  }
  if (v === "partial" || v === "mismatch") {
    if (entry.real) return `En el archivo dice «${entry.real}».`;
    return v === "partial" ? "Se parece, pero no es exactamente lo que buscaste." : "No es lo que buscabas.";
  }
  if (v === "unv") return "No se pudo leer el título del audio.";
  return "Todavía no se ha comprobado el audio.";
}

/* El final de la linea de un album: «Todo coincide» o «3 de 5 coinciden».
   Vacio si ninguna cancion tiene registro. Una sin registro no cuenta como
   coincidencia confirmada. */
export function albumVerdict(entries) {
  const songs = songsOnly(entries || []);
  if (!songs.some((e) => checkOf(e))) return "";
  const k = songs.filter((e) => checkOf(e) === "match").length;
  return k === songs.length ? "Todo coincide" : `${k} de ${songs.length} coinciden`;
}
