export const API = "/api";
/* El `detail` de FastAPI no siempre es un string: en un 422 es un array de
   {loc, msg, type}. Con `new Error(detail)` eso se convierte en
   "[object Object]" y el usuario lee eso en el aviso. Aplanar a los `msg`.
   Un string se devuelve tal cual; si no hay nada util, el fallback. */
export function errMsg(d, fallback) {
  const detail = d?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((e) => (typeof e === "string" ? e : e?.msg))
      .filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  return fallback;
}
/* fetch() tira TypeError con "Failed to fetch" (en ingles) cuando el server esta
   caido o se corta la red. Sin esto el usuario lee eso crudo en el aviso. */
export function fetchErr(e, fallback) {
  const m = typeof e?.message === "string" ? e.message : "";
  if (/failed to fetch|networkerror|load failed/i.test(m)) {
    return "No se pudo contactar con el servidor. Esta sigue en marcha?";
  }
  return fallback;
}
/* Una URL que viene del servidor no se pone en `href` sin revisarle el
   esquema.

   Motivo concreto: `item_url` y `webpage_url` vienen de APIs externas
   (archive.org, iTunes, YouTube) y llegan tal cual al DOM. Con
   `javascript:...` en un href, un click ejecuta codigo en el ORIGEN de esta
   pagina, no en el sitio de la URL. No se demostro que hoy exista una URL
   asi —las fuentes actuales no la producen y el HeadlessChrome la bloquea—,
   pero el dato es externo y no verificado: la defensa va aca y no depende de
   que la fuente de hoy sea benigna.

   Solo pasan http/https. Una src relativa tambien, porque la genera la propia
   app. Cualquier otra cosa (javascript:, data:, vbscript:, blob:) devuelve
   null y el link no se renderiza. */
export function safeUrl(u) {
  if (typeof u !== "string") return null;
  const s = u.trim();
  if (!s) return null;
  /* Relativa de un solo slash: la genera la app (ej. /api/audio?key=...).
     Un `//host` NO: es protocol-relativa, y `new URL` la resolveria contra
     el origin dandonos un http:// VALIDO que nunca fue una URL absoluta del
     servidor. Por eso se rechazan las dos barras. */
  if (s.startsWith("/")) return s.startsWith("//") ? null : s;
  /* Sin esquema explicito NO se toca. `new URL("basura", origin)` no lanza:
     la resuelve como ruta relativa y devuelve un http:// propio, o sea,
     ACEPTARIA cualquier cadena sin esquema como si fuera nuestra. Solo pasan
     las que traen http:// o https:// de verdad. */
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const parsed = new URL(s);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}
/* La clave que identifica una fila para el estado de "descargando". Antes se
   usaba `t.source + t.source_id` en Track pero SOLO `s.source_id` en las
   pistas del setlist (ShowGroup), asi que el ahi nunca coincidia con lo que
   guardaba onDownload y su spinner no aparebia nunca. Una sola funcion. */
export const rowKey = (t) => (t?.source || "") + (t?.source_id || "");
/* Todos los bytes de la biblioteca (audio, video o su miniatura) se piden por
   clave al mismo endpoint, que responde con Range. Un solo armador de URL para
   que no haya dos formas de pedir el mismo archivo. */
export const keyUrl = (key) => `${API}/audio?key=${encodeURIComponent(key)}`;
