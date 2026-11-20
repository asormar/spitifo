import { API, errMsg } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   RESOLUCION DE UN RESULTADO

   El mismo pedido que hace la descarga (downloadTrack.js) cuando una ficha de
   iTunes o de Internet Archive todavia no trae el archivo: /api/resolve decide
   la URL definitiva. Lo comparten guardar y bajar, asi que no hay dos caminos.
   Modulo sin React ni DOM: se prueba en Node.
   ------------------------------------------------------------------------- */

/* Igual que en downloadTrack: un resultado de iTunes con webpage_url ya esta
   matcheado y una pista de YouTube no necesita resolver. */
export function needsResolve(t) {
  const matched = t?.source === "itunes" && Boolean(t?.extra?.webpage_url);
  return Boolean(
    t?.extra?.needs_resolve &&
      !t.audio_url &&
      !matched &&
      t.source !== "ytdlp" &&
      !t.extra?.webpage_url
  );
}

/* Devuelve el resultado tal cual si ya tiene identidad, o la respuesta de
   /api/resolve. `downloadable` lo decide el servidor: no viaja de vuelta. */
export async function resolveResult(t, query = "", fetchFn = (...a) => fetch(...a)) {
  if (!needsResolve(t)) return t;
  const r = await fetchFn(`${API}/resolve?query=${encodeURIComponent(query || "")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(t),
  });
  if (!r.ok) {
    throw new Error(errMsg(await r.json().catch(() => ({})), "no se pudo resolver"));
  }
  const d = await r.json();
  const out = { ...d };
  delete out.downloadable;
  return out;
}
