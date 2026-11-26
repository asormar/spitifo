/* ---------------------------------------------------------------------------
   COMPARTIR UNA PAGINA (fase 14)

   La direccion de la pagina ya es canonica: compartir es copiar/abrir esa URL.
   navigator.share cuando el sistema la ofrece; portapapeles como alternativa.
   Un rechazo del usuario no es un error que haya que mostrar.
   ------------------------------------------------------------------------- */

/* URL absoluta de una ruta, con un origen neutro para poder probarla en Node. */
export function absoluteUrl(href, search, origin = "https://spitifo.app") {
  const url = new URL(href || "/", origin);
  url.search = search || "";
  return url.href;
}

export async function shareLink({ title, url, share, write }) {
  const doShare = share ?? globalThis.navigator?.share?.bind(globalThis.navigator);
  const doWrite = write ?? globalThis.navigator?.clipboard?.writeText?.bind(globalThis.navigator.clipboard);
  try {
    if (doShare) {
      await doShare({ title, url });
      return "shared";
    }
    if (doWrite) {
      await doWrite(url);
      return "copied";
    }
  } catch (e) {
    /* Cancelar el dialogo no deja ningun aviso. */
  }
  return "none";
}
