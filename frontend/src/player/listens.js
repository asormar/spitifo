import { API } from "../shared/api.js";
import { history } from "../listen/history.js";

/* ---------------------------------------------------------------------------
   HISTORIAL DE ESCUCHA (frontend)

   `classify` es la regla del ADR 0003, pura y testeable. El tracker escucha al
   motor y acumula tiempo desde los `timeupdate` (deltas), ignorando saltos de
   mas de 1.5 s para que un seek no cuente como escucha.

   Una sesion emite UN solo evento al cerrarse (ended, cambio de pista o
   pagehide). Los eventos se agrupan y se mandan a /api/listens; si el envio
   falla quedan en memoria para reintentarlos (tope de 200) y al cerrar la
   pagina se usa sendBeacon.
   ------------------------------------------------------------------------- */

const PLAY_MIN_MS = 30_000;
const PLAY_MAX_CREDIT_MS = 240_000;
const SKIP_MAX_MS = 30_000;
const SEEK_JUMP_MS = 1_500;
const FLUSH_EVERY = 10;
const MAX_PENDING = 200;
const JSON_HEADERS = { "Content-Type": "application/json" };

export function classify({ durationMs, listenedMs, reason, repeatOne = false } = {}) {
  const duration = Math.max(0, Number(durationMs) || 0);
  const listened = Math.max(0, Number(listenedMs) || 0);
  /* Con repeat one cada final es un play, aunque la pista sea corta. */
  if (reason === "end" && repeatOne) return "play";
  const half = duration / 2;
  if (duration > PLAY_MIN_MS &&
      listened >= Math.min(half, PLAY_MAX_CREDIT_MS)) {
    return "play";
  }
  if ((reason === "next" || reason === "prev" || reason === "change") &&
      listened < SKIP_MAX_MS && listened < half) {
    return "skip";
  }
  return "partial";
}

/* Solo la musica de la biblioteca. Videos, previews y resultados de busqueda
   no tienen clave de biblioteca (o su kind no es "library"/"audio"). */
function trackable(track) {
  return Boolean(
    track &&
      typeof track.key === "string" &&
      track.key &&
      (track.kind === "library" || track.kind === "audio")
  );
}

const defaultSend = async (events) => {
  const r = await fetch(`${API}/listens`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ events }),
  });
  if (!r.ok) throw new Error("http");
};

export function createListenTracker(engine, {
  send = defaultSend,
  now = () => Date.now(),
  record = (event) => history.record(event),
  flushEvery = FLUSH_EVERY,
  flushDelayMs = 5_000,
  windowRef = typeof window === "undefined" ? null : window,
  navigatorRef = typeof navigator === "undefined" ? null : navigator,
} = {}) {
  let session = null;
  let pending = [];
  let flushing = null;
  let timer = null;

  const trim = () => {
    if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
  };

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = () => {
    if (timer !== null || !flushDelayMs) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushDelayMs);
  };

  const flush = (beacon = false) => {
    clearTimer();
    if (beacon) {
      if (!pending.length || !navigatorRef?.sendBeacon) return;
      const body = JSON.stringify({ events: pending });
      const blob = new Blob([body], { type: "application/json" });
      if (navigatorRef.sendBeacon(`${API}/listens`, blob)) pending = [];
      return;
    }
    if (flushing) return flushing;
    if (!pending.length) return Promise.resolve();
    const batch = pending;
    pending = [];
    flushing = Promise.resolve(send(batch))
      .catch(() => {
        /* El lote vuelve al frente y se recorta: se reintenta en el proximo
           flush o al cerrar la pagina. */
        pending = [...batch, ...pending];
        trim();
      })
      .finally(() => {
        flushing = null;
      });
    return flushing;
  };

  const emit = (track, durationMs, listenedMs, positionMs, reason, repeatOne) => {
    const event = {
      t: Math.floor(now() / 1000),
      k: track.key,
      d: Math.max(0, Math.round(durationMs)),
      l: Math.max(0, Math.round(listenedMs)),
      p: Math.max(0, Math.round(positionMs)),
      r: reason,
      o: classify({
        durationMs,
        listenedMs,
        reason,
        repeatOne: Boolean(repeatOne),
      }),
    };
    record(event);
    pending.push(event);
    trim();
    if (pending.length >= flushEvery) flush();
    else schedule();
  };

  const start = (state) => {
    const track = state.track;
    if (!trackable(track)) return;
    const durationMs = Math.max(
      0,
      Math.round((state.duration || track.duration || 0) * 1000)
    );
    const at = Math.max(0, (state.time || 0) * 1000);
    session = {
      key: track.key,
      track,
      durationMs,
      listenedMs: 0,
      lastMs: at,
      posMs: at,
    };
  };

  const close = (reason, repeatOne = false) => {
    if (!session) return;
    const state = engine.getState();
    const durationMs = Math.max(
      session.durationMs,
      Math.round((state.duration || 0) * 1000)
    );
    const finished = reason === "end";
    const listenedMs = Math.min(
      session.listenedMs,
      durationMs || session.listenedMs
    );
    const positionMs = finished
      ? durationMs
      : Math.min(session.posMs, durationMs || session.posMs);
    emit(session.track, durationMs, listenedMs, positionMs, reason, repeatOne);
    session = null;
  };

  const onState = () => {
    const state = engine.getState();
    const track = state.track;
    if (!session) {
      if (state.playing && trackable(track)) start(state);
      return;
    }
    if (!track || track.key !== session.key) {
      /* Un cambio que no aviso el motor (defensa): se cierra como cambio. */
      close("change");
      if (state.playing && trackable(track)) start(state);
      return;
    }
    const at = Math.max(0, (state.time || 0) * 1000);
    if (state.playing) {
      const delta = at - session.lastMs;
      /* Un salto grande es un seek, no escucha. */
      if (delta > 0 && delta <= SEEK_JUMP_MS) session.listenedMs += delta;
    }
    session.lastMs = at;
    session.posMs = at;
    const durationMs = Math.round((state.duration || 0) * 1000);
    if (durationMs > 0) session.durationMs = durationMs;
  };

  const onTrackEvent = (event) => {
    if (event?.type === "change") {
      close(event.reason || "change");
    } else if (event?.type === "end") {
      close("end", Boolean(event.repeatOne));
    }
  };

  const onHide = () => {
    close("close");
    flush(true);
  };

  const unsubscribe = engine.subscribe(onState);
  const offTrack = typeof engine.onTrackEvent === "function"
    ? engine.onTrackEvent(onTrackEvent)
    : () => {};
  windowRef?.addEventListener("pagehide", onHide);
  /* Estado inicial: el motor pudo tener una pista antes de engancharse. */
  onState();

  return {
    getPending: () => pending.length,
    flush,
    stop: () => {
      clearTimer();
      close("close");
      flush();
      unsubscribe();
      offTrack();
      windowRef?.removeEventListener("pagehide", onHide);
    },
  };
}
