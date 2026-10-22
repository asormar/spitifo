import { useEffect, useRef, useState } from "react";
import {
  CircleNotch,
  Pause,
  Play,
  SpeakerHigh,
  SpeakerLow,
  SpeakerSlash,
} from "@phosphor-icons/react";
import { cx, clamp } from "../shared/ui.jsx";
import { clock } from "../shared/format.js";
import { engine } from "./engine.js";
import { useEngine } from "./useEngine.js";

/* ---------------------------------------------------------------------------
   FILA (biblioteca) Y PREVIEW (tarjeta)

   Vista del motor: no tiene <audio>. Todo lo que suena se lee de ahi y solo se
   pinta si esta pista es la que suena; las demas muestran su duracion conocida
   y tiempo 0. Volumen y silencio son compartidos y se pintan en todas, aunque
   el control solo se abra en la fila activa.

   Dos niveles, igual que antes: "row" (boton, barra, tiempo y volumen) y
   "compact" (preview de 30 s en una tarjeta de resultados: sin volumen).
   ------------------------------------------------------------------------- */
function Player({ track, queue, variant = "row", index = 0 }) {
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
  const vol = useEngine((s) => s.volume);
  const muted = useEngine((s) => s.muted);

  /* La caja de esta fila es lo que el mini-reproductor observa para saber si la
     cancion esta a la vista. */
  useEffect(() => {
    engine.registerElement(key, rootRef.current);
    return () => engine.registerElement(key, null);
  }, [key]);

  const dur = realDur || track?.duration || 0;
  const pct = drag !== null ? drag : dur ? clamp(time / dur, 0, 1) : 0;
  const shownTime = drag !== null ? drag * dur : time;
  const active = !failed && isCurrent && (playing || time > 0 || drag !== null);
  const total = dur ? clock(Math.round(dur)) : "--:--";

  const toggle = () => {
    if (failed) return;
    if (isCurrent) engine.toggle();
    else engine.play(track, { queue });
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
  const small = variant === "compact";
  const iconSize = small ? 13 : 16;
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

  if (small) {
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

  const quiet = muted || vol === 0;
  return (
    <div
      ref={rootRef}
      className={cx("pl", active && "is-active", playing && "is-playing", failed && "is-failed")}
      style={{ "--i": index }}
    >
      {button}
      <div className="pl__mid">
        <div className="pl__top">
          <span className="pl__title" title={track?.title}>
            {track?.title}
          </span>
          <span className="eq" aria-hidden="true" data-on={playing && !buffering ? "" : undefined}>
            <i />
            <i />
            <i />
          </span>
          <span className="pl__time">
            {clock(shownTime)} / {total}
          </span>
        </div>
        <div className="pl__meta" title={failed ? undefined : track?.meta}>
          {failed ? "No se pudo reproducir este audio" : track?.meta}
        </div>
        <div className="pl__bar">
          {rail}
          {/* El volumen solo existe en la fila activa: 31 filas con 31
              deslizadores serian ruido. Vive en la fila de la barra para que su
              aparicion no mueva el titulo. */}
          <div className="pl__vol" aria-hidden={!active}>
            <button
              type="button"
              className="pl__mute"
              tabIndex={active ? 0 : -1}
              onClick={() => engine.toggleMute()}
              aria-label={quiet ? "Activar el sonido" : "Silenciar"}
            >
              {quiet ? (
                <SpeakerSlash size={17} />
              ) : vol < 0.45 ? (
                <SpeakerLow size={17} />
              ) : (
                <SpeakerHigh size={17} />
              )}
            </button>
            <input
              type="range"
              className="vol"
              min={0}
              max={100}
              step={1}
              value={Math.round((quiet ? 0 : vol) * 100)}
              tabIndex={active ? 0 : -1}
              aria-label={`Volumen de ${label}`}
              style={{ "--v": `${Math.round((quiet ? 0 : vol) * 100)}%` }}
              onChange={(e) => engine.setVolume(Number(e.target.value) / 100)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default Player;
