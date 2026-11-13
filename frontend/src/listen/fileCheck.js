import { clock } from "../shared/format.js";

/* ---------------------------------------------------------------------------
   LO QUE DICE EL VEREDICTO DE UN ARCHIVO

   El backend guarda el veredicto y la procedencia al descargar (verdict,
   meta_src, file_src, real) y solo los entrega si el archivo tiene registro.
   Aqui se decide que pastilla y que texto toca, sin inventar nada: un archivo
   sin registro (anterior a guardarlos) es "desconocido", nunca "Coincide".
   Funciones puras: se prueban en Node.

   Claves de pastilla: match | partial | mismatch | unv (+ p30 en Ahora suena).
   ------------------------------------------------------------------------- */

/* De donde viene la ficha o el audio. */
export const SRC = {
  itunes: "iTunes",
  archive: "Internet Archive",
  wikimedia: "Wikimedia",
  jamendo: "Jamendo",
  youtube: "YouTube",
};

const FROM = { match: "match", partial: "partial", mismatch: "mismatch", unknown: "unv" };

/* La pastilla de un registro, o null si no lo hay (archivo anterior) o es un
   video (no lleva pastilla, ni menu, ni ficha). */
export const checkOf = (entry) => (!entry || entry.kind === "video" ? null : FROM[entry.verdict] ?? null);

/* Telefono: la pastilla solo habla cuando algo no esta bien. Un archivo sin
   registro tendria miles de «Sin verificar» grises: ahi no se dice nada. */
export function rowPill(entry) {
  const v = checkOf(entry);
  return v === "match" ? null : v;
}

/* La ficha, el chip y la barra: sin registro, «Sin verificar». */
export const filePill = (entry) => (!entry || entry.kind === "video" ? null : checkOf(entry) ?? "unv");

/* La pastilla de la pista que suena: un avance de 30 s lo es por su tipo; una
   cancion de la biblioteca, por su archivo; lo demas (un video) no lleva. */
export function trackPill(track, entry) {
  if (track?.kind === "preview") return "p30";
  return track?.kind === "library" ? filePill(entry) : null;
}

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

const songsOnly = (entries) => entries.filter((e) => e.kind !== "video");

/* El final de la linea de un album: «Todo coincide» o «3 de 5 coinciden».
   Vacio si ninguna cancion tiene registro. Una sin registro no cuenta como
   coincidencia confirmada. */
export function albumVerdict(entries) {
  const songs = songsOnly(entries || []);
  if (!songs.some((e) => checkOf(e))) return "";
  const k = songs.filter((e) => checkOf(e) === "match").length;
  return k === songs.length ? "Todo coincide" : `${k} de ${songs.length} coinciden`;
}

/* «todas comprobadas» / «3 de 5 comprobadas»: comprobada es una cancion cuyo
   audio se comparo de verdad (Coincide, Parecido o No coincide). Vacio si no
   hay ninguna: una biblioteca anterior no dice nada. */
export function checkedSummary(entries) {
  const songs = songsOnly(entries || []);
  const k = songs.filter((e) => {
    const v = checkOf(e);
    return v && v !== "unv";
  }).length;
  if (!k) return "";
  return k === songs.length ? "todas comprobadas" : `${k} de ${songs.length} comprobadas`;
}
