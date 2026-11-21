/* ---------------------------------------------------------------------------
   CHIP DE COMO SUENA

   Un solo texto para "Ahora suena": de donde viene el audio y si la cancion
   esta en la biblioteca. Sustituye al veredicto junto al titulo, que ahora vive
   en la pestana Ficha. Puro, sin React ni DOM: se prueba en Node.
   ------------------------------------------------------------------------- */

export function playStateText({ kind = null, saved = false } = {}) {
  if (kind === "preview") return "Vista previa de 30 s";
  if (kind === "library") return "Descargada · sin conexión";
  if (kind === "stream") return saved ? "Guardada · en streaming" : "En streaming";
  return null;
}
