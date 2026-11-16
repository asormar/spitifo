import { API, errMsg } from "../shared/api.js";
import { queueStore } from "./queueStore.js";
import { verdictStore } from "./verdict.js";

/* ---------------------------------------------------------------------------
   DESCARGA DE UNA PISTA

   Las fuentes que pasan por yt-dlp entran en la cola del servidor con una sola
   peticion: la promesa se resuelve cuando el espejo de /api/downloads ve el item
   terminado (o fallado, o cancelado). Un corte de red ya no la marca como
   fallida: el sondeo del store reintenta y el anillo sigue su estado.

   Las fuentes directas (archive, jamendo, ...) siguen bajando en la misma
   peticion, como siempre.
   ------------------------------------------------------------------------- */

const isQueuedSource = (t) => t.source === "ytdlp" || (t.source === "itunes" && !!t.extra?.webpage_url);

const asSpec = (track, { query, fmt, media, mode, height }) => ({
  source: track.source,
  track,
  fmt,
  ...(mode === "ytdlp" ? { media } : {}),
  ...(mode === "ytdlp" && media !== "audio" && Number.isInteger(height) ? { height } : {}),
  query,
});

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

  if (isQueuedSource(track)) {
    const queued = await queueStore.enqueue({
      items: [asSpec(track, { query, fmt, media, mode, height })],
    });
    const item = queued?.[0];
    if (!item?.id) throw new Error("falló la descarga");
    /* El store ya publico el veredicto al pasar a done; devuelve el mismo
       objeto de siempre para que la fila siga con su aviso. */
    return queueStore.waitForItem(item.id);
  }

  const rd = await fetch(`${API}/download?query=${encodeURIComponent(query)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(asSpec(track, { query, fmt, media, mode, height })),
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

  return finish(j);
}
