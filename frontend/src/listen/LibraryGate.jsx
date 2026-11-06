import { useNav } from "../app/useNav.js";
import { useListen } from "./ListenProvider.jsx";

/* ---------------------------------------------------------------------------
   ESTADOS DE LA BIBLIOTECA

   Inicio y Tu biblioteca dependen de la misma lista de archivos: mientras llega
   se pintan esqueletos, si falla se ofrece reintentar (o reconectar Drive) y si
   esta vacia se manda a Buscar. Solo con la biblioteca lista se pinta el
   contenido.
   ------------------------------------------------------------------------- */

/* Filas de esqueleto mientras llega la biblioteca. */
const skeleton = (n) =>
  Array.from({ length: n }, (_, i) => (
    <div key={i} className="lskel skel skel--pulse" style={{ "--i": i }} aria-hidden="true">
      <span className="art" />
      <span className="lskel__t" />
    </div>
  ));

export default function LibraryGate({ ready, error, errorCode, onRetry, children }) {
  const nav = useNav();
  const { model } = useListen();

  if (!ready) {
    if (!error) {
      return (
        <div className="lpanel" aria-busy="true">
          {skeleton(8)}
        </div>
      );
    }
    /* Reconectar si caduco la sesion de Drive, reintentar si no. */
    return (
      <p className="lnote" role="alert">
        {errorCode === "reconnect_required" ? (
          <>
            Tu sesión de Google Drive ha caducado.
            <br />
            <button type="button" className="vf" onClick={() => nav.openSettings("storage")}>
              Volver a conectar
            </button>
          </>
        ) : (
          <>
            No se pudo cargar la biblioteca.
            <br />
            <button type="button" className="vf" onClick={onRetry}>
              Reintentar
            </button>
          </>
        )}
      </p>
    );
  }

  if (!model.entries.length) {
    return (
      <p className="lnote">
        Todavía no has descargado nada.
        <br />
        <button type="button" className="vf" onClick={() => nav.goTab("search")}>
          Ir a Buscar
        </button>
      </p>
    );
  }

  return children;
}
