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
  random = Math.random,
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
    shuffle: false,
    repeat: "off",
  };

  const listeners = new Set();
  /* key -> cajas que muestran esa pista. El mini-reproductor las usa para saber
     si alguna fila esta a la vista. No es parte del estado: cambia con el DOM,
     no con la reproduccion. Pueden ser varias (la misma cancion en Escuchar y
     en "Descargado hace poco"), asi que cada clave guarda un array inmutable:
     su identidad solo cambia al registrar o soltar, y el mini-reproductor lo
     usa como dependencia sin recrear su observador en cada emision. */
  const elements = new Map();
  const NO_ELEMENTS = Object.freeze([]);

  let audio = null;
  /* Ultima clave adelantada. Evita repetir el POST al reanudar una pausa. */
  let prefetched = null;
  /* Cola en su orden de usuario, sin barajar. No entra en el estado porque la
     vista solo necesita la cola efectiva; se guarda para poder deshacer el
     shuffle sin perder las pistas anadidas mientras estaba activo. */
  let original = [];

  const REPEAT_MODES = ["off", "all", "one"];

  /* Fisher-Yates sobre una copia. `random` se inyecta para que los tests
     puedan fijar el orden sin depender del azar del navegador. */
  const shuffled = (items) => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  };

  /* La pista pedida va primero y el resto se baraja: asi el shuffle nunca
     arranca en medio de la lista ni cambia lo que el usuario acaba de pulsar. */
  const shuffledFrom = (track, list) =>
    [track, ...shuffled(list.filter((t) => t.key !== track.key))];

  /* Inserta `track` justo despues de `anchorKey`, quitando antes una aparicion
     posterior de la misma clave. Se usa sobre `original` para que el orden de
     usuario siga el mismo criterio que la cola efectiva. */
  const insertAfter = (list, anchorKey, track) => {
    const out = list.slice();
    const anchor = out.findIndex((t) => t.key === anchorKey);
    if (anchor < 0) {
      out.push(track);
      return out;
    }
    const later = out.findIndex((t, i) => i > anchor && t.key === track.key);
    if (later >= 0) out.splice(later, 1);
    out.splice(anchor + 1, 0, track);
    return out;
  };

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
    let candidate = state.queue[state.index + 1];
    /* Con repeat all la ultima pista tendra continuacion: la primera. */
    if (!candidate && state.repeat === "all" && state.queue.length) {
      candidate = state.queue[0];
    }
    if (
      !candidate ||
      candidate.kind !== "library" ||
      candidate.key === prefetched
    ) {
      return;
    }
    prefetched = candidate.key;
    try {
      Promise.resolve(
        fetchFn(`${API}/prefetch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: candidate.key }),
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
      /* repeat one repite sin recargar el src: asignarlo de nuevo haria un
         viaje al backend y cortaria el buffer ya descargado. */
      if (state.repeat === "one") {
        seek(0);
        start();
        return;
      }
      if (next()) return;
      /* La ultima pista solo se detiene, como siempre. */
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
       asignarlo reiniciaria la reproduccion desde cero). Con `restart` (el
       "Reproducir todo") se carga la cola nueva aunque sea la misma pista:
       si no, la lista pedida no sustituiria a la cola actual. */
    if (!opts.restart && state.track?.key === track.key) {
      resume();
      return;
    }
    let queue = opts.queue || [track];
    let index = opts.index ?? queue.findIndex((t) => t.key === track.key);
    if (index < 0) {
      queue = [track];
      index = 0;
    }
    /* `original` guarda el orden de usuario aunque ahora se reproduzca
       barajado: es lo que restaura setShuffle(false). */
    original = queue.slice();
    if (state.shuffle) {
      queue = shuffledFrom(track, original);
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
    /* repeat all da la vuelta tambien con una cola de una sola pista; repeat
       one no interviene aqui: el boton manual siempre avanza. */
    if (state.repeat === "all" && state.queue.length) {
      load(state.queue[0], state.queue, 0);
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

  /* Saltar a una posicion de la cola tal como esta (la vista Cola). play()
     no sirve: con shuffle activo volveria a barajar y pisaria `original`. */
  const playAt = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= state.queue.length) return false;
    if (i === state.index) {
      resume();
      return true;
    }
    load(state.queue[i], state.queue, i);
    return true;
  };

  /* Meter una pista "ahora mismo" sin sacar la actual: se coloca justo despues
     y se quita de mas abajo para que no suene dos veces. */
  const playNext = (track) => {
    if (!track) return false;
    if (!state.track) {
      play(track);
      return true;
    }
    if (state.track.key === track.key) return false;
    const queue = state.queue.slice();
    const at = queue.findIndex((t, i) => i > state.index && t.key === track.key);
    if (at >= 0) queue.splice(at, 1);
    queue.splice(state.index + 1, 0, track);
    original = insertAfter(original, state.track.key, track);
    emit({ queue });
    return true;
  };

  /* Al final, sin adelantarse: si la clave ya suena o esta por sonar no hay
     nada que anadir. */
  const enqueue = (track) => {
    if (!track) return false;
    if (!state.track) {
      play(track);
      return true;
    }
    const upcoming = state.queue.some(
      (t, i) => i > state.index && t.key === track.key
    );
    if (state.track.key === track.key || upcoming) return false;
    emit({ queue: [...state.queue, track] });
    original = [...original, track];
    return true;
  };

  /* Reordena solo lo que falta por sonar. Con shuffle activo `original` no se
     toca: el shuffle se deshace tal como estaba antes de mover. */
  const move = (from, to) => {
    const last = state.queue.length - 1;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from <= state.index || to <= state.index) return false;
    if (from > last || to > last) return false;
    if (from === to) return false;
    const queue = state.queue.slice();
    const [moved] = queue.splice(from, 1);
    queue.splice(to, 0, moved);
    if (!state.shuffle) original = queue.slice();
    emit({ queue });
    return true;
  };

  /* Quitar por posicion sin tocar la pista actual: si estaba antes, el indice
     se corre para que siga apuntando a la misma cancion. */
  const removeAt = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= state.queue.length) return false;
    if (i === state.index) return false;
    const queue = state.queue.slice();
    const [removed] = queue.splice(i, 1);
    const index = i < state.index ? state.index - 1 : state.index;
    const at = original.findIndex(
      (t) => t.key === removed.key && t.key !== state.track.key
    );
    if (at >= 0) original = original.slice(0, at).concat(original.slice(at + 1));
    emit({ queue, index });
    return true;
  };

  /* Encender shuffle deja la actual primero porque el usuario acaba de elegir
     escuchar eso; apagarlo devuelve el orden de usuario, no el barajado. */
  const setShuffle = (on) => {
    const shuffle = Boolean(on);
    if (state.shuffle === shuffle) return false;
    if (!state.track) {
      emit({ shuffle });
      return true;
    }
    if (shuffle) {
      emit({
        shuffle,
        queue: shuffledFrom(state.track, original),
        index: 0,
      });
    } else {
      const queue = original.slice();
      const at = queue.findIndex((t) => t.key === state.track.key);
      emit({ shuffle, queue, index: at < 0 ? 0 : at });
    }
    return true;
  };

  const setRepeat = (mode) => {
    if (!REPEAT_MODES.includes(mode)) return false;
    if (state.repeat === mode) return false;
    emit({ repeat: mode });
    return true;
  };

  const cycleRepeat = () =>
    setRepeat(
      REPEAT_MODES[(REPEAT_MODES.indexOf(state.repeat) + 1) % REPEAT_MODES.length]
    );

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

  /* Devuelve quien suelta SU caja: soltar por clave borraria tambien la de la
     otra pantalla que muestra la misma cancion. */
  const registerElement = (key, el) => {
    if (!el) {
      elements.delete(key);
      return () => {};
    }
    elements.set(key, [...(elements.get(key) || NO_ELEMENTS), el]);
    return () => {
      const rest = (elements.get(key) || NO_ELEMENTS).filter((x) => x !== el);
      if (rest.length) elements.set(key, rest);
      else elements.delete(key);
    };
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
    playAt,
    playNext,
    enqueue,
    move,
    removeAt,
    setShuffle,
    setRepeat,
    cycleRepeat,
    setVolume,
    toggleMute,
    registerElement,
    elementsFor: (key) => elements.get(key) || NO_ELEMENTS,
  };
}

/* Una sola instancia para toda la app. `onPlayStart` conecta el motor con el
   video: cuando empieza a sonar una cancion, el video se pausa. */
export const engine = createEngine({ onPlayStart: pauseVideo });
