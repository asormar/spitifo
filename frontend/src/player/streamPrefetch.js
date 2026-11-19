import { API } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   ADELANTAR EL SIGUIENTE STREAM

   El backend resuelve la URL del formato en ~0,2 s en el PC, pero en un
   telefono yt-dlp tarda mas, y "siguiente" se puede tocar en cualquier
   momento. Por eso la siguiente se prepara en cuanto la actual empieza a
   sonar: una sola peticion por pista, sin esperar respuesta y sin molestar si
   no hay siguiente. La URL preparada vale horas (el backend la guarda).
   ------------------------------------------------------------------------- */

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
  return Boolean(state.playing);
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
