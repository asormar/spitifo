import { useSyncExternalStore } from "react";
import { API } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   HISTORIAL DE ESCUCHA

   Un almacen externo como playlists.js: una foto inmutable que se reemplaza
   entera y se avisa a los suscriptores. `load` trae el resumen del backend y
   `record` aplica un evento local al instante, para que "Seguir escuchando" y
   "Mas escuchadas" se muevan sin esperar al servidor.

   El tracker (player/listens.js) llama a `record` con cada evento que emite;
   el backend es quien guarda la verdad definitiva y `load(force)` la recupera
   al abrir la app o al cambiar de dispositivo.
   ------------------------------------------------------------------------- */

const EMPTY = Object.freeze({ ready: false, error: false, tracks: {}, recent: [] });
const HALF_LIFE_DAYS = 60;
const DAY_SECONDS = 86400;
const RECENT_LIMIT = 30;
const FINISHED_MS = 10_000;

/* Con Drive el resumen tarda mas de un segundo: sin foto previa "Seguir
   escuchando" apareceria tarde arriba de todo y empujaria la pantalla. Igual
   que la biblioteca, se pinta la de la vez anterior y la real la reemplaza. */
const CACHE_KEY = "spitifo:history";
const localCache = {
  read: () => {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY));
    } catch {
      return null;
    }
  },
  write: (snapshot) => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
    } catch {
      /* Sin almacenamiento se sigue sin foto. */
    }
  },
};

export function createHistory({
  fetchFn = (...a) => fetch(...a),
  now = () => Date.now() / 1000,
  cache = localCache,
} = {}) {
  const cached = cache?.read();
  let state = {
    ...EMPTY,
    tracks: cached?.tracks && typeof cached.tracks === "object" ? cached.tracks : {},
    recent: Array.isArray(cached?.recent) ? cached.recent : [],
  };
  const listeners = new Set();
  let loading = null;

  const emit = (patch) => {
    state = { ...state, ...patch };
    if ("tracks" in patch || "recent" in patch) {
      cache?.write({ tracks: state.tracks, recent: state.recent });
    }
    listeners.forEach((fn) => fn());
  };
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  const load = (force = false) => {
    if (loading) return loading;
    if (state.ready && !force) return Promise.resolve();
    loading = fetchFn(`${API}/listens/summary`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error("http");
        emit({
          ready: true,
          error: false,
          tracks: d.tracks && typeof d.tracks === "object" ? d.tracks : {},
          recent: Array.isArray(d.recent) ? d.recent.slice(0, RECENT_LIMIT) : [],
        });
      })
      .catch(() => emit({ ready: false, error: true }))
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  /* Aplica UN evento a la foto local. El score local repite la regla del
     backend (vida media de 60 dias) para que la lista no salte al recargar. */
  const record = (event) => {
    if (!event || typeof event.k !== "string" || !event.k) return false;
    const t = Number(event.t) || Math.floor(now());
    const previous = state.tracks[event.k] || {
      plays: 0,
      skips: 0,
      listened_ms: 0,
      last: 0,
      score: 0,
      pos: 0,
      dur: 0,
    };
    const elapsed = previous.last ? Math.max(0, t - previous.last) : 0;
    let score =
      (Number(previous.score) || 0) *
      2 ** (-(elapsed / DAY_SECONDS) / HALF_LIFE_DAYS);
    const outcome = event.o;
    if (outcome === "play") score += 1;
    else if (outcome === "skip") score = Math.max(0, score - 0.5);
    score = Math.max(0, score);

    const latest = t >= (previous.last || 0);
    const track = {
      ...previous,
      plays: previous.plays + (outcome === "play" ? 1 : 0),
      skips: previous.skips + (outcome === "skip" ? 1 : 0),
      listened_ms: previous.listened_ms + (Number(event.l) || 0),
      last: latest ? t : previous.last,
      score,
      pos: latest ? Number(event.p) || 0 : previous.pos,
      dur: latest ? Number(event.d) || 0 : previous.dur,
    };

    const entry = {
      key: event.k,
      last: track.last,
      pos: track.pos,
      dur: track.dur,
      o: latest ? outcome : state.recent.find((e) => e.key === event.k)?.o,
    };
    const recent = [entry, ...state.recent.filter((e) => e.key !== event.k)]
      .sort((a, b) => b.last - a.last)
      .slice(0, RECENT_LIMIT);

    emit({ tracks: { ...state.tracks, [event.k]: track }, recent });
    return true;
  };

  return { subscribe, getState: () => state, load, record };
}

export const history = createHistory();

export function useHistory(selector = (s) => s) {
  return useSyncExternalStore(history.subscribe, () => selector(history.getState()));
}

/* "Seguir escuchando": lo que quedo a medias. Si no hay nada a medias se
   devuelve la ultima pista, para que la seccion no quede vacia. */
export function continueListening(state, n = 5) {
  const recent = state?.recent || [];
  const unfinished = recent.filter(
    (e) => Number(e.pos) < Number(e.dur) - FINISHED_MS
  );
  const list = unfinished.length ? unfinished : recent.slice(0, 1);
  return list.slice(0, Math.max(0, n));
}

/* "Mas escuchadas": claves por plays y, en empate, por el ultimo evento. */
export function mostPlayed(state, n = 5) {
  const tracks = state?.tracks || {};
  return Object.entries(tracks)
    .sort(
      ([, a], [, b]) =>
        (Number(b.plays) || 0) - (Number(a.plays) || 0) ||
        (Number(b.last) || 0) - (Number(a.last) || 0)
    )
    .slice(0, Math.max(0, n))
    .map(([key]) => key);
}
