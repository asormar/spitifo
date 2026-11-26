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
import { setBoundedMap } from "../shared/bounded.js";
import { pauseVideo } from "./videoStore.js";

const DEFAULT_VOLUME = 0.8;
/* Sin datos durante esto, se avisa "red lenta" (sin tapar los controles) y se
   reintenta una vez solo, recargando el src (no solo resume()): un stream
   (`/api/stream?url=`) re-resuelve en el backend con cada peticion nueva, asi
   que una URL caducada necesita una peticion nueva, no seguir pulsando play
   sobre la misma. */
const STALL_MS = 8000;
/* Portadas de sesiones larguisimas (horas, cientos de temas): basta con la
   de las ultimas pistas para que volver atras siga teniendo su foto. */
const BASE_ART_CAP = 50;

/* `track`: { key, src, title, meta, duration, artwork, kind, label }
   - key identifica la pista en la cola (es lo que mueve prev/next).
   - kind es "library", "preview" o "stream"; solo las de biblioteca se
     prefetchean aqui (el stream tiene su propio aviso al final de la pista).
   - label es el nombre accesible que usan los botones ("Reproducir X").
   `play(track, { queue, index, restart, at, source, endless })`: `at` son los
   segundos desde los que se retoma ("Seguir escuchando"); `source` etiqueta
   quien pidio la reproduccion (la Mezcla de Inicio) y `endless` hace que la
   cola de la vuelta sola, barajada de nuevo en cada vuelta. */
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
    /* Buffering hace rato (STALL_MS) sin playing: "red lenta", distinto de un
       buffering normal de arranque. */
    stalled: false,
    time: 0,
    duration: 0,
    volume: DEFAULT_VOLUME,
    muted: false,
    shuffle: false,
    repeat: "off",
    /* Quien lanzo la cola ("mix:top") y si da la vuelta sin repeat. Solo los
       fija play(); next/prev/playAt/enqueue los conservan. */
    source: null,
    endless: false,
  };

  const listeners = new Set();
  /* Portada original por clave: la foto propia se aplica sobre la pista, pero
     al volver a la original tiene que volver a la del sidecar/fuente. */
  const baseArt = new Map();
  /* Avisos de cierre/cambio de pista: el historial de escucha necesita saber
     POR QUE se cerro la sesion, cosa que el estado (una foto) no dice. */
  const trackEvents = new Set();
  /* Un seek es un cambio de tiempo como otro en la foto, pero el puente nativo
     necesita distinguirlo del timeupdate: la barra del sistema no debe esperar
     al siguiente informe de posicion. Se avisa ANTES de emitir para que el
     suscriptor pueda marcar el cambio como forzado. */
  const seekEvents = new Set();
  let audio = null;
  /* Ultima clave adelantada. Evita repetir el POST al reanudar una pausa. */
  let prefetched = null;
  /* Cola en su orden de usuario, sin barajar. No entra en el estado porque la
     vista solo necesita la cola efectiva; se guarda para poder deshacer el
     shuffle sin perder las pistas anadidas mientras estaba activo. */
  let original = [];

  const REPEAT_MODES = ["off", "all", "one"];

  /* Al final de la cola se da la vuelta con repeat all o con una cola sin fin. */
  const wraps = () => state.repeat === "all" || state.endless;

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

  const notifyTrack = (event) => {
    trackEvents.forEach((fn) => fn(event));
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
    /* Con repeat all (o sin fin) la ultima pista tendra continuacion: la
       primera. Barajado no se sabe cual sera: la vuelta se baraja al llegar. */
    if (!candidate && wraps() && !state.shuffle && state.queue.length) {
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

  /* Un stream colgado: 8 s en "waiting" sin pasar a "playing" avisa "red
     lenta" y reintenta recargando el src UNA vez (autoRetried evita un bucle
     si el reintento tambien se queda esperando). Un timer por intento, nunca
     dos a la vez. */
  let stallTimer = null;
  let autoRetried = false;
  const clearStall = () => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };
  const armStall = () => {
    if (stallTimer !== null) return;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      /* Si "playing" o "pause" hubieran llegado, ya habrian limpiado este
         timer (clearStall): llegar aca es buffering de verdad, sin resolver. */
      if (!state.buffering) return;
      emit({ stalled: true });
      if (!autoRetried) {
        autoRetried = true;
        reloadAt(state.time);
      }
    }, STALL_MS);
  };

  /* Los eventos se enganchan una sola vez, al crear el elemento. */
  const wire = (a) => {
    a.addEventListener("play", () => emit({ playing: true }));
    a.addEventListener("playing", () => {
      clearStall();
      autoRetried = false;
      emit({ playing: true, buffering: false, stalled: false });
      prefetchNext();
    });
    a.addEventListener("waiting", () => {
      emit({ buffering: true });
      armStall();
    });
    a.addEventListener("pause", () => {
      clearStall();
      emit({ playing: false, buffering: false });
    });
    a.addEventListener("timeupdate", () => emit({ time: a.currentTime }));
    a.addEventListener("durationchange", () => emit({ duration: durationNow() }));
    a.addEventListener("loadedmetadata", () => emit({ duration: durationNow() }));
    a.addEventListener("error", () => {
      clearStall();
      emit({ failed: true, playing: false, buffering: false, stalled: false });
    });
    a.addEventListener("ended", () => {
      /* repeat one repite sin recargar el src: asignarlo de nuevo haria un
         viaje al backend y cortaria el buffer ya descargado. */
      if (state.repeat === "one") {
        notifyTrack({ type: "end", track: state.track, repeatOne: true });
        seek(0);
        start();
        return;
      }
      /* El `ended` que avanza de pista cierra la sesion con motivo "end"; si
         no hay siguiente, el tema se cierra igual y la pista se detiene. */
      if (next("end")) return;
      notifyTrack({ type: "end", track: state.track, repeatOne: false });
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
  const load = (track, queue, index, reason = "change", at = 0, meta = {}) => {
    const q = queue && queue.length ? queue : [track];
    const i = index >= 0 && index < q.length ? index : 0;
    const a = ensureAudio();
    /* La cola nunca lleva la foto propia: siempre se guarda la de origen. */
    setBoundedMap(baseArt, track.key, track.artwork || null, BASE_ART_CAP);
    /* Se avisa ANTES de reemplazar la foto: quien escucha (el historial)
       todavia puede leer la pista y la posicion que se estan cerrando. */
    if (state.track) {
      notifyTrack({ type: "change", reason, track, previous: state.track });
    }
    emit({
      track,
      queue: q,
      index: i,
      time: at,
      /* La duracion conocida evita pedir metadatos de cada fila al abrir la
         biblioteca; el evento loadedmetadata la corrige si hace falta. */
      duration: track.duration || 0,
      failed: false,
      buffering: true,
      playing: false,
      ...meta,
    });
    a.preload = "auto";
    a.src = track.src;
    /* Retomar: con el src recien puesto el navegador guarda la posicion y la
       aplica al cargar los metadatos. */
    if (at > 0) a.currentTime = at;
    a.volume = state.volume;
    a.muted = state.muted;
    start();
  };

  /* Recarga la pista actual en su misma posicion: una peticion nueva al
     backend (no resume() sobre el mismo <audio>), para un stream cuya URL
     pudo caducar. La usan el reintento automatico del stall y el manual
     ("Reintentar") del aviso. */
  const reloadAt = (time) => {
    if (!state.track) return;
    load(state.track, state.queue, state.index, "retry", time);
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
    /* `at` (segundos) retoma la pista donde se quedo; una posicion fuera de la
       pista (o a menos de un segundo del final) se ignora. */
    const at = Number(opts.at);
    const from =
      at > 0 && (!track.duration || at < track.duration - 1) ? at : 0;
    load(track, queue, index, "change", from, {
      source: opts.source || null,
      endless: Boolean(opts.endless),
    });
  };

  const resume = () => {
    if (!state.track) return;
    ensureAudio();
    /* Solo si estaba parado: un play() sobre algo que ya suena no vuelve a
       emitir `playing` y el spinner se quedaria encendido. */
    if (!state.playing) emit({ buffering: true });
    start();
  };

  /* Retomar al reabrir la app: carga la pista, la cola y la posicion SIN
     arrancar el audio (sin autoplay). El mini-reproductor la ve como
     cualquier otra pista cargada, en pausa, lista para un toque. */
  const restore = (track, queue, index, at = 0) => {
    if (!track) return;
    const q = queue && queue.length ? queue : [track];
    const i = index >= 0 && index < q.length ? index : 0;
    const a = ensureAudio();
    baseArt.set(track.key, track.artwork || null);
    original = q.slice();
    emit({
      track,
      queue: q,
      index: i,
      time: at,
      duration: track.duration || 0,
      failed: false,
      buffering: false,
      playing: false,
      stalled: false,
      source: null,
      endless: false,
    });
    /* Sin precarga: retomar es una oferta, no un play. Un stream no se pide
       (ni se resuelve en YouTube) hasta que el usuario toca reproducir. */
    a.preload = "none";
    a.src = track.src;
    if (at > 0) a.currentTime = at;
    a.volume = state.volume;
    a.muted = state.muted;
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
    seekEvents.forEach((fn) => fn(t));
    /* Se escribe ya, sin esperar al timeupdate: la barra tiene que seguir al
       dedo aunque el evento tarde. */
    emit({ time: t });
  };

  /* Carga la siguiente SIN tocar la cola: el resto de la lista sigue igual.
     `reason` distingue el boton (next) del final natural (end). */
  const next = (reason = "next") => {
    if (state.index >= 0 && state.index + 1 < state.queue.length) {
      load(state.queue[state.index + 1], state.queue, state.index + 1, reason);
      return true;
    }
    /* repeat all (o sin fin) da la vuelta tambien con una cola de una sola
       pista; repeat one no interviene aqui: el boton manual siempre avanza. */
    if (wraps() && state.queue.length) {
      if (!state.shuffle) {
        load(state.queue[0], state.queue, 0, reason);
        return true;
      }
      /* Barajado, cada vuelta es un orden nuevo y la ultima pista oida queda
         al final: la vuelta nunca abre repitiendo lo que acaba de sonar. */
      const last = state.queue[state.index] || state.track;
      const rest = shuffled(state.queue.filter((t) => t.key !== last.key));
      if (rest.length) load(rest[0], [...rest, last], 0, reason);
      else load(last, [last], 0, reason);
      return true;
    }
    return false;
  };

  /* "Anterior" en un reproductor de musica: pasados 3 s vuelve a empezar la
     actual; antes de eso salta a la de arriba. */
  const prev = () => {
    if (state.index < 0) return;
    if (state.time > 3 || state.index <= 0) seek(0);
    else load(state.queue[state.index - 1], state.queue, state.index - 1,
              "prev");
  };

  /* Saltar a una posicion de la cola tal como esta (la vista Cola). play()
     no sirve: con shuffle activo volveria a barajar y pisaria `original`. */
  const playAt = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= state.queue.length) return false;
    if (i === state.index) {
      resume();
      return true;
    }
    load(state.queue[i], state.queue, i, "change");
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

  /* Quitar claves que ya no estan en la biblioteca: salen de la cola y, si la
     que suena era una, se salta a la siguiente (o se detiene). A diferencia de
     removeAt, AQUI se puede tocar la pista actual: es la que desaparece del
     disco. Se llama al confirmar el borrado, nunca durante el Deshacer. */
  const purge = (keys) => {
    if (!keys || !keys.length) return 0;
    const gone = new Set(keys);
    const before = state.queue;
    const had = before.reduce((n, t) => n + (gone.has(t.key) ? 1 : 0), 0);
    if (!had) return 0;
    if (gone.has(prefetched)) prefetched = null;

    const queue = before.filter((t) => !gone.has(t.key));
    original = original.filter((t) => !gone.has(t.key));
    if (!gone.has(state.track?.key)) {
      /* Las de antes corrigen el indice; la actual sigue siendo la misma. */
      let index = 0;
      for (let i = 0; i < state.index && i < before.length; i += 1) {
        if (!gone.has(before[i].key)) index += 1;
      }
      emit({ queue, index });
      return had;
    }

    const nextTrack = before.slice(state.index + 1).find((t) => !gone.has(t.key));
    if (nextTrack) {
      const index = queue.findIndex((t) => t.key === nextTrack.key);
      load(nextTrack, queue, index, "change");
    } else {
      if (audio) {
        audio.pause();
        try {
          audio.currentTime = 0;
        } catch {
          /* un audio falso puede no admitir seek */
        }
      }
      if (state.track) {
        notifyTrack({ type: "end", track: state.track, repeatOne: false });
      }
      emit({
        track: null,
        queue,
        index: -1,
        playing: false,
        buffering: false,
        failed: false,
        time: 0,
        duration: 0,
      });
    }
    return had;
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

  /* La hoja de foto cambia la portada de la pista que suena sin tocar el audio.
     La cola se deja intacta: al pasar a otra pista se carga su imagen original. */
  const setArtwork = (url) => {
    const t = state.track;
    if (!t) return;
    const artwork = url || baseArt.get(t.key) || null;
    if (Object.is(t.artwork, artwork)) return;
    emit({ track: { ...t, artwork } });
  };

  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const onTrackEvent = (fn) => {
    trackEvents.add(fn);
    return () => trackEvents.delete(fn);
  };

  const onSeek = (fn) => {
    seekEvents.add(fn);
    return () => seekEvents.delete(fn);
  };

  /* Vuelve la red: una pista fallida se reanuda sola, sin que el usuario
     toque nada (recarga con una peticion nueva, no resume() sobre lo mismo). */
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
      if (state.failed && state.track) reloadAt(state.time);
    });
  }

  return {
    subscribe,
    onTrackEvent,
    onSeek,
    getState: () => state,
    play,
    resume,
    restore,
    reloadAt,
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
    purge,
    setShuffle,
    setRepeat,
    cycleRepeat,
    setVolume,
    toggleMute,
    setArtwork,
  };
}

/* Una sola instancia para toda la app. `onPlayStart` conecta el motor con el
   video: cuando empieza a sonar una cancion, el video se pausa. */
export const engine = createEngine({ onPlayStart: pauseVideo });
