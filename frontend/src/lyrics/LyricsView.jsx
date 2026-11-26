import { useEffect, useRef, useState } from "react";
import { Icon } from "../listen/icons.jsx";
import { activeLine, formatTime, lyricsState, lyricsUrl, previewLine, STATES } from "./lyrics.js";
import "./lyrics.css";

/* ---------------------------------------------------------------------------
   VISTA DE LETRA

   Vive dentro del reproductor: en el teléfono ocupa todo el cuerpo (la barra de
   pestañas y el transporte siguen donde estaban) y en PC el panel derecho. No
   hay cuarta pestaña (decisión 1). La línea activa es rosa porque es «lo que
   suena»; el resto es texto apagado. Tocar una línea hace seek.
   ------------------------------------------------------------------------- */

const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const COPY = {
  [STATES.NONE]: {
    title: "Sin letra",
    body: "No hay letra para esta canción. LRCLIB no tiene esta pista todavía; volvemos a intentarlo la próxima vez que la escuches.",
  },
  [STATES.INSTRUMENTAL]: {
    title: "Instrumental",
    body: "Esta pista no tiene letra: el proveedor la marca como instrumental.",
  },
  [STATES.UNAVAILABLE]: {
    title: "Letra no disponible ahora",
    body: "No pudimos consultar la letra. Vuelve a intentarlo cuando tengas conexión.",
  },
};

function Empty({ state }) {
  const copy = COPY[state];
  if (!copy) return null;
  return (
    <div className="lyr__state" role="status">
      <Icon name="Quotes" size="xl" />
      <b>{copy.title}</b>
      <span>{copy.body}</span>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="lyr__skel" aria-label="Buscando la letra" aria-busy="true">
      <i /><i /><i /><i />
    </div>
  );
}

/** Una sola consulta por pista, compartida por la tarjeta y la vista. */
export function useLyrics(track) {
  const [data, setData] = useState(null);
  const url = lyricsUrl(track);
  useEffect(() => {
    if (!url) return undefined;
    const controller = new AbortController();
    setData(null);
    fetch(url, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((json) => setData(json))
      .catch(() => setData({ error: "unavailable" }));
    return () => controller.abort();
  }, [url]);
  return data;
}

/** La tarjeta de «Ahora suena»: el primer vistazo, sin abrir nada todavía. */
export function LyricsCard({ track, time, onOpen }) {
  const data = useLyrics(track);
  if (!track) return null;
  const state = lyricsState(data);
  const fallback = state === STATES.PLAIN ? "Ver la letra completa"
    : state === STATES.NONE ? "Sin letra por ahora"
      : state === STATES.INSTRUMENTAL ? "Pista instrumental"
        : state === STATES.UNAVAILABLE ? "Letra no disponible ahora"
          : "Ver la letra de esta canción";
  return (
    <button type="button" className="ncard lyr__card" onClick={onOpen} aria-label="Abrir la letra">
      <span className="ncard__h lyr__card-h">
        <Icon name="Quotes" size="md" /> Letra
        <Icon name="CaretRight" size="md" className="lyr__card-go" />
      </span>
      <span className="lyr__card-line">{previewLine(data, time) || fallback}</span>
    </button>
  );
}

export default function LyricsView({ track, time, duration, onClose, onSeek, pc = false, data: givenData }) {
  const fetched = useLyrics(track);
  const data = givenData === undefined ? fetched : givenData;
  const lineRefs = useRef([]);
  const state = lyricsState(data);

  const active = state === STATES.SYNCED ? activeLine(data.synced, time) : -1;

  /* Autoscroll solo cuando cambia la línea, no en cada timeupdate. */
  useEffect(() => {
    if (active < 0) return;
    const el = lineRefs.current[active];
    if (el) el.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
  }, [active]);

  const title = track?.title || "sin título";
  const artist = track?.artist || "artista desconocido";

  return (
    <div className="lyr">
      <div className="lyr__head">
        {pc ? (
          /* En PC no hace falta una pantalla aparte: el panel derecho ya
             existe y solo cambia de posicion entre Ahora suena y Letra. */
          <div className="lyr__switch" role="group" aria-label="Panel del reproductor">
            <button type="button" onClick={onClose}>Ahora suena</button>
            <button type="button" className="is-on" aria-current="true">Letra</button>
          </div>
        ) : (
          <button type="button" className="lyr__back cbtn cbtn--w" onClick={onClose} aria-label="Cerrar la letra">
            <Icon name="CornersIn" size="md" />
          </button>
        )}
        <div className="lyr__who">
          <b>{title}</b>
          <small>{artist}</small>
        </div>
        <span className="lyr__spacer" aria-hidden="true" />
      </div>

      {state === STATES.LOADING && <Skeleton />}

      {(state === STATES.NONE || state === STATES.INSTRUMENTAL || state === STATES.UNAVAILABLE) && (
        <Empty state={state} />
      )}

      {state === STATES.PLAIN && (
        <div className="lyr__plain" role="article" aria-label={`Letra de ${title}`}>{data.plain}</div>
      )}

      {state === STATES.SYNCED && (
        <div className="lyr__scroll">
          {data.synced.map((line, i) => (
            <button
              key={`${line.t}-${i}`}
              ref={(el) => (lineRefs.current[i] = el)}
              type="button"
              className={i === active ? "lyr__line is-now" : i < active ? "lyr__line is-past" : "lyr__line"}
              aria-current={i === active ? "true" : undefined}
              onClick={() => onSeek(line.t)}
            >
              {line.line}
            </button>
          ))}
        </div>
      )}

      <div className="lyr__foot">
        <span className="lyr__time">{formatTime(time)}</span>
        {state === STATES.SYNCED && active >= 0 && (
          <span className="lyr__now" aria-live="polite">{data.synced[active].line}</span>
        )}
        <span className="lyr__time">{duration ? formatTime(duration) : ""}</span>
      </div>
    </div>
  );
}
