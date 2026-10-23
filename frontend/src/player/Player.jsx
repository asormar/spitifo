import { useEffect, useRef, useState } from "react";
import { CircleNotch, Pause, Play } from "@phosphor-icons/react";
import { cx, clamp } from "../shared/ui.jsx";
import { clock } from "../shared/format.js";
import { engine } from "./engine.js";
import { useEngine } from "./useEngine.js";

/* ---------------------------------------------------------------------------
   PREVIEW (tarjeta)

   Vista del motor: no tiene <audio>. Todo lo que suena se lee de ahi y solo se
   pinta si esta pista es la que suena; las demas muestran su duracion conocida
   y tiempo 0. Es el preview de 30 s de una tarjeta de resultados: sin volumen
   (lo lleva el mini-reproductor). Las filas de la biblioteca viven en listen/.
   ------------------------------------------------------------------------- */
function Player({ track }) {
  const railRef = useRef(null);
  const rootRef = useRef(null);
  /* Posicion (0..1) mientras se arrastra la barra. null = no se arrastra. */
  const [drag, setDrag] = useState(null);

  const key = track?.key;
  const isCurrent = useEngine((s) => s.track?.key === key);
  /* Booleanos y numeros: un objeto nuevo en cada emision repintaria las 300
     filas cuatro veces por segundo (ver useEngine.js). */
  const playing = useEngine((s) => s.track?.key === key && s.playing);
  const buffering = useEngine((s) => s.track?.key === key && s.buffering);
  const failed = useEngine((s) => s.track?.key === key && s.failed);
  const time = useEngine((s) => (s.track?.key === key ? s.time : 0));
  const realDur = useEngine((s) => (s.track?.key === key ? s.duration : 0));

  /* La caja de esta fila es lo que el mini-reproductor observa para saber si la
     cancion esta a la vista. */
  useEffect(() => {
    return engine.registerElement(key, rootRef.current);
  }, [key]);

  const dur = realDur || track?.duration || 0;
  const pct = drag !== null ? drag : dur ? clamp(time / dur, 0, 1) : 0;
  const shownTime = drag !== null ? drag * dur : time;
  const active = !failed && isCurrent && (playing || time > 0 || drag !== null);
  const total = dur ? clock(Math.round(dur)) : "--:--";

  const toggle = () => {
    if (failed) return;
    if (isCurrent) engine.toggle();
    else engine.play(track);
  };

  const seekTo = (t) => {
    if (!isCurrent || !dur) return;
    engine.seek(clamp(t, 0, dur));
  };

  const pctAt = (e) => {
    const r = railRef.current.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };

  const onPointerDown = (e) => {
    if (!isCurrent || !dur || failed) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(pctAt(e));
  };
  const onPointerMove = (e) => {
    if (drag !== null) setDrag(pctAt(e));
  };
  const onPointerUp = (e) => {
    if (drag === null) return;
    seekTo(pctAt(e) * dur);
    setDrag(null);
  };

  const onKeyDown = (e) => {
    if (!isCurrent) return;
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      /* Se parte del reloj del motor, no del `time` pintado: seek() ya actualiza
         la foto, asi que las flechas repetidas suman aunque React no haya
         repintado entre una y otra. */
      engine.seek(engine.getState().time + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      seekTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      seekTo(dur - 1);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle();
    }
  };

  const icon = failed ? "play" : buffering ? "load" : playing ? "pause" : "play";
  const verb = playing ? "Pausar" : "Reproducir";
  const iconSize = 13;
  const label = track?.label || "";

  const button = (
    <button
      type="button"
      className="pbtn"
      data-icon={icon}
      onClick={toggle}
      disabled={failed}
      aria-label={`${verb} ${label}`}
    >
      <span className="pbtn__ico pbtn__ico--play">
        <Play size={iconSize} weight="fill" />
      </span>
      <span className="pbtn__ico pbtn__ico--pause">
        <Pause size={iconSize} weight="fill" />
      </span>
      <span className="pbtn__ico pbtn__ico--load">
        <CircleNotch size={iconSize} weight="bold" className="spin" />
      </span>
    </button>
  );

  const rail = (
    <div
      ref={railRef}
      className={cx("scrub", drag !== null && "is-drag")}
      role="slider"
      /* Inactiva no se puede tabular: moverla no hace nada (solo la pista que
         suena admite seek). */
      tabIndex={failed || !isCurrent ? -1 : 0}
      aria-label={`Progreso de ${label}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct * 100)}
      aria-valuetext={`${clock(shownTime)} de ${total}`}
      aria-disabled={failed || undefined}
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
  );

  return (
    <div
      ref={rootRef}
      className={cx("pv", active && "is-active", playing && "is-playing")}
    >
      {button}
      {rail}
      <span className="pv__time">{active ? clock(shownTime) : total}</span>
    </div>
  );
}

export default Player;
