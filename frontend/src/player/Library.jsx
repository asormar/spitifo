import { useMemo } from "react";
import { GoogleDriveLogo, HardDrives, Stack } from "@phosphor-icons/react";
import { keyUrl } from "../shared/api.js";
import { fmtSize } from "../shared/format.js";
import Player from "./Player.jsx";
import VideoRow from "./VideoRow.jsx";

export default function Library({ libFiles, libReady, libCount, libErr, libErrCode, health, onOpenStorage, onRetry }) {
  /* COLA DE LA BIBLIOTECA

     La cola es la biblioteca SIN videos, armada aca y pasada a cada fila. El
     motor la copia cuando una fila arranca, asi que recargar la lista no corta
     lo que esta sonando, y el avance automatico salta los videos: un video no
     se reproduce dentro de la lista, se abre en el VideoHost. */
  const queue = useMemo(
    () =>
      libFiles
        .filter((f) => f.kind !== "video")
        .map((f) => ({
          key: f.key,
          src: keyUrl(f.key),
          title: f.filename,
          label: f.filename,
          meta: `${f.folder}${f.size_mb != null ? ` · ${fmtSize(f.size_mb)}` : ""}`,
          duration: f.duration_s,
          kind: "library",
        })),
    [libFiles]
  );

  /* Misma identidad de objeto que la cola: el Player la usa para reconocer su
     pista sin recorrer el arreglo en cada fila. */
  const trackByKey = useMemo(() => new Map(queue.map((t) => [t.key, t])), [queue]);

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
                       el VideoHost. Mismo indice (retardo de la cascada) que
                       las filas de audio. */
                    <VideoRow key={f.key} f={f} index={n} />
                  ) : (
                    <Player
                      key={f.key}
                      track={trackByKey.get(f.key)}
                      queue={queue}
                      index={n}
                    />
                  )
                )}
              </div>
            </section>
          </div>
  );
}
