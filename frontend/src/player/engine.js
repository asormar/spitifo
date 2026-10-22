/* ---------------------------------------------------------------------------
   MOTOR DE REPRODUCCION

   UN solo <audio> para toda la app. Antes cada fila de la biblioteca y cada
   preview de una tarjeta tenian el suyo: con 300 filas habia 300 elementos y
   podian sonar varios a la vez. Ahora el motor es el dueno del elemento, de la
   cancion actual y de la cola; las filas, los previews y el mini-reproductor
   solo pintan su estado y le mandan ordenes.

   El estado es una foto inmutable que se reemplaza entera en cada cambio y se
   avisa a los suscriptores. Nada fuera de aqui toca el <audio>: si dos vistas
   guardaran su copia, volveriamos a tener estados desincronizados.

   El elemento se crea en el PRIMER uso (play, seek o volumen), no al importar:
   este modulo tiene que poder cargarse sin window/document/navigator (tests en
   Node) y no hay motivo para reservar un <audio> vacio antes de que suene algo.
   ------------------------------------------------------------------------- */

import { API } from "../shared/api.js";
import { pauseVideo } from "./videoStore.js";

const DEFAULT_VOLUME = 0.8;

/* `track`: { key, src, title, meta, duration, artwork, kind, label }
   - key identifica la pista en la cola (es lo que mueve prev/next).
   - kind es "library" o "preview"; solo las de biblioteca se prefetchean.
   - label es el nombre accesible que usan los botones ("Reproducir X"). */
export function createEngine({
  createAudio = () => new Audio(),
  fetchFn = (...a) => fetch(...a),
  onPlayStart = () => {},
} = {}) {
  let state = {
    track: null,
    queue: [],
    index: -1,
    playing: false,
    buffering: false,
    failed: false,
    time: 0,
    duration: 0,
    volume: DEFAULT_VOLUME,
    muted: false,
  };

  const listeners = new Set();
  /* key -> caja del Player que muestra esa pista. El mini-reproductor lo usa
     para saber si la fila esta a la vista (y para saltar a ella). No es parte
     del estado: cambia con el DOM, no con la reproduccion. */
  const elements = new Map();

  let audio = null;
  /* Ultima clave adelantada. Evita repetir el POST al reanudar una pausa. */
  let prefetched = null;

  const emit = (patch) => {
    let changed = false;
    for (const k of Object.keys(patch)) {
      if (!Object.is(patch[k], state[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };

  const durationNow = () =>
    Number.isFinite(audio?.duration) && audio.duration > 0
      ? audio.duration
      : state.track?.duration || 0;

  /* Un fallo real de play() no llega por el evento `error`: AbortError es solo
     la pausa antes de arrancar y no se pinta como fallo. */
  const playFailed = (err) => {
    if (err?.name === "AbortError") return;
    emit({ failed: true, playing: false, buffering: false });
  };

  const start = () => {
    const a = ensureAudio();
    onPlayStart();
    const p = a.play();
    if (p && typeof p.catch === "function") p.catch(playFailed);
  };

  /* Adelanta la siguiente pista de la biblioteca sin esperar respuesta: si
     falla, al final se bajara igual. Los previews (30 s remotos) no se tocan y
     el guardia evita repetir la misma clave dos veces seguidas. */
  const prefetchNext = () => {
    const next = state.queue[state.index + 1];
    if (!next || next.kind !== "library" || next.key === prefetched) return;
    prefetched = next.key;
    try {
      Promise.resolve(
        fetchFn(`${API}/prefetch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: next.key }),
        })
      ).catch(() => {});
    } catch {
      /* el prefetch nunca puede romper la reproduccion */
    }
  };

  /* Los eventos se enganchan una sola vez, al crear el elemento. */
  const wire = (a) => {
    a.addEventListener("play", () => emit({ playing: true }));
    a.addEventListener("playing", () => {
      emit({ playing: true, buffering: false });
      prefetchNext();
    });
    a.addEventListener("waiting", () => emit({ buffering: true }));
    a.addEventListener("pause", () => emit({ playing: false, buffering: false }));
    a.addEventListener("timeupdate", () => emit({ time: a.currentTime }));
    a.addEventListener("durationchange", () => emit({ duration: durationNow() }));
    a.addEventListener("loadedmetadata", () => emit({ duration: durationNow() }));
    a.addEventListener("error", () =>
      emit({ failed: true, playing: false, buffering: false })
    );
    a.addEventListener("ended", () => {
      /* La ultima pista solo se detiene, como siempre. */
      if (next()) return;
      emit({ playing: false, time: 0 });
      a.currentTime = 0;
    });
  };

  const ensureAudio = () => {
    if (audio) return audio;
    audio = createAudio();
    audio.volume = state.volume;
    audio.muted = state.muted;
    wire(audio);
    return audio;
  };

  /* Cargar una pista SIEMPRE pasa por aqui: es el unico sitio que escribe
     `src`, asi que la cola y el indice no pueden quedar desfasados del audio. */
  const load = (track, queue, index) => {
    const q = queue && queue.length ? queue : [track];
    const i = index >= 0 && index < q.length ? index : 0;
    const a = ensureAudio();
    emit({
      track,
      queue: q,
      index: i,
      time: 0,
      /* La duracion conocida evita pedir metadatos de cada fila al abrir la
         biblioteca; el evento loadedmetadata la corrige si hace falta. */
      duration: track.duration || 0,
      failed: false,
      buffering: true,
      playing: false,
    });
    a.src = track.src;
    a.volume = state.volume;
    a.muted = state.muted;
    start();
  };

  const play = (track, opts = {}) => {
    if (!track) return;
    /* Misma pista: reanudar, no recargar (el src ya esta puesto y volver a
       asignarlo reiniciaria la reproduccion desde cero). */
    if (state.track?.key === track.key) {
      resume();
      return;
    }
    let queue = opts.queue || [track];
    let index = opts.index ?? queue.findIndex((t) => t.key === track.key);
    if (index < 0) {
      queue = [track];
      index = 0;
    }
    load(track, queue, index);
  };

  const resume = () => {
    if (!state.track) return;
    ensureAudio();
    /* Solo si estaba parado: un play() sobre algo que ya suena no vuelve a
       emitir `playing` y el spinner se quedaria encendido. */
    if (!state.playing) emit({ buffering: true });
    start();
  };

  const pause = () => {
    if (!audio) return;
    audio.pause();
  };

  const toggle = () => {
    if (state.playing || state.buffering) pause();
    else if (state.track) resume();
  };

  const seek = (seconds) => {
    const a = ensureAudio();
    const dur = state.duration;
    const raw = Number(seconds) || 0;
    const t = dur > 0 ? Math.min(Math.max(raw, 0), dur) : Math.max(raw, 0);
    a.currentTime = t;
    /* Se escribe ya, sin esperar al timeupdate: la barra tiene que seguir al
       dedo aunque el evento tarde. */
    emit({ time: t });
  };

  /* Carga la siguiente SIN tocar la cola: el resto de la lista sigue igual. */
  const next = () => {
    if (state.index >= 0 && state.index + 1 < state.queue.length) {
      load(state.queue[state.index + 1], state.queue, state.index + 1);
      return true;
    }
    return false;
  };

  /* "Anterior" en un reproductor de musica: pasados 3 s vuelve a empezar la
     actual; antes de eso salta a la de arriba. */
  const prev = () => {
    if (state.index < 0) return;
    if (state.time > 3 || state.index <= 0) seek(0);
    else load(state.queue[state.index - 1], state.queue, state.index - 1);
  };

  const setVolume = (v) => {
    const volume = Math.min(Math.max(Number(v) || 0, 0), 1);
    const muted = volume === 0;
    const a = ensureAudio();
    a.volume = volume;
    a.muted = muted;
    emit({ volume, muted });
  };

  const toggleMute = () => {
    const muted = !(state.muted || state.volume === 0);
    /* Reactivar desde 0 devolveria el silencio con el icono de sonido. */
    const volume = !muted && state.volume === 0 ? DEFAULT_VOLUME : state.volume;
    const a = ensureAudio();
    a.volume = volume;
    a.muted = muted;
    emit({ volume, muted });
  };

  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const registerElement = (key, el) => {
    if (el) elements.set(key, el);
    else elements.delete(key);
  };

  return {
    subscribe,
    getState: () => state,
    play,
    resume,
    pause,
    toggle,
    seek,
    next,
    prev,
    setVolume,
    toggleMute,
    registerElement,
    elementFor: (key) => elements.get(key) || null,
  };
}

/* Una sola instancia para toda la app. `onPlayStart` conecta el motor con el
   video: cuando empieza a sonar una cancion, el video se pausa. */
export const engine = createEngine({ onPlayStart: pauseVideo });
