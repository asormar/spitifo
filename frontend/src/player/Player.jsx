import { useEffect, useReducer, useRef, useState } from "react";
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
import {
  audioMeta,
  current,
  players,
  setCurrent,
  setSharedVolume,
  shared,
  toggleSharedMute,
  watchers,
} from "./engine.js";
import { pauseVideo } from "./videoStore.js";

function Player({ src, label, title, meta, duration, artwork, variant = "row", index = 0, registerAudio, onStart, onEnded }) {
  const audioRef = useRef(null);
  const railRef = useRef(null);
  const rootRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [cur, setCur] = useState(0);
  const [realDur, setRealDur] = useState(0);
  /* Posicion (0..1) mientras se arrastra la barra. null = no se arrastra. */
  const [drag, setDrag] = useState(null);
  const [, repaint] = useReducer((n) => n + 1, 0);

  useEffect(() => {
    const a = audioRef.current;
    players.add(a);
    watchers.add(repaint);
    a.volume = shared.volume;
    a.muted = shared.muted;
    return () => {
      players.delete(a);
      watchers.delete(repaint);
      audioMeta.delete(a);
      if (current === a) setCurrent(null);
      a.pause();
    };
  }, []);

  /* El auto-advance de la biblioteca necesita el <audio> de la fila VECINA: el
     cajon registra cada fila por su indice y reproduce la siguiente al terminar.
     No se consulta el DOM por selectores: el mapa lo llena cada Player. */
  useEffect(() => {
    if (!registerAudio) return undefined;
    registerAudio(index, audioRef.current);
    return () => registerAudio(index, null);
  }, [index, registerAudio]);

  /* Aparte del efecto de montaje: titulo y meta pueden cambiar sin que el
     elemento se remonte, y el registro tiene que seguirlos. */
  useEffect(() => {
    audioMeta.set(audioRef.current, {
      label,
      title,
      meta,
      duration,
      artwork,
      variant,
      el: rootRef.current,
    });
  }, [label, title, meta, duration, artwork, variant]);

  /* Se leen de `shared` en cada pintado: los watchers fuerzan el repintado
     cuando el volumen cambia desde el mini-reproductor. */
  const vol = shared.volume;
  const muted = shared.muted;
  const dur = realDur || duration || 0;
  const pct = drag !== null ? drag : dur ? clamp(cur / dur, 0, 1) : 0;
  const shownTime = drag !== null ? drag * dur : cur;
  const isCurrent = !!audioRef.current && current === audioRef.current;
  const active = !failed && isCurrent && (playing || cur > 0 || drag !== null);
  const total = dur ? clock(Math.round(dur)) : "--:--";

  const toggle = () => {
    const a = audioRef.current;
    if (!a || failed) return;
    if (a.paused) {
      a.volume = shared.volume;
      a.muted = shared.muted;
      setBuffering(true);
      /* play() rechaza con AbortError si se pausa antes de arrancar: no es un
         fallo del audio. Los fallos reales llegan por onError. */
      a.play().catch(() => setBuffering(false));
    } else {
      a.pause();
    }
  };

  const seekTo = (t) => {
    const a = audioRef.current;
    const v = clamp(t, 0, dur || 0);
    if (a && dur) a.currentTime = v;
    setCur(v);
  };

  const pctAt = (e) => {
    const r = railRef.current.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };

  const onPointerDown = (e) => {
    if (!dur || failed) return;
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
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      /* Se parte del reloj real del <audio>, no de `cur`: ese estado se
         refresca ~4 veces por segundo y las flechas repetidas no sumaban. */
      seekTo((audioRef.current?.currentTime ?? cur) + step);
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

  const onVolume = (e) => {
    setSharedVolume(Number(e.target.value) / 100);
    /* Por si el cambio llega antes de que este <audio> sea `current`. */
    const a = audioRef.current;
    a.volume = shared.volume;
    a.muted = shared.muted;
  };

  const toggleMute = () => {
    toggleSharedMute();
    const a = audioRef.current;
    a.volume = shared.volume;
    a.muted = shared.muted;
  };

  const icon = failed ? "play" : buffering ? "load" : playing ? "pause" : "play";
  const verb = playing ? "Pausar" : "Reproducir";
  const small = variant === "compact";
  const iconSize = small ? 13 : 16;

  const audio = (
    <audio
      ref={audioRef}
      src={src}
      /* Con la duracion ya conocida no hace falta pedir metadatos de cada fila:
         31 filas eran 31 peticiones al abrir la biblioteca. */
      preload={duration ? "none" : "metadata"}
      onLoadedMetadata={(e) => {
        if (Number.isFinite(e.currentTarget.duration)) setRealDur(e.currentTarget.duration);
      }}
      onDurationChange={(e) => {
        if (Number.isFinite(e.currentTarget.duration)) setRealDur(e.currentTarget.duration);
      }}
      onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
      onPlay={(e) => {
        players.forEach((o) => {
          if (o !== e.currentTarget) o.pause();
        });
        /* Un solo medio a la vez: si sonaba un video, se para. */
        pauseVideo();
        e.currentTarget.volume = shared.volume;
        e.currentTarget.muted = shared.muted;
        setCurrent(e.currentTarget);
        setPlaying(true);
        onStart?.();
      }}
      onPlaying={() => setBuffering(false)}
      onWaiting={() => setBuffering(true)}
      onPause={() => {
        setPlaying(false);
        setBuffering(false);
      }}
      onEnded={(e) => {
        e.currentTarget.currentTime = 0;
        setPlaying(false);
        setCur(0);
        onEnded?.();
      }}
      onError={() => {
        setFailed(true);
        setPlaying(false);
        setBuffering(false);
      }}
    />
  );

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
      tabIndex={failed ? -1 : 0}
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
        {audio}
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
      {audio}
      {button}
      <div className="pl__mid">
        <div className="pl__top">
          <span className="pl__title" title={title}>
            {title}
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
        <div className="pl__meta" title={failed ? undefined : meta}>
          {failed ? "No se pudo reproducir este audio" : meta}
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
              onClick={toggleMute}
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
              onChange={onVolume}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default Player;
