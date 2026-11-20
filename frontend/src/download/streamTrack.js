import { API } from "../shared/api.js";
import { trackState } from "./constants.js";

/* ---------------------------------------------------------------------------
   PISTA DE STREAMING

   Lo que el motor necesita para reproducir un resultado sin bajarlo. Funciones
   puras: se prueban en Node sin DOM. La clave lleva la URL para que dos filas
   del mismo video no choquen en la cola.
   ------------------------------------------------------------------------- */

/* Solo se escucha en streaming lo que tiene version completa en YouTube: si no
   hay `webpage_url`, el backend no tiene nada que resolver. */
export const canStream = (t) =>
  trackState(t) === "full" && Boolean(t?.extra?.webpage_url);

export const streamKey = (url) => `stream:${url}`;

export function streamTrack(t, source = null) {
  const url = t.extra?.webpage_url;
  const title = t.title || "sin título";
  const meta = [t.artist || "artista desconocido",
    t.album && t.album !== t.title ? t.album : null].filter(Boolean).join(" · ");
  return {
    key: streamKey(url),
    src: `${API}/stream?url=${encodeURIComponent(url)}`,
    title,
    label: title,
    meta,
    duration: t.duration_s ?? null,
    artwork: t.artwork_url || null,
    kind: "stream",
    result: t,
    source: source || null,
  };
}

/* Internet Archive no tiene preview: el archivo que se bajaria se encuentra
   con la misma verificacion de «¿Es esta la cancion?» y suena directo desde
   archive.org. Solo los que todavia hay que resolver (o ya traen su URL). */
export const canAudition = (t) =>
  t?.source === "archive" && Boolean(t?.extra?.needs_resolve || t?.audio_url);

export const auditionKey = (t) => `archive:${t.source_id}`;

export function auditionTrack(t, audio) {
  const title = t.title || "sin título";
  return {
    key: auditionKey(t),
    src: audio,
    title,
    label: title,
    meta: t.artist || "artista desconocido",
    duration: t.duration_s ?? null,
    artwork: t.artwork_url || null,
    kind: "stream",
    result: t,
  };
}

/* La cola son los resultados de la misma lista con version completa, en orden.
   Asi "siguiente" sigue sonando del mismo sitio (Buscar, un album...). */
export function streamQueue(results, t, source = null) {
  const lista = (Array.isArray(results) ? results : []).filter(canStream);
  const index = lista.findIndex((x) => x.extra.webpage_url === t?.extra?.webpage_url);
  if (index < 0) {
    const one = streamTrack(t, source);
    return { queue: [one], index: 0 };
  }
  return { queue: lista.map((x) => streamTrack(x, source)), index };
}
