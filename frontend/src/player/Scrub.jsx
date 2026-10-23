import { useRef, useState } from "react";
import { cx, clamp } from "../shared/ui.jsx";
import { clock } from "../shared/format.js";
import { engine } from "./engine.js";
import { useEngine } from "./useEngine.js";

/* ---------------------------------------------------------------------------
   BARRA DE PROGRESO

   La usan el mini-reproductor y "Ahora suena": una sola implementacion del
   arrastre, el teclado y el slider accesible. Mientras se arrastra, la barra
   sigue al dedo y el motor no se toca hasta soltar (un seek por cada
   pointermove cortaria el audio).

   Devuelve la barra y, a continuacion, lo que pinte `children(tiempo, total)`:
   el tiempo que se muestra es el del arrastre, y solo esta pieza lo sabe. Cada
   padre decide donde pone el texto. Se monta con `key` = clave de la pista, asi
   un arrastre a medias no pasa a la cancion siguiente.
   ------------------------------------------------------------------------- */

export default function Scrub({ duration, label, children }) {
  const time = useEngine((s) => s.time);
  const [drag, setDrag] = useState(null);
  const railRef = useRef(null);

  const pct = drag !== null ? drag : duration ? clamp(time / duration, 0, 1) : 0;
  const shown = drag !== null ? drag * duration : time;
  const total = duration ? clock(Math.round(duration)) : "--:--";

  const seekTo = (t) => {
    engine.seek(clamp(t, 0, duration || 0));
  };

  const pctAt = (e) => {
    const r = railRef.current.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };
  const onPointerDown = (e) => {
    if (!duration) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(pctAt(e));
  };
  const onPointerMove = (e) => {
    if (drag !== null) setDrag(pctAt(e));
  };
  const onPointerUp = (e) => {
    if (drag === null) return;
    seekTo(pctAt(e) * duration);
    setDrag(null);
  };
  const onKeyDown = (e) => {
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      /* Del motor: seek() actualiza su foto, asi que las flechas repetidas
         suman aunque React no haya repintado entre una y otra. */
      engine.seek(engine.getState().time + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      seekTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      seekTo(duration - 1);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      engine.toggle();
    }
  };

  return (
    <>
      <div
        ref={railRef}
        className={cx("scrub", drag !== null && "is-drag")}
        role="slider"
        tabIndex={0}
        aria-label={`Progreso de ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct * 100)}
        aria-valuetext={`${clock(shown)} de ${total}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={onKeyDown}
      >
        <span className="scrub__rail">
          <span className="scrub__fill" style={{ transform: `scaleX(${pct})` }} />
        </span>
        <span className="scrub__knob" style={{ left: `${pct * 100}%` }} />
      </div>
      {children?.(shown, total)}
    </>
  );
}
