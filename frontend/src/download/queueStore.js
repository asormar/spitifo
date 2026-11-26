import { useSyncExternalStore } from "react";
import { API, errMsg, rowKey } from "../shared/api.js";
import { setJobFor } from "./jobsStore.js";
import { verdictStore } from "./verdict.js";
import { groupToast, reattachText } from "./albumText.js";
import { markQueueReady } from "./queueBoot.js";
import { isScreenOff } from "../shared/screenState.js";

/* ---------------------------------------------------------------------------
   COLA DE DESCARGAS (espejo del servidor)

   La cola vive en el backend: este modulo solo la mira. Un sondeo compartido
   lee GET /api/downloads y publica cada item en jobsStore (bajo la clave de su
   fila) para que el anillo, la ficha y la hoja vean el MISMO estado. No hay
   límite de concurrencia ni contador propio: eso lo decide el servidor.

   Un corte de red no es un fallo: el espejo sigue con el ultimo estado conocido,
   marca `offline` y reintenta con espera creciente. No toca window en Node.
   ------------------------------------------------------------------------- */

export const BUSY_STATES = new Set(["queued", "pending", "downloading", "processing", "saving"]);
const ACTIVE_STATES = new Set(["pending", "downloading", "processing", "saving"]);
const TERMINAL_STATES = new Set(["done", "error", "cancelled"]);
/* Sondeo ADAPTATIVO (P-downloads-pipeline-7): rapido mientras una pista baja o
   sube, mas lento si solo hay items en cola, y parado cuando no hay trabajo. */
export const POLL_ACTIVE_MS = 400;
export const POLL_QUEUED_MS = 1500;
export const POLL_IDLE_MS = 10000;
export const POLL_TIMEOUT_MS = 10000;

/* Pura, para probar los tres regimenes sin temporizadores. `null` = no sondear. */
export function pollDelay({ offline = false, busy = false, active = false,
  sheetOpen = false, items = 0, retryDelay = 1000, capHits = 0, screenOff = false } = {}) {
  if (offline && !busy && !sheetOpen && capHits >= 2) return null;
  if (offline) return retryDelay;
  /* Con la pantalla de verdad apagada (no solo la pestana tapada: ver
     shared/screenState.js) una descarga activa no necesita el sondeo rapido
     de "alguien mira el anillo": con el lento alcanza para que no se note al
     volver. */
  if (screenOff && busy) return POLL_IDLE_MS;
  if (active) return POLL_ACTIVE_MS;
  if (busy) return POLL_QUEUED_MS;
  if (sheetOpen && items) return POLL_IDLE_MS;
  return null;
}

/* Espera del reintento cuando no hay red: 1, 2, 4, 8 y tope de 15 s. Pura, para
   probarla sin temporizadores. */
export function backoffDelay(attempt) {
  return Math.min(15000, 1000 * 2 ** Math.max(0, attempt));
}

export function normalizeItem(raw) {
  const track = raw?.track || {};
  return {
    ...raw,
    rk: rowKey(track),
    title: track.title || "",
    progress: Number(raw?.progress) || 0,
  };
}

/* Los items sin grupo son su propio grupo de una pista. El id del grupo (el del
   trabajo) es estable entre sondeos, asi que la hoja no pierde la fila. */
export function groupItems(items = []) {
  const groups = [];
  const byId = new Map();
  for (const it of items) {
    const g = it.group;
    if (g && g.id) {
      let group = byId.get(g.id);
      if (!group) {
        group = {
          id: g.id,
          title: g.title || g.id,
          artwork_url: g.artwork_url || null,
          single: false,
          items: [],
        };
        byId.set(g.id, group);
        groups.push(group);
      }
      group.items.push(it);
    } else {
      groups.push({
        id: `single:${it.id}`,
        title: it.title,
        artwork_url: null,
        single: true,
        items: [it],
      });
    }
  }
  return groups;
}

export function groupSummary(group) {
  const items = group?.items || [];
  const count = (s) => items.filter((i) => i.status === s).length;
  const done = count("done");
  const failed = count("error");
  const cancelled = count("cancelled");
  const running = items.filter((i) => ACTIVE_STATES.has(i.status)).length;
  const queued = count("queued");
  return {
    total: items.length,
    done,
    failed,
    cancelled,
    running,
    queued,
    ended: !items.some((i) => BUSY_STATES.has(i.status)),
  };
}

/* El grupo con algo en marcha: lo que mira la pildora. */
export const activeGroup = (groups) =>
  /* Primero el que de verdad esta bajando: los grupos vienen del mas nuevo al
     mas viejo y el mas nuevo suele estar esperando turno. */
  groups.find((g) => g.items.some((i) => ACTIVE_STATES.has(i.status))) ||
  groups.find((g) => g.items.some((i) => BUSY_STATES.has(i.status))) ||
  null;

/* Lo que publica el espejo en jobsStore. Los estados "saving" del servidor se
   traducen a la fase que ya entiende dlState (processing + phase saving). */
export function jobPatch(it) {
  const pct = Math.min(100, Math.max(0, Math.round(it.progress || 0)));
  const title = it.title;
  switch (it.status) {
    case "queued":
      return { status: "queued", phase: it.phase || null, progress: 0, title };
    case "pending":
      return { status: "pending", phase: it.phase || null, progress: 0, title };
    case "downloading":
      return { status: "downloading", phase: it.phase || "downloading", progress: pct, title };
    case "processing":
      return { status: "processing", phase: it.phase || "processing", progress: pct, title };
    case "saving":
      /* `uploading` trae su propio porcentaje de bytes; el resto sigue en 100. */
      return {
        status: "processing",
        phase: it.phase || "saving",
        progress: it.phase === "uploading" ? pct : 100,
        title,
      };
    case "done":
      /* `key` deja que la tarjeta de progreso ofrezca "Ver en biblioteca". */
      return { status: "done", phase: null, progress: 100, title, key: it.key };
    case "error":
      return { status: "error", phase: null, progress: pct, title, error: it.error, error_code: it.error_code };
    case "cancelled":
      return { status: "cancelled", phase: null, progress: pct, title };
    default:
      return { status: it.status, phase: it.phase || null, progress: pct, title };
  }
}

const defaultFetch = (...a) => fetch(...a);

/* R2: el tipo de conexion lo da el Bridge nativo de Android (el unico que
   distingue roaming) o `navigator.connection`. Sin dato, `unknown` no bloquea.
   Las dos preferencias se leen del mismo localStorage que Ajustes escribe. */
export function networkPayload() {
  const win = typeof window === "undefined" ? null : window;
  let type = "unknown";
  try {
    type = win?.SpitifoAndroid?.connectionType?.() || type;
  } catch { /* bridge anterior sin este metodo */ }
  const c = win?.navigator?.connection;
  if (type === "unknown" && c?.type) type = c.type;
  if (type === "unknown" && c?.effectiveType) type = "cellular";
  const pref = (k, d) => {
    try {
      const v = win?.localStorage?.getItem(k);
      return v == null ? d : v === "1";
    } catch { return d; }
  };
  return {
    type: String(type).toLowerCase(),
    online: win?.navigator?.onLine !== false && type !== "none",
    wifi_only: pref("spitifo:download-wifi-only", false),
    roaming_allowed: pref("spitifo:download-roaming-allowed", true),
  };
}

function reportNetwork(fetchImpl) {
  try {
    fetchImpl(`${API}/downloads/network`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(networkPayload()),
    });
  } catch { /* sin red, la cola sigue con el ultimo estado */ }
}

export function createQueueStore(fetchImpl = defaultFetch) {
  let state = { items: [], groups: [], running: 0, queued: 0, offline: false };
  const listeners = new Set();
  const waiters = new Map();
  const published = new Map();
  const resumed = new Map();
  let hooks = {};
  let timer = null;
  let sheetOpen = false;
  let bound = false;
  let unbindNetwork = null;
  let disposed = false;
  let hydrated = false;
  let firstPayload = true;
  let pendingReattach = false;
  let failures = 0;
  let retryDelay = backoffDelay(0);
  /* Un solo sondeo a la vez. Si llega otro mientras corre, se pide uno mas al
     terminar: el ultimo payload gana siempre. */
  let inFlight = null;
  let again = false;
  /* Sin red, sin trabajo y sin hoja: dos topes de 15 s y se deja de insistir. */
  let capHits = 0;

  const emit = (patch = {}) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };

  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  /* La forma de resultado (o de error) que hoy recibe quien pulso descargar. */
  const resultOf = (it) => {
    if (it.status === "done") {
      return {
        value: {
          filename: it.filename || it.key,
          size_mb: it.size_mb,
          match: it.match,
          real_title: it.real_title,
        },
      };
    }
    if (it.status === "cancelled") {
      const e = new Error("descarga cancelada");
      e.cancelled = true;
      return { error: e };
    }
    const e = new Error(it.error || "falló la descarga");
    e.cookies = it.error_code === "youtube_bot_check";
    return { error: e };
  };

  const settleWaiter = (it) => {
    const w = waiters.get(it.id);
    if (!w) return;
    waiters.delete(it.id);
    const out = resultOf(it);
    if (out.error) w.reject(out.error);
    else w.resolve(out.value);
  };

  const publishJob = (it) => {
    const patch = jobPatch(it);
    const sig = JSON.stringify(patch);
    if (published.get(it.id) === sig) return;
    published.set(it.id, sig);
    setJobFor(it.rk, patch);
  };

  /* Reduce un payload de GET /api/downloads. Las transiciones a terminal son
     las que disparan el veredicto, el refresco de biblioteca y el toast de grupo
     (una sola vez por transicion, aunque el sondeo siga trayendo el item). */
  const applyPayload = (d) => {
    const incoming = (d?.items || []).map(normalizeItem);
    const prevById = new Map(state.items.map((i) => [i.id, i]));
    const prevGroups = groupItems(state.items);
    const alive = new Set(incoming.map((i) => i.id));

    for (const key of published.keys()) if (!alive.has(key)) published.delete(key);
    for (const key of resumed.keys()) if (!alive.has(key)) resumed.delete(key);

    /* ids de grupo (el mismo que arma groupItems: el del grupo, o
       "single:<id>" sin uno) con al menos una pista recien terminada SIN fila
       esperandola. Se refresca la biblioteca una vez por GRUPO cuando
       termina, no una vez por pista: un album de 15 hacia 15 rescans
       completos (P-downloads-pipeline-2, P-render-main-thread-1). Para una
       descarga suelta su "grupo" es ella misma, asi que sigue refrescando en
       el acto, como siempre. */
    const needsLibraryRefresh = new Set();

    for (const it of incoming) {
      const prev = prevById.get(it.id);
      if (!firstPayload || BUSY_STATES.has(it.status)) publishJob(it);

      if (it.status === "done" && prev?.status !== "done") {
        if (it.match) verdictStore.setFromDownload(it.track, it.query || "", { match: it.match, real_title: it.real_title });
        /* La fila que espera este item ya refresca la biblioteca al resolverse.
           Al abrir no hay nada que refrescar: App ya pidio /api/library. */
        if (!firstPayload && !waiters.has(it.id)) {
          needsLibraryRefresh.add(it.group?.id || `single:${it.id}`);
        }
        settleWaiter(it);
      } else if ((it.status === "error" || it.status === "cancelled") && prev?.status !== it.status) {
        settleWaiter(it);
      }

      const from = resumed.get(it.id);
      if (from != null) {
        if (BUSY_STATES.has(it.status) && Math.round(it.progress) < from + 1) it.resumedFrom = from;
        else resumed.delete(it.id);
      }
    }

    const groups = groupItems(incoming);
    if (pendingReattach) {
      pendingReattach = false;
      const busy = incoming.filter((i) => BUSY_STATES.has(i.status)).length;
      if (busy) hooks.onToast?.(reattachText(busy));
    }

    const wasEnded = new Map(prevGroups.map((g) => [g.id, groupSummary(g).ended]));
    for (const g of groups) {
      const s = groupSummary(g);
      if (needsLibraryRefresh.has(g.id) && s.ended) hooks.onLibrary?.();
      if (g.single) continue;
      if (s.ended && wasEnded.get(g.id) === false) hooks.onToast?.(groupToast(g.title, s));
    }

    firstPayload = false;
    emit({
      items: incoming,
      groups,
      running: Number.isFinite(d?.running) ? d.running : incoming.filter((i) => ACTIVE_STATES.has(i.status)).length,
      queued: Number.isFinite(d?.queued) ? d.queued : incoming.filter((i) => i.status === "queued").length,
    });
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = null;
    if (disposed) return;
    /* Con la pestana tapada no sondeamos: en el telefono ahorra bateria.
       visibilitychange ya llama a wake() en cuanto vuelve a ser visible. */
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const busy = state.items.some((i) => BUSY_STATES.has(i.status));
    const active = state.items.some((i) => ACTIVE_STATES.has(i.status));
    const delay = pollDelay({
      offline: state.offline,
      busy,
      active,
      sheetOpen,
      items: state.items.length,
      retryDelay,
      capHits,
      screenOff: isScreenOff(),
    });
    /* Sin trabajo y con la hoja cerrada NO queda sondeando: el siguiente
       online/visible o una accion del usuario lo despierta. */
    if (delay === null) return;
    timer = setTimeout(poll, delay);
  };

  /* Al volver la red se guarda el ultimo porcentaje conocido de lo que corria:
     la fila dice «Retomando desde N %» hasta que avance otro 1 %. */
  const markResumed = () => {
    if (!state.offline) return;
    const items = state.items.map((it) => {
      const pct = Math.round(it.progress || 0);
      if (!BUSY_STATES.has(it.status) || pct <= 0) return it;
      resumed.set(it.id, pct);
      return { ...it, resumedFrom: pct };
    });
    emit({ items, groups: groupItems(items) });
  };

  const runPoll = async () => {
    clearTimeout(timer);
    timer = null;
    /* Un GET colgado no puede dejar el espejo atrapado: se corta a los 10 s y
       cuenta como fallo, asi que entra la misma espera creciente de siempre. */
    const ac = new AbortController();
    const deadline = setTimeout(() => ac.abort(), POLL_TIMEOUT_MS);
    try {
      const r = await fetchImpl(`${API}/downloads`, { signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      markResumed();
      applyPayload(d);
      failures = 0;
      retryDelay = backoffDelay(0);
      capHits = 0;
      if (state.offline) emit({ offline: false });
    } catch (e) {
      /* El primer reintento es a 1 s; el siguiente a 2, 4, 8 y tope de 15 s. */
      retryDelay = backoffDelay(failures);
      failures += 1;
      capHits = retryDelay >= 15000 ? capHits + 1 : 0;
      if (!state.offline) emit({ offline: true });
    } finally {
      clearTimeout(deadline);
      schedule();
    }
  };

  /* Un solo sondeo en vuelo. Si el temporizador, un cancelar/reintentar o una
     nueva descarga piden otro mientras corre, no se lanza una segunda peticion:
     se pide una pasada mas al terminar y se devuelve la promesa en curso. Asi
     una respuesta vieja nunca puede pisar el estado mas reciente. */
  function poll() {
    if (disposed) return Promise.resolve();
    if (inFlight) {
      again = true;
      return inFlight;
    }
    const p = runPoll().finally(() => {
      inFlight = null;
      if (again) {
        again = false;
        poll();
      }
    });
    inFlight = p;
    return p;
  }

  const bindWindow = () => {
    if (bound || typeof window === "undefined" || typeof document === "undefined") return;
    bound = true;
    const wake = () => {
      markResumed();
      failures = 0;
      retryDelay = backoffDelay(0);
      capHits = 0;
      if (state.offline) emit({ offline: false });
      poll();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") wake();
    });
    /* R2: la cola informa el tipo de conexion al backend y reacciona a los
       cambios que reporta el Bridge de Android / navigator.connection. */
    /* Solo el store real reporta: los tests inyectan su propio transporte. */
    if (fetchImpl === defaultFetch) {
      reportNetwork(fetchImpl);
      const onChange = () => { reportNetwork(fetchImpl); poll(); };
      window.addEventListener("online", onChange);
      window.addEventListener("spitifo-network", onChange);
      unbindNetwork = () => {
        window.removeEventListener("online", onChange);
        window.removeEventListener("spitifo-network", onChange);
      };
    }
  };

  /* Al abrir: con payload (el GET del sondeo de arranque) se aplica directo, sin
     otra peticion, y sale el aviso de reenganche con el. Sin payload se hace un
     unico GET, igual que antes. Sin nada pendiente no queda sondeando. */
  const hydrate = (payload) => {
    if (hydrated || disposed) return Promise.resolve();
    hydrated = true;
    pendingReattach = true;
    bindWindow();
    if (payload) {
      applyPayload(payload);
      failures = 0;
      retryDelay = backoffDelay(0);
      capHits = 0;
      if (state.offline) emit({ offline: false });
      schedule();
      return Promise.resolve();
    }
    return poll();
  };

  const request = async (url, init) => {
    const r = await fetchImpl(url, init);
    if (!r.ok && r.status !== 404 && r.status !== 409) {
      const d = await r.json().catch(() => ({}));
      throw new Error(errMsg(d, "no se pudo actualizar la descarga"));
    }
    poll();
    return r;
  };

  const enqueue = async ({ items = [], group } = {}) => {
    try {
      const r = await fetchImpl(`${API}/downloads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, ...(group ? { group } : {}) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(errMsg(d, "no se pudo encolar la descarga"));
      poll();
      return d.items || [];
    } catch (e) {
      failures = 0;
      retryDelay = backoffDelay(0);
      capHits = 0;
      if (!state.offline) emit({ offline: true });
      poll();
      throw e;
    }
  };

  const cancel = (id) =>
    request(`${API}/downloads/${encodeURIComponent(id)}/cancel`, { method: "POST" });

  const cancelGroup = (groupId) =>
    request(`${API}/downloads/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: groupId }),
    });

  const retry = (id) => request(`${API}/downloads/${encodeURIComponent(id)}/retry`, { method: "POST" });

  const waitForItem = (id) =>
    new Promise((resolve, reject) => {
      const found = state.items.find((i) => i.id === id);
      const settle = (it) => {
        const out = resultOf(it);
        if (out.error) reject(out.error);
        else resolve(out.value);
      };
      /* La respuesta del POST puede llegar despues de que el sondeo ya vio el
         final: en ese caso no se espera, se devuelve el resultado ya conocido. */
      if (found && TERMINAL_STATES.has(found.status)) {
        settle(found);
        return;
      }
      waiters.set(id, { resolve, reject });
    });

  const itemFor = (rk, groupId) => {
    const inGroup = groupId && state.groups.find((g) => g.id === groupId)?.items.find((i) => i.rk === rk);
    return inGroup || state.items.find((i) => i.rk === rk) || null;
  };

  return {
    subscribe,
    getState: () => state,
    getOffline: () => state.offline,
    setHooks: (h) => {
      hooks = h || {};
    },
    setSheetOpen: (open) => {
      sheetOpen = Boolean(open);
      schedule();
    },
    hydrate,
    bind: bindWindow,
    pollNow: poll,
    applyPayload,
    enqueue,
    cancel,
    cancelGroup,
    retry,
    waitForItem,
    itemFor,
    has: (groupId, rk) => Boolean(itemFor(rk, groupId)),
    dispose: () => {
      disposed = true;
      unbindNetwork?.();
      clearTimeout(timer);
      timer = null;
    },
  };
}

export const queueStore = createQueueStore();

export const useQueueState = () => useSyncExternalStore(queueStore.subscribe, queueStore.getState);

/* Avisa al arranque de que el espejo ya esta listo: App registra sus hooks y
   pinta la pildora aunque este modulo llego mas tarde que ella. */
markQueueReady({ queueStore });
