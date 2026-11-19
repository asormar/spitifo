import { rowKey } from "../shared/api.js";
import { trackSpec } from "../download/albumText.js";
import { BUSY_STATES, queueStore, useQueueState } from "../download/queueStore.js";
import DlRing from "../download/DlRing.jsx";

/* ---------------------------------------------------------------------------
   LO QUE LLEVA EL REPRODUCTOR CUANDO SUENA UN STREAM

   Solo se monta cuando la pista actual es un stream (en la pastilla y la barra
   se carga perezosamente). La descarga entra en la MISMA cola del servidor que
   usa Buscar: no hay logica nueva ni se toca la reproduccion.
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

export function StreamDownload({ track }) {
  const item = useItem(track);
  const t = track?.result;
  if (!t) return null;
  return (
    <DlRing
      t={t}
      small
      busy={BUSY_STATES.has(item?.status)}
      downloaded={item?.status === "done"}
      onDl={(one) => {
        queueStore.enqueue({ items: [trackSpec(one, "")] });
      }}
    />
  );
}
