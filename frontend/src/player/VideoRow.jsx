import { useRef, useState } from "react";
import { FilmStrip, Play } from "@phosphor-icons/react";
import { keyUrl } from "../shared/api.js";
import { clock, fmtSize } from "../shared/format.js";
import { openVideo } from "./videoStore.js";

/* ---------------------------------------------------------------------------
   FILA DE VIDEO EN LA BIBLIOTECA

   Misma caja que la fila de audio (.pl) para que la lista no se parta en dos
   lenguajes, pero sin controles de audio: un video no se "reproduce" dentro de
   la lista, se abre. A la derecha va la miniatura 16:9, que ES el boton (con
   su aro de foco y su aria-label); el resto de la fila no es pulsable.
   ------------------------------------------------------------------------- */
function VideoRow({ f, index }) {
  const btnRef = useRef(null);
  /* Miniatura que ya fallo: no se vuelve a pedir (sale el bloque con la
     pelicula). Mismo criterio que la portada de las tarjetas. */
  const [badThumb, setBadThumb] = useState(false);
  const thumb = f.thumb_key && !badThumb ? keyUrl(f.thumb_key) : null;
  const sinAudio = f.has_audio === false;
  const dur = f.duration_s ? clock(Math.round(f.duration_s)) : null;

  const open = () => {
    openVideo(
      {
        src: keyUrl(f.key),
        title: f.filename,
        artist: f.folder,
        hasAudio: !sinAudio,
      },
      btnRef.current
    );
  };

  return (
    <div className="pl pl--video" style={{ "--i": index }}>
      <div className="pl__mid">
        <div className="pl__top">
          <span className="pl__title" title={f.filename}>
            {f.filename}
          </span>
        </div>
        <div className="pl__meta pl__meta--row">
          <span className="pl__tag">
            <FilmStrip size={12} weight="bold" aria-hidden="true" />
            {sinAudio ? "Vídeo sin audio" : "Vídeo"}
          </span>
          {f.folder && <span className="pl__dim">{f.folder}</span>}
          {f.size_mb != null && <span className="pl__dim">{fmtSize(f.size_mb)}</span>}
        </div>
      </div>
      <button
        ref={btnRef}
        type="button"
        className="plthumb"
        onClick={open}
        aria-label="Ampliar el vídeo"
        title="Ampliar el vídeo"
      >
        <span className="plthumb__box">
          {thumb ? (
            <img
              className="plthumb__img"
              src={thumb}
              alt=""
              loading="lazy"
              onError={() => setBadThumb(true)}
            />
          ) : (
            <span className="plthumb__ph">
              <FilmStrip size={22} aria-hidden="true" />
            </span>
          )}
          <span className="plthumb__play" aria-hidden="true">
            <Play size={13} weight="fill" />
          </span>
          {dur && <span className="plthumb__dur">{dur}</span>}
        </span>
      </button>
    </div>
  );
}

export default VideoRow;
