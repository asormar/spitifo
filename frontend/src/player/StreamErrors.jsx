import { useEffect, useRef } from "react";
import { useShow } from "../listen/Notice.jsx";
import { useEngine } from "./useEngine.js";

/* ---------------------------------------------------------------------------
   AVISO DE FALLO DE UN STREAM

   El motor ya publica `failed`; aca solo se traduce al aviso de la app. Un
   aviso por intento: se rearma cuando el fallo desaparece o cambia de pista.
   ------------------------------------------------------------------------- */

export default function StreamErrors() {
  const show = useShow();
  const track = useEngine((s) => s.track);
  const failed = useEngine((s) => s.failed);
  const avisado = useRef(null);

  useEffect(() => {
    if (!failed) {
      avisado.current = null;
      return;
    }
    if (track?.kind !== "stream" || avisado.current === track.key) return;
    avisado.current = track.key;
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const texto = offline
      ? "Sin conexión: esta canción no está guardada"
      : `No se pudo reproducir «${track.title || "esta canción"}»`;
    show(texto);
  }, [failed, track, show]);

  return null;
}
