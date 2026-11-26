import { Icon } from "../shared/icons.jsx";
import { engine } from "./engine.js";
import { useEngine } from "./useEngine.js";
import { useOnline } from "../shared/online.js";
import { offlineNotice } from "../listen/offline.js";
import "./streamErrors.css";

/* ---------------------------------------------------------------------------
   AVISO DE UN STREAM (R2-robustez)

   El motor ya publica `buffering`/`stalled`/`failed`; aca solo se traduce a lo
   que ve el usuario. Panel propio (no el toast de Notice.jsx): "red lenta" no
   tiene una duracion fija y el fallo se queda hasta que se resuelve, no 5 s.
   Nunca tapa los controles (mismo sitio que .lnotice, por encima del
   mini-reproductor). Solo para streams (YouTube, Internet Archive): un archivo
   de la biblioteca tiene su propio camino de error.
   ------------------------------------------------------------------------- */

export default function StreamErrors() {
  const track = useEngine((s) => s.track);
  const stalled = useEngine((s) => s.stalled);
  const failed = useEngine((s) => s.failed);
  const online = useOnline();

  if (track?.kind !== "stream" || (!stalled && !failed)) return null;

  /* Recarga la pista actual (una peticion nueva, no resume() sobre el mismo
     audio): una URL de stream caducada necesita volver a resolverse. */
  const retry = () => engine.reloadAt(engine.getState().time);
  const title = track.title || "esta canción";

  if (failed) {
    const offline = !online;
    return (
      <div className="stream-note">
        <span className="stream-note__card is-err" role="alert">
          <Icon name="Warning" size="md" />
          {offline ? (
            <span>{offlineNotice({ title })}</span>
          ) : (
            <>
              <span>No se pudo seguir reproduciendo.</span>
              <button type="button" className="stream-note__act" onClick={retry}>
                Reintentar
              </button>
            </>
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="stream-note">
      <span className="stream-note__card" role="status">
        <Icon name="Warning" size="md" />
        <span>Red lenta. Seguimos esperando…</span>
      </span>
    </div>
  );
}
