/* ---------------------------------------------------------------------------
   PUENTE DE ANDROID

   El shell nativo expone SpitifoAndroid cuando puede mostrar la notificacion
   multimedia. Solo en ese caso se traduce la foto del motor al JSON que espera
   Kotlin y se escuchan las ordenes que llegan desde la notificacion, la
   pantalla de bloqueo o los botones del auricular. Sin el puente no se hace
   nada: la Web Media Session (mediaSession.js) sigue siendo la via normal.

   El sistema interpola la barra de progreso entre informes, asi que la
   posicion se manda como muy tarde cada 5 s. Los cambios de pista, estado o
   duracion van de inmediato, y un seek tambien (el motor avisa aparte).
   ------------------------------------------------------------------------- */

const DEFAULT_THROTTLE_MS = 5_000;
const DRIFT_MIN_SECONDS = 1;
const JUMP_SECONDS = 2;

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

export function bindAndroidMedia(
  engine,
  { now = () => Date.now(), throttleMs = DEFAULT_THROTTLE_MS } = {},
) {
  const bridge = typeof window !== "undefined" ? window.SpitifoAndroid : null;
  if (!bridge || typeof bridge.mediaUpdate !== "function") return () => {};

  let lastSig = null;
  let lastAt = -Infinity;
  let lastPos = -1;
  let lastRunning = false;
  let cleared = false;
  let sent = false;
  /* El seek avisa antes de emitir: el suscriptor marca esa vuelta como
     forzada para que llegue al primer informe, sin esperar al throttling. */
  let seekEpoch = 0;
  let handledEpoch = 0;

  const snapshot = (s) => {
    const track = s.track;
    const duration = Number(s.duration);
    const time = Number(s.time);
    const hasTrack = Boolean(track);
    const validDuration = hasTrack && Number.isFinite(duration) && duration > 0;
    return {
      title: hasTrack ? track.title || "" : "",
      artist: hasTrack ? track.meta || "" : "",
      /* Relativa (/api/...) o absoluta (https): Kotlin distingue las dos y
         anade el host local y el token solo a las relativas. */
      artwork: hasTrack ? track.artwork || "" : "",
      playing: hasTrack && Boolean(s.playing),
      buffering: hasTrack && Boolean(s.buffering),
      position: hasTrack
        ? clamp(Number.isFinite(time) ? time : 0, 0, validDuration ? duration : Infinity)
        : 0,
      duration: validDuration ? duration : 0,
      hasNext: hasTrack && s.index >= 0 && s.index + 1 < s.queue.length,
      hasPrev: hasTrack && s.index > 0,
    };
  };

  /* Firma barata: el puente recibia un `timeupdate` 4 veces por segundo y
     construia un JSON con todos los campos para descubrir que no habia cambio.
     Aqui solo se mira lo que NO es posicion; el `JSON.stringify` del payload
     ocurre unicamente cuando de verdad se va a enviar. */
  const signature = (s) => {
    const t = s.track;
    return [
      t.title, t.meta, t.artwork, s.playing, s.buffering,
      s.duration, s.index, s.queue.length,
    ].join("\u0000");
  };

  const send = (payload, sig) => {
    bridge.mediaUpdate(JSON.stringify(payload));
    lastSig = sig;
    lastAt = now();
    lastPos = payload.position;
    lastRunning = payload.playing && !payload.buffering;
    sent = true;
  };

  const apply = (s, force = false) => {
    if (!s.track) {
      if (!cleared) {
        if (typeof bridge.mediaClear === "function") bridge.mediaClear();
        cleared = true;
      }
      lastSig = null;
      lastPos = -1;
      return;
    }
    cleared = false;
    const position = Number(s.time);
    const dur = Number(s.duration);
    const pos = clamp(
      Number.isFinite(position) ? position : 0,
      0,
      Number.isFinite(dur) && dur > 0 ? dur : Infinity
    );
    const sig = signature(s);
    const drift = Math.abs(pos - lastPos);
    const due = now() - lastAt >= throttleMs && drift >= DRIFT_MIN_SECONDS;
    /* Mientras suena, el sistema avanza la barra solo: un salto es lo que se
       aparta de esa prediccion, no el avance normal de la cancion. Cubre a los
       motores que no exponen onSeek. */
    const expected = lastPos + (lastRunning ? (now() - lastAt) / 1000 : 0);
    const jump = Math.abs(pos - expected) > JUMP_SECONDS;
    if (force || sig !== lastSig || jump || due) send(snapshot(s), sig);
  };

  const offSeek =
    typeof engine.onSeek === "function"
      ? engine.onSeek(() => {
          seekEpoch += 1;
        })
      : () => {};

  const off = engine.subscribe(() => {
    const force = seekEpoch !== handledEpoch;
    handledEpoch = seekEpoch;
    apply(engine.getState(), force);
  });

  const onEvent = (e) => {
    const detail = e?.detail;
    switch (detail?.action) {
      case "play":
        engine.resume();
        break;
      case "pause":
        engine.pause();
        break;
      case "next":
        engine.next();
        break;
      case "prev":
        engine.prev();
        break;
      case "seekto":
        if (Number.isFinite(detail.time)) engine.seek(detail.time);
        break;
      default:
        break;
    }
  };
  window.addEventListener("spitifo-media", onEvent);
  apply(engine.getState());
  handledEpoch = seekEpoch;

  return () => {
    off();
    offSeek();
    window.removeEventListener("spitifo-media", onEvent);
    if (sent && !cleared && typeof bridge.mediaClear === "function") bridge.mediaClear();
  };
}
