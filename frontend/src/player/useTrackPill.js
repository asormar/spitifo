import { useListen } from "../listen/ListenProvider.jsx";
import { trackPill } from "../listen/fileCheck.js";

/* La pastilla de la pista que suena (el chip de Ahora suena y la barra del
   escritorio): el veredicto guardado de su archivo, «Sin verificar» si no lo
   tiene, «Solo 30 s» en un avance, y nada en un video. */
export function useTrackPill(track) {
  const { model } = useListen();
  return trackPill(track, track ? model.byKey.get(track.key) : null);
}
