import { API, errMsg } from "../shared/api.js";
import { pollJob } from "./api.js";
import { rowKey } from "../shared/api.js";
import { setJobFor } from "./jobsStore.js";
import { verdictStore } from "./verdict.js";

/* ---------------------------------------------------------------------------
   DESCARGA DE UNA PISTA

   El camino de una descarga, sin React: lo llaman las filas (useDownloads) y la
   cola de albumes. Asi el anillo de una pista muestra el MISMO estado venga de
   una fila, de la ficha del album o de la hoja de Descargas: el progreso sigue
   en jobsStore, bajo la clave de la fila (rowKey).
   ------------------------------------------------------------------------- */

export async function downloadTrack(
  t,
  { query = "", fmt = "m4a", media = "audio", mode = "matched", height } = {}
) {
  let track = { ...t };
  delete track.downloadable;
  /* En modo "matched" el video de YouTube ya viene en webpage_url: no hay
     nada que resolver, la descarga va directo a yt-dlp. */
  const isMatched = t.source === "itunes" && t.extra?.webpage_url;
  if (!track.audio_url && !isMatched && t.source !== "ytdlp" && t.extra?.needs_resolve) {
    const rr = await fetch(`${API}/resolve?query=${encodeURIComponent(query)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(track),
    });
    if (!rr.ok) {
      const d = await rr.json();
      throw new Error(errMsg(d, "no se pudo resolver"));
    }
    track = await rr.json();
    delete track.downloadable;
  }
  /* /api/setlist devuelve el veredicto en la raiz, /api/resolve en extra. */
  const vmatch = t.match || track.extra?.match || track.match;
  const vtitle = t.real_title || track.extra?.real_title || track.real_title;
  const rd = await fetch(`${API}/download?query=${encodeURIComponent(query)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: track.source,
      track,
      fmt,
      ...(mode === "ytdlp" ? { media } : {}),
      ...(mode === "ytdlp" && media !== "audio" && Number.isInteger(height) ? { height } : {}),
    }),
  });
  const j = await rd.json();
  if (!rd.ok) {
    const e = new Error(errMsg(j, "falló la descarga"));
    e.cookies = j.code === "youtube_bot_check";
    throw e;
  }

  const finish = (d) => {
    const match = d.match || vmatch;
    const real = d.real_title || vtitle;
    /* Sin veredicto (fuente que no lo calcula) la fila sigue «Sin verificar». */
    if (match) verdictStore.setFromDownload(t, query, { match, real_title: real });
    return { filename: d.filename, size_mb: d.size_mb, match, real_title: real };
  };

  if (j.job_id) {
    const key = rowKey(t);
    setJobFor(key, { status: "pending", progress: 0, title: t.title });
    const finished = await pollJob(j.job_id, setJobFor, key, t.title);
    if (finished?.status === "timeout" || finished?.status === "gone" || finished?.status === "error") {
      /* El llamador distingue un job que dejo de poder seguirse de un fallo
         normal: el primero es un aviso, no una fila en rojo. */
      const e = new Error(finished.error || "la descarga falló");
      e.finished = finished;
      e.cookies = finished.error_code === "youtube_bot_check";
      throw e;
    }
    return finish({
      ...j,
      ...finished,
      filename: finished.filename || finished.key,
      match: finished.match || j.match,
      real_title: finished.real_title || j.real_title,
    });
  }

  return finish(j);
}
