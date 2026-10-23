import { useCallback, useEffect, useState } from "react";
import { requestSearch } from "../download/searchRequest.js";
import GenreMap from "./GenreMap.jsx";
import { decodeMap } from "./map.js";
import "./discover.css";

/* El mapa se pide una vez por sesion (el archivo viaja con la app, ver ADR
   0003) y se decodifica a arreglos tipados. Si falla se olvida la promesa para
   que "Reintentar" vuelva a pedirlo. No se importa como modulo: son datos, no
   codigo, y asi no engordan el chunk. */
let mapPromise = null;
function loadMap() {
  if (!mapPromise) {
    mapPromise = fetch(`${import.meta.env.BASE_URL}genre-map.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`genre-map.json: HTTP ${r.status}`);
        return r.json();
      })
      .then(decodeMap)
      .catch((e) => {
        mapPromise = null;
        throw e;
      });
  }
  return mapPromise;
}

/* Sesion 23: aca entran los indices de los generos que el usuario escucha
   (se cruzan con data.mb). Vacio hasta que haya historial. */
const NO_USER_GENRES = new Set();

/* Pantalla de Descubrir. Las recomendaciones llegan en la sesion 23. */
export default function DiscoverView({ onOpenDownload }) {
  const [state, setState] = useState({ status: "loading", data: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    loadMap().then(
      (data) => alive && setState({ status: "ready", data }),
      () => alive && setState({ status: "error", data: null })
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: "loading", data: null });
    setAttempt((n) => n + 1);
  }, []);

  /* Primero el pedido y luego el cambio de pantalla: Descargar lo toma al
     montarse o en cuanto se avisa. */
  const searchGenre = useCallback(
    (name) => {
      requestSearch(name);
      onOpenDownload?.();
    },
    [onOpenDownload]
  );

  return (
    <>
      <h1 className="sr-only">Descubrir</h1>
      {state.status === "ready" ? (
        <GenreMap data={state.data} highlight={NO_USER_GENRES} onSearchGenre={searchGenre} />
      ) : state.status === "error" ? (
        <div className="gmap gmap--state" role="alert">
          <div>
            <p className="gmap__msg">No se pudo cargar el mapa de géneros.</p>
            <button type="button" className="gmap__go gmap__retry" onClick={retry}>
              Reintentar
            </button>
          </div>
        </div>
      ) : (
        <div className="gmap gmap--state" role="status" aria-label="Cargando el mapa de géneros">
          <div>
            <div className="gmap__pulse" aria-hidden="true" />
            <p className="gmap__msg">Cargando el mapa de géneros…</p>
          </div>
        </div>
      )}
    </>
  );
}
