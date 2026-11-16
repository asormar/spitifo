/* ---------------------------------------------------------------------------
   LO QUE DICE EL VEREDICTO DE UN ARCHIVO

   El backend guarda el veredicto y la procedencia al descargar (verdict,
   meta_src, file_src, real) y solo los entrega si el archivo tiene registro.
   Aqui se decide que pastilla y que texto toca, sin inventar nada: un archivo
   sin registro (anterior a guardarlos) es "desconocido", nunca "Coincide".
   Funciones puras: se prueban en Node.

   Claves de pastilla: match | partial | mismatch | unv (+ p30 en Ahora suena).
   ------------------------------------------------------------------------- */

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

export const songsOnly = (entries) => entries.filter((e) => e.kind !== "video");

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
