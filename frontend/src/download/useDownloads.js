import { useCallback, useEffect, useState } from "react";
import { API, errMsg, fetchErr, rowKey } from "../shared/api.js";
import { JOB_DISMISS_MS } from "./constants.js";
import { pollJob } from "./api.js";
import { setJobFor } from "./jobsStore.js";
import { noticeFromError, noticeFromJob, noticeFromSuccess } from "./searchPlan.js";
import { verdictStore } from "./verdict.js";

/* ---------------------------------------------------------------------------
   DESCARGAS DE LA PANTALLA

   Resolver el resultado, pedir la descarga, seguir su job y decir como acabo.
   El estado de CADA descarga queda bajo su clave: con dos a la vez cada una
   enciende y apaga su propio indicador, tiene su toast y anuncia su resultado
   sin pisar a la otra. El aviso (`notice`) es uno solo a proposito: es el
   ultimo mensaje de la pantalla, no uno por fila.
   ------------------------------------------------------------------------- */

const withoutKey = (set, key) => {
  const next = new Set(set);
  next.delete(key);
  return next;
};

export default function useDownloads({ query, mode, fmt, media, runs, onLibraryChanged }) {
  /* Con varias descargas en curso el Set guarda TODAS las claves: apagar la de
     una no toca la de las demas. */
  const [busyIds, setBusyIds] = useState(() => new Set());
  /* Claves de lo que ya se bajo en esta sesion: la fila lo marca con un check
     (sigue siendo pulsable para volver a descargar). */
  const [downloadedIds, setDownloadedIds] = useState(() => new Set());
  const [notice, setNotice] = useState(null);

  const clearNotice = useCallback(() => setNotice(null), []);

  /* Una busqueda nueva retira el aviso de la anterior. */
  useEffect(() => {
    setNotice(null);
  }, [runs]);

  /* El aviso de exito se retira solo, con el mismo temporizador que el toast de
     progreso. NO se retiran el error ni el "esto no es lo que buscabas" ni el
     "sigue corriendo": son informacion que hay que leer. */
  useEffect(() => {
    if (notice?.tone !== "ok") return undefined;
    const id = setTimeout(() => setNotice(null), JOB_DISMISS_MS);
    return () => clearTimeout(id);
  }, [notice]);

  /* El muro de verificacion de YouTube desde el menu de resoluciones: mismo
     aviso y misma salida que una descarga (importar cookies.txt). */
  const onBotCheck = useCallback((msg) => setNotice(noticeFromError(msg, true)), []);

  const onDownload = useCallback(
    async (t, height) => {
      const key = rowKey(t);
      setBusyIds((cur) => new Set(cur).add(key));
      setNotice(null);
      try {
        let track = { ...t };
        delete track.downloadable;
        // Las pistas del setlist ya vienen resueltas por /api/setlist.
        // En modo "matched" el video de YouTube ya viene en webpage_url:
        // no hay nada que resolver, la descarga va directo a yt-dlp.
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
        // /api/setlist devuelve el veredicto en la raiz, /api/resolve en extra
        const vmatch = t.match || track.extra?.match || track.match;
        const vtitle = t.real_title || track.extra?.real_title || track.real_title;
        const rd = await fetch(`${API}/download?query=${encodeURIComponent(query)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: track.source,
            track,
            fmt,
            /* Solo el modo YouTube sabe bajar video. En el resto el cuerpo
               queda exactamente como estaba. */
            ...(mode === "ytdlp" ? { media } : {}),
            /* Altura elegida en el menu. Solo viaja cuando se baja video: en
               audio el backend no la espera (y "Mejor disponible" = omitirla). */
            ...(mode === "ytdlp" && media !== "audio" && Number.isInteger(height) ? { height } : {}),
          }),
        });
        const j = await rd.json();
        if (!rd.ok) throw Object.assign(new Error(errMsg(j, "falló la descarga")), { cookies: j.code === "youtube_bot_check" });

        const done = (d) => {
          const match = d.match || vmatch;
          const real = d.real_title || vtitle;
          setNotice(noticeFromSuccess({ filename: d.filename, size_mb: d.size_mb, match, real_title: real }, query));
          /* Sin veredicto (fuente que no lo calcula) la fila sigue «Sin verificar». */
          if (match) verdictStore.setFromDownload(t, query, { match, real_title: real });
          setDownloadedIds((cur) => new Set(cur).add(key));
          onLibraryChanged();
        };

        // yt-dlp devuelve job_id: la descarga corre en background, hacer polling
        if (j.job_id) {
          setJobFor(key, { status: "pending", progress: 0, title: t.title });
          const finished = await pollJob(j.job_id, setJobFor, key, t.title);
          if (finished?.status === "timeout" || finished?.status === "gone" || finished?.status === "error") {
            setNotice(noticeFromJob(finished));
          } else if (finished) {
            // El veredicto lo publica el backend DENTRO del job (lo calcula
            // en download contra el titulo real del video).
            done({
              ...j,
              ...finished,
              filename: finished.filename || finished.key,
              match: finished.match || j.match,
              real_title: finished.real_title || j.real_title,
            });
          }
          return;
        }

        done(j);
      } catch (e) {
        setNotice(noticeFromError(fetchErr(e, e.message), e.cookies === true));
      } finally {
        /* Solo se saca ESTA clave del Set. */
        setBusyIds((cur) => withoutKey(cur, key));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fmt, media, mode, query]
  );

  return { onDownload, onBotCheck, busyIds, downloadedIds, notice, clearNotice };
}
