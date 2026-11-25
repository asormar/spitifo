import { useEffect, useRef } from "react";
import { cx, clamp } from "../shared/ui.jsx";
import { clock } from "../shared/format.js";
import { engine } from "./engine.js";
import { useEngine } from "./useEngine.js";

/* ---------------------------------------------------------------------------
   BARRA DE PROGRESO

   La usan el mini-reproductor, la barra de escritorio y "Ahora suena": una
   sola implementacion del arrastre, el teclado y el slider accesible.

   El dedo escribe directamente el `transform` del relleno y del tirador (y el
   texto del tiempo, por una ref que da el que llama): nada de eso pasa por el
   estado de React en cada `pointermove`, que es lo que haria repintar el
   componente ~120 veces por segundo. React solo se entera al soltar (el seek
   de verdad) o cuando el motor avisa un nuevo `time` (unas pocas veces por
   segundo, su propio ritmo de `timeupdate`).

   Devuelve la barra y, a continuacion, lo que pinte `children({ elapsedRef,
   remainingRef })`: dos referencias a los nodos donde escribir el tiempo
   transcurrido y el que falta. Cada padre decide donde los coloca; Scrub es
   quien escribe su texto. Se monta con `key` = clave de la pista, asi un
   arrastre a medias no pasa a la cancion siguiente.
   ------------------------------------------------------------------------- */

export default function Scrub({ duration, label, children }) {
  const time = useEngine((s) => s.time);
  const railRef = useRef(null);
  const fillRef = useRef(null);
  const knobRef = useRef(null);
  const sliderRef = useRef(null);
  const elapsedRef = useRef(null);
  const remainingRef = useRef(null);
  /* Porcentaje (0-1) mientras se arrastra, o null si el dedo no esta encima:
     en ese caso se pinta `time / duration`. Vive en una ref porque pintarlo
     no pasa por React. */
  const dragRef = useRef(null);
  const disabled = !duration;

  const paint = (pct, dragging) => {
    const shown = pct * duration;
    if (fillRef.current) fillRef.current.style.transform = `scaleX(${pct})`;
    if (knobRef.current) {
      const w = railRef.current?.clientWidth || 0;
      knobRef.current.style.transform = `translateX(${pct * w - 7}px)`;
    }
    if (sliderRef.current) {
      sliderRef.current.setAttribute("aria-valuenow", String(Math.round(pct * 100)));
      sliderRef.current.setAttribute(
        "aria-valuetext",
        `${clock(shown)} de ${duration ? clock(Math.round(duration)) : "--:--"}`
      );
      sliderRef.current.classList.toggle("is-drag", Boolean(dragging));
    }
    if (elapsedRef.current) elapsedRef.current.textContent = clock(shown);
    if (remainingRef.current) {
      remainingRef.current.textContent = duration ? `-${clock(duration - shown)}` : "--:--";
    }
  };

  /* Sigue el reloj del motor mientras no se arrastra: el `timeupdate` nativo
     llega unas pocas veces por segundo, no en cada frame. */
  useEffect(() => {
    if (dragRef.current === null) paint(disabled ? 0 : clamp(time / duration, 0, 1), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, duration, disabled]);

  const pctAt = (e) => {
    const r = railRef.current.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };

  const onPointerDown = (e) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pct = pctAt(e);
    dragRef.current = pct;
    paint(pct, true);
  };
  const onPointerMove = (e) => {
    if (dragRef.current === null) return;
    const pct = pctAt(e);
    dragRef.current = pct;
    paint(pct, true);
  };
  const onPointerUp = (e) => {
    if (dragRef.current === null) return;
    const pct = pctAt(e);
    dragRef.current = null;
    /* El seek de verdad: una sola vez, al soltar. engine.seek() emite `time`
       de inmediato, asi que el efecto de arriba repinta con el mismo valor
       que ya se veia (sin el salto de esperar al timeupdate). */
    engine.seek(pct * duration);
    paint(pct, false);
  };
  const onPointerCancel = () => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    paint(disabled ? 0 : clamp(time / duration, 0, 1), false);
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
      engine.seek(0);
    } else if (e.key === "End") {
      e.preventDefault();
      engine.seek(duration - 1);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      engine.toggle();
    }
  };

  return (
    <>
      <div
        ref={sliderRef}
        className="scrub"
        role="slider"
        tabIndex={0}
        aria-label={`Progreso de ${label}`}
        aria-disabled={disabled || undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={disabled ? undefined : onKeyDown}
      >
        <span ref={railRef} className="scrub__rail">
          <span ref={fillRef} className="scrub__fill" />
        </span>
        <span ref={knobRef} className={cx("scrub__knob", disabled && "scrub__knob--hidden")} />
      </div>
      {children?.({ elapsedRef, remainingRef })}
    </>
  );
}
