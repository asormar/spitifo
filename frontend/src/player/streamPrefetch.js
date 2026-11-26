import { API } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   ADELANTAR EL SIGUIENTE STREAM

   El backend resuelve la URL del formato en ~0,2 s en el PC, pero en un
   telefono yt-dlp tarda mas, y "siguiente" se puede tocar en cualquier
   momento. Por eso se prepara en cuanto la cola cambia: hasta DOS streams
   siguientes, de cualquier fuente (antes solo el inmediato y solo si la pista
   que sonaba era un stream). Una sola peticion por URL, sin esperar respuesta.
   La URL preparada vale horas (el backend la guarda).
   ------------------------------------------------------------------------- */

const streamUrl = (t) => {
  if (t?.kind !== "stream") return null;
  const url = t.result?.extra?.webpage_url;
  if (url) return url;
  return typeof t.key === "string" && t.key.startsWith("stream:")
    ? t.key.slice(7)
    : null;
};

export function nextStreamUrl(state) {
  return streamUrl(state?.queue?.[state.index + 1]);
}

export function shouldPrepare(state, prepared = null) {
  if (state?.track?.kind !== "stream") return false;
  const url = nextStreamUrl(state);
  if (!url || prepared === url) return false;
  return Boolean(state.playing);
}

/* Las hasta 2 URLs que conviene tener resueltas. Se omiten las que ya estan
   en el conjunto `prepared` (o en `urls`, para no repetir dentro del lote). */
export function nextStreamUrls(state, prepared = new Set(), count = 2) {
  const urls = [];
  const queue = state?.queue || [];
  const from = Number.isInteger(state?.index) ? state.index + 1 : 0;
  for (let i = from; i < queue.length && urls.length < count; i += 1) {
    const url = streamUrl(queue[i]);
    if (url && !prepared.has(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/* Sin el guard de "la actual es stream": una pista de biblioteca puede ir
   seguida de una emision, y esa transicion tambien tiene que estar caliente.
   `restore` deja playing y buffering a false, asi que no gasta red al volver. */
export function shouldPrepareAhead(state, prepared = new Set()) {
  if (!state?.track || !(state.playing || state.buffering)) return [];
  return nextStreamUrls(state, prepared);
}

export function bindStreamPrefetch(engine, { fetchFn = (...a) => fetch(...a) } = {}) {
  let prepared = new Set();
  let lastTrack = null;
  let lastArmed = false;
  const subscribe = engine.subscribeState || engine.subscribe;
  return subscribe(() => {
    const s = engine.getState();
    if (s.track?.key !== lastTrack) {
      lastTrack = s.track?.key ?? null;
      prepared = new Set();
    }
    /* El cambio de `playing` tambien arma el adelanto: la foto que publica
       `load()` todavia no dice `playing: true`. */
    const armed = Boolean(s.playing) || Boolean(s.buffering);
    if (s.track?.key === lastTrack && armed === lastArmed) return;
    lastArmed = armed;
    for (const url of shouldPrepareAhead(s, prepared)) {
      prepared.add(url);
      try {
        Promise.resolve(
          fetchFn(`${API}/stream/prepare`, {
            method: "POST",
            body: JSON.stringify({ url }),
          })
        ).catch(() => {});
      } catch {
        /* el aviso nunca puede romper la reproduccion */
      }
    }
  });
}
