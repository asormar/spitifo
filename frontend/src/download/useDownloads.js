import { useCallback, useEffect, useState } from "react";
import { fetchErr, rowKey } from "../shared/api.js";
import { JOB_DISMISS_MS } from "./constants.js";
import { downloadTrack } from "./downloadTrack.js";
import { noticeFromError, noticeFromJob, noticeFromSuccess } from "./searchPlan.js";

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
        const res = await downloadTrack(t, { query, fmt, media, mode, height });
        setNotice(noticeFromSuccess(res, query));
        setDownloadedIds((cur) => new Set(cur).add(key));
        onLibraryChanged();
      } catch (e) {
        /* Parar una descarga no es un fallo: la hoja ya dice «Cancelada». */
        if (e.cancelled) return;
        if (e.finished) setNotice(noticeFromJob(e.finished));
        else setNotice(noticeFromError(fetchErr(e, e.message), e.cookies === true));
      } finally {
        /* Solo se saca ESTA clave del Set. */
        setBusyIds((cur) => withoutKey(cur, key));
      }
    },
    [fmt, media, mode, query, onLibraryChanged]
  );

  return { onDownload, onBotCheck, busyIds, downloadedIds, notice, clearNotice };
}
