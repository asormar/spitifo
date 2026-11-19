import { API } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   ADELANTAR EL SIGUIENTE STREAM

   El backend resuelve la URL del formato en ~0,2 s con el camino rapido, pero
   mejor que eso no este en el cambio de pista. Con 20 s de margen se avisa una
   vez por pista, sin esperar respuesta y sin molestar si no hay siguiente.
   ------------------------------------------------------------------------- */

export const PREPARE_WINDOW_S = 20;

export function nextStreamUrl(state) {
  const next = state?.queue?.[state.index + 1];
  if (!next || next.kind !== "stream") return null;
  const url = next.result?.extra?.webpage_url;
  if (url) return url;
  return typeof next.key === "string" && next.key.startsWith("stream:")
    ? next.key.slice(7)
    : null;
}

export function shouldPrepare(state, prepared = null) {
  if (state?.track?.kind !== "stream") return false;
  const url = nextStreamUrl(state);
  if (!url || prepared === url) return false;
  const duration = Number(state.duration) || Number(state.track.duration) || 0;
  const time = Number(state.time) || 0;
  return duration > 0 && duration - time <= PREPARE_WINDOW_S;
}

export function bindStreamPrefetch(engine, { fetchFn = (...a) => fetch(...a) } = {}) {
  let lastTrack = null;
  let prepared = null;
  return engine.subscribe(() => {
    const s = engine.getState();
    if (s.track?.key !== lastTrack) {
      lastTrack = s.track?.key ?? null;
      prepared = null;
    }
    if (!shouldPrepare(s, prepared)) return;
    const url = nextStreamUrl(s);
    prepared = url;
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
  });
}
