import { useSyncExternalStore } from "react";
import { API } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   RECOMENDACIONES ("PARA TI")

   Un almacen externo como history.js y playlists.js: una foto inmutable que se
   reemplaza entera y se avisa a los suscriptores. Guarda lo que responde
   GET /api/discover (generos del usuario, artistas candidatos y el estado de
   las consultas en segundo plano).

   - La ultima foto se guarda en localStorage: el panel pinta al instante lo de
     la vez anterior y la respuesta real lo reemplaza.
   - Mientras alguien mira (`watch`) se vuelve a pedir cada POLL_MS, y solo
     mientras el servidor diga que sigue trabajando (`status.running`).
   - "No me interesa" es optimista: el artista sale de la lista al instante y
     el POST va en cadena por artista, para que un "deshacer" no llegue antes
     que el descarte. Si falla, vuelve a la lista y se avisa.
   - Un artista ocultado en esta sesion se filtra tambien de las respuestas
     nuevas: un GET que salio antes del POST no lo resucita.

   El modulo no toca window ni document para poder importarse en Node.
   ------------------------------------------------------------------------- */

export const POLL_MS = 4000;
const JSON_HEADERS = { "Content-Type": "application/json" };
const CACHE_KEY = "spitifo:reco";

const IDLE = Object.freeze({ done: 0, total: 0, running: false, offline: false });

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

const count = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === "string" && s) : []);

export function cleanStatus(raw) {
  if (!raw || typeof raw !== "object") return IDLE;
  return {
    done: count(raw.done),
    total: count(raw.total),
    running: raw.running === true,
    offline: raw.offline === true,
  };
}

export function cleanGenres(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g) => g && typeof g.name === "string" && g.name && Number.isFinite(g.share) && g.share > 0)
    .map((g) => ({ name: g.name, share: g.share }));
}

export function cleanArtists(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const a of raw) {
    if (!a || typeof a.name !== "string" || !a.name.trim() || seen.has(a.name)) continue;
    seen.add(a.name);
    out.push({
      name: a.name,
      mbid: typeof a.mbid === "string" ? a.mbid : null,
      score: Number.isFinite(a.score) ? a.score : 0,
      because: strings(a.because),
      genres: strings(a.genres),
    });
  }
  return out;
}

/* Los candidatos sin los ocultados en esta sesion. `hidden`: nombres. */
export function visibleArtists(artists, hidden) {
  if (!hidden.length) return artists;
  const gone = new Set(hidden);
  return artists.filter((a) => !gone.has(a.name));
}

/* "Porque escuchas X y Y" a partir de los artistas que mas aportaron. */
export function becauseText(because) {
  const list = Array.isArray(because) ? because.filter(Boolean).slice(0, 2) : [];
  if (!list.length) return "";
  return `Porque escuchas ${list.join(" y ")}`;
}

export function createReco({
  fetchFn = (...a) => fetch(...a),
  cache = localCache,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  const cached = cache?.read();
  let state = {
    ready: false,
    loading: false,
    error: false,
    status: IDLE,
    genres: cleanGenres(cached?.genres),
    artists: cleanArtists(cached?.artists),
    hidden: [],
  };
  const listeners = new Set();
  const errorListeners = new Set();
  /* nombre -> { tail, epoch }: cola de escrituras de ese artista. */
  const chains = new Map();
  let loading = null;
  let watching = 0;
  let timer = null;

  const writeCache = () => {
    cache?.write({
      genres: state.genres,
      artists: visibleArtists(state.artists, state.hidden),
    });
  };
  const emit = (patch, persist = false) => {
    state = { ...state, ...patch };
    if (persist) writeCache();
    listeners.forEach((fn) => fn());
  };
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const onError = (fn) => {
    errorListeners.add(fn);
    return () => errorListeners.delete(fn);
  };

  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  /* Otra consulta en POLL_MS, solo si alguien mira y el servidor sigue
     trabajando. Un fallo de red no corta el ciclo si ya estaba en marcha. */
  const schedule = () => {
    stopTimer();
    if (watching > 0 && state.status.running) {
      timer = setTimer(() => {
        timer = null;
        load(true);
      }, POLL_MS);
    }
  };

  function load(force = false) {
    if (loading) return loading;
    if (state.ready && !force) return Promise.resolve();
    /* Solo la primera carga es "cargando": las siguientes repintan en silencio. */
    if (!state.ready) emit({ loading: true });
    loading = fetchFn(`${API}/discover`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error("http");
        emit(
          {
            ready: true,
            loading: false,
            error: false,
            status: cleanStatus(d.status),
            genres: cleanGenres(d.genres),
            artists: cleanArtists(d.artists),
          },
          true
        );
      })
      .catch(() => emit({ loading: false, error: true }))
      .finally(() => {
        loading = null;
        schedule();
      });
    return loading;
  }

  /* Alguien mira Descubrir: pide una vez y sigue mientras haya trabajo. La
     funcion que devuelve deja de mirar. */
  const watch = () => {
    watching += 1;
    load(true);
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      watching -= 1;
      if (watching <= 0) {
        watching = 0;
        stopTimer();
      }
    };
  };

  const fail = (name, verb, restore) => {
    restore();
    errorListeners.forEach((fn) => fn(`No se pudo ${verb} «${name}». Se deshizo el cambio.`));
  };

  /* Encadena un POST de descarte (o de deshacer) de ese artista. */
  const send = (name, undo, restore) => {
    const chain = chains.get(name) || { tail: Promise.resolve(), epoch: 0 };
    chains.set(name, chain);
    const epoch = chain.epoch;
    chain.tail = chain.tail.then(async () => {
      if (epoch !== chain.epoch) return;
      try {
        const r = await fetchFn(`${API}/discover/dismiss`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(undo ? { name, undo: true } : { name }),
        });
        if (!r.ok) throw new Error("http");
      } catch {
        chain.epoch += 1;
        fail(name, undo ? "deshacer" : "ocultar", restore);
      }
    });
  };

  const hide = (name) => {
    emit({ hidden: [...state.hidden.filter((n) => n !== name), name] }, true);
  };
  const show = (name) => {
    emit({ hidden: state.hidden.filter((n) => n !== name) }, true);
  };

  /* "No me interesa". Devuelve false si ya estaba oculto o no es un candidato. */
  const dismiss = (name) => {
    if (state.hidden.includes(name) || !state.artists.some((a) => a.name === name)) return false;
    hide(name);
    send(name, false, () => show(name));
    return true;
  };

  /* Deshacer: el artista vuelve a su sitio (la lista completa sigue ordenada). */
  const undo = (name) => {
    if (!state.hidden.includes(name)) return false;
    show(name);
    send(name, true, () => hide(name));
    return true;
  };

  const restoreAll = () => {
    [...state.hidden].forEach(undo);
  };

  return {
    subscribe,
    getState: () => state,
    onError,
    load,
    watch,
    dismiss,
    undo,
    restoreAll,
  };
}

export const reco = createReco();

export function useReco(selector = (s) => s) {
  return useSyncExternalStore(reco.subscribe, () => selector(reco.getState()));
}
