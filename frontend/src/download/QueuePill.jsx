import { useEffect } from "react";
import { activeGroup, groupSummary as serverSummary, useQueueState } from "./queueStore.js";
import { OFFLINE_PILL } from "./albumText.js";
import { loadAlbumChunk } from "./albumChunk.js";
import "./queuePill.css";

/* ---------------------------------------------------------------------------
   PILDORA DE LA COLA

   Vive en el shell, sobre el mini-reproductor o la barra del escritorio, en
   cualquier modo. Solo lee el espejo de la cola: no descarga nada y no carga
   el chunk de las hojas hasta que se la enfoca o se pasa el raton por encima.
   Mientras se ve, los avisos suben por encima de ella (body.has-queue).
   ------------------------------------------------------------------------- */

export default function QueuePill({ onOpen }) {
  const queue = useQueueState();
  const group = activeGroup(queue.groups);
  const on = Boolean(group);

  useEffect(() => {
    document.body.classList.toggle("has-queue", on);
    return () => document.body.classList.remove("has-queue");
  }, [on]);

  if (!group) return null;
  const s = serverSummary(group);
  const f = s.total ? s.done / s.total : 0;
  const text = queue.offline ? OFFLINE_PILL : `${group.title} · ${s.done} de ${s.total}`;

  return (
    <button
      type="button"
      className="qpike"
      aria-label={queue.offline ? `Descargas: ${OFFLINE_PILL}` : `Descargas: ${text}`}
      onPointerEnter={loadAlbumChunk}
      onFocus={loadAlbumChunk}
      onClick={(e) => onOpen(e.currentTarget)}
    >
      <span className="qpike__t">{text}</span>
      <span className="qpike__bar" aria-hidden="true">
        <i style={{ transform: `scaleX(${f})` }} />
      </span>
    </button>
  );
}
