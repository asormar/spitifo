import { rowKey } from "../shared/api.js";
import { useQueueState } from "../download/queueStore.js";

/* ---------------------------------------------------------------------------
   LO QUE LLEVA EL REPRODUCTOR CUANDO SUENA UN STREAM

   Solo se monta cuando la pista actual es un stream (en la pastilla y la barra
   se carga perezosamente). El anillo de descarga ya no vive aqui: bajar una
   cancion es una opcion del menu ⋯, no un boton del transporte.
   ------------------------------------------------------------------------- */

function useItem(track) {
  const state = useQueueState();
  const t = track?.result;
  const key = t ? rowKey(t) : null;
  return key ? state.items.find((i) => i.rk === key) || null : null;
}

export function StreamBadge({ track }) {
  const item = useItem(track);
  const saved = item?.status === "done";
  return <span className={saved ? "spill spill--ok" : "spill"}>{saved ? "Guardada" : "En streaming"}</span>;
}
