import { useCallback, useRef } from "react";
import { GoogleDriveLogo, HardDrives, Stack } from "@phosphor-icons/react";
import { API, keyUrl } from "../shared/api.js";
import { fmtSize } from "../shared/format.js";
import Player from "./Player.jsx";
import VideoRow from "./VideoRow.jsx";

export default function Library({ libFiles, libReady, libCount, libErr, libErrCode, health, onOpenStorage, onRetry }) {
  /* AUTO-ADVANCE Y PREFETCH DE LA BIBLIOTECA

     Las filas del cajon son <Player> independientes y el cajon no se desmonta,
     asi que "seguir con la de abajo" necesita hablar con la fila VECINA. El
     mapa indice -> <audio> lo llena cada Player al montarse (`registerAudio`):
     nada de buscar en el DOM por selectores.

     `startLibTrack` adelanta el SIGUIENTE tema con POST /api/prefetch, sin
     esperar respuesta (si falla, no pasa nada: al final se bajara igual). El
     guardia evita repetir la misma clave dos veces seguidas, que es lo que
     pasa al reanudar una pausa. */
  const libAudio = useRef(new Map());
  const prefetched = useRef(null);

  const registerLibAudio = useCallback((n, el) => {
    if (el) libAudio.current.set(n, el);
    else libAudio.current.delete(n);
  }, []);

  const startLibTrack = (n) => {
    const next = libFiles[n + 1];
    if (!next || prefetched.current === next.key) return;
    prefetched.current = next.key;
    fetch(`${API}/prefetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: next.key }),
    }).catch(() => {});
  };

  const endLibTrack = (n) => {
    const next = libAudio.current.get(n + 1);
    /* La ultima fila solo se detiene, como siempre. */
    if (next) next.play().catch(() => {});
  };

  return (
          <div className="drawer__in">
            <section className="panel">
              <div className="panel__head">
                <h2 className="panel__title">
                  <Stack size={17} />
                  Tu biblioteca
                  <span className="count">{libCount}</span>
                </h2>
                {health?.library && (
                  <button
                    type="button"
                    className="panel__store"
                    onClick={() => onOpenStorage()}
                    title="Cambiar dónde se guarda tu música"
                  >
                    {/^Google Drive/.test(health.library) ? (
                      <GoogleDriveLogo size={15} aria-hidden="true" />
                    ) : (
                      <HardDrives size={15} aria-hidden="true" />
                    )}
                    <span className="panel__path">{health.library}</span>
                  </button>
                )}
              </div>
              <div className="panel__body">
                {libReady && libCount === 0 && (
                  <p className="panel__empty">Todavía no has descargado nada.</p>
                )}
                {!libReady && libErr && (
                  <p className="panel__empty" role="alert">
                    {libErrCode === "reconnect_required" ? (
                      <>
                        Tu sesión de Google Drive ha caducado.
                        <br />
                        <button
                          type="button"
                          className="vf"
                          onClick={() => onOpenStorage()}
                        >
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
                )}
                {libFiles.map((f, n) =>
                  f.kind === "video" ? (
                    /* Una fila de video no tiene controles de audio: se abre en
                       el VideoHost. Misma lista y mismo indice que las de audio. */
                    <VideoRow key={f.key} f={f} index={n} />
                  ) : (
                    <Player
                      key={f.key}
                      src={keyUrl(f.key)}
                      label={f.filename}
                      title={f.filename}
                      meta={`${f.folder}${f.size_mb != null ? ` · ${fmtSize(f.size_mb)}` : ""}`}
                      duration={f.duration_s}
                      index={n}
                      registerAudio={registerLibAudio}
                      onStart={() => startLibTrack(n)}
                      onEnded={() => endLibTrack(n)}
                    />
                  )
                )}
              </div>
            </section>
          </div>
  );
}
