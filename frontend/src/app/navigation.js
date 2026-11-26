/* ---------------------------------------------------------------------------
   MODELO DE NAVEGACION

   Puro, sin React ni DOM. Cuatro pestanas (Inicio, Buscar, Tu biblioteca,
   Descubrir) y, encima de la pestana activa, UNA pila de paginas (un album, un
   artista, Ajustes...) que se vacia al cambiar de pestana.

   La URL guarda la pestana y si Ajustes esta abierto (?view=); los parametros
   q y mode son de Buscar y sobreviven. Las paginas no estan en la URL: al
   recargar se vuelve a la raiz de la pestana. Asi el boton atras de Android
   (que primero pasa por el historial del WebView) y un enlace compartido
   hacen exactamente lo mismo.
   ------------------------------------------------------------------------- */

export const TABS = ["home", "search", "library", "discover"];

const TAB_SET = new Set(TABS);
const SETTINGS = "settings";

/* Enlaces de antes de las cuatro pestanas: ?view=listen era Escuchar (ahora
   Inicio) y ?view=download era Descargar (ahora Buscar). */
const OLD_VIEWS = { listen: "home", download: "search" };

/* Parametros que solo conoce Buscar: con ellos y sin view valido, el enlace es
   de una busqueda (los de antes de que Inicio fuera la pantalla por defecto). */
const SEARCH_PARAMS = ["q", "mode", "src"];

/* `settings` gana sobre cualquier pestana: es una pagina, no una pestana. Un
   `view` desconocido o ausente no rompe: Buscar si trae una consulta, Inicio
   si no. */
export function readView(search) {
  const params = new URLSearchParams(search || "");
  const view = params.get("view");
  if (view === SETTINGS) return { tab: "home", settings: true };
  if (TAB_SET.has(view)) return { tab: view, settings: false };
  if (OLD_VIEWS[view]) return { tab: OLD_VIEWS[view], settings: false };
  const hasSearch = SEARCH_PARAMS.some((k) => params.has(k));
  return { tab: hasSearch ? "search" : "home", settings: false };
}

/* Cambia SOLO el parametro `view`: `mode`, `q` y cualquier otro (por ejemplo
   los que deja una busqueda en curso) sobreviven al cambio de pantalla. Se
   acepta una pestana suelta por comodidad de los llamadores. Inicio no escribe
   nada, salvo con una busqueda en la URL: sin `view=home` readView la leeria
   como Buscar. */
export function writeView(search, view) {
  const next =
    typeof view === "string"
      ? { tab: view, settings: false }
      : { tab: view?.tab, settings: Boolean(view?.settings) };
  const params = new URLSearchParams(search || "");
  if (next.settings) {
    params.set("view", SETTINGS);
  } else if (!TAB_SET.has(next.tab)) {
    params.delete("view");
  } else if (next.tab === "home" && !SEARCH_PARAMS.some((k) => params.has(k))) {
    params.delete("view");
  } else {
    params.set("view", next.tab);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/* ---------------------------------------------------------------------------
   ESPEJO DE RUTA (fase 14)

   La URL es un espejo de solo lectura de la pagina visible: ?view=<pestana>
   mas ?page=<tipo>:<id>. Nunca crea entradas de historial: `writeRoute` solo
   compone la cadena que los replaceState/pushState de useNav ya hacian. Las
   hojas y los menus no son paginas y no cambian la ruta: pageOf las salta.
   `readRoute` sirve para replayar la ruta sobre la pila antes del primer
   pintado, al arrancar.
   ------------------------------------------------------------------------- */

export const PAGE_PARAM = "page";

/* Solo las paginas con un destino estable reciben direccion. Las hojas
   (menus, fichas, Ahora suena) viven en la misma pila pero no son paginas. */
export const ADDRESSABLE = Object.freeze(["album", "artist", "itunesartist", "list", "all", "library"]);

const ADDRESSABLE_SET = new Set(ADDRESSABLE);

export function pageToken(view) {
  if (!view || !ADDRESSABLE_SET.has(view.type)) return null;
  const key = view.id ?? view.what;
  return key === undefined || key === null ? view.type : `${view.type}:${key}`;
}

export function parsePage(token) {
  if (typeof token !== "string" || !token) return null;
  const cut = token.indexOf(":");
  const type = cut < 0 ? token : token.slice(0, cut);
  const key = cut < 0 ? null : token.slice(cut + 1);
  if (!ADDRESSABLE_SET.has(type)) return null;
  if (type === "all") return key ? { type, what: key } : null;
  if (type === "library") return { type };
  return key ? { type, id: key } : null;
}

export function readPage(search) {
  return parsePage(new URLSearchParams(search || "").get(PAGE_PARAM));
}

export function writePage(search, view) {
  const params = new URLSearchParams(search || "");
  const token = pageToken(view);
  if (token) params.set(PAGE_PARAM, token);
  else params.delete(PAGE_PARAM);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/* Compone la ruta completa a partir del estado logico (pestana, Ajustes y
   pagina). La pagina se pasa ya resuelta para que una hoja encima no cambie
   la direccion de la pagina de debajo. */
export function writeRoute(search, { tab, settings = false, page = null } = {}) {
  return writePage(writeView(search, { tab, settings }), page);
}

export function readRoute(search) {
  return { ...readView(search), page: readPage(search) };
}

/* La pestana que conviene adelantar mientras la app esta ociosa. */
export function nextGuess(tab) {
  if (tab === "home") return "search";
  if (tab === "search") return "library";
  if (tab === "library") return "search";
  return "library";
}

/* Direccion del cambio de pantalla para la transicion: 1 avanza en TABS, -1
   retrocede y 0 cuando alguno de los dos no es una pestana (por ejemplo
   Ajustes). */
export function modeDirection(from, to) {
  const a = TABS.indexOf(from);
  const b = TABS.indexOf(to);
  if (a < 0 || b < 0) return 0;
  return Math.sign(b - a);
}

/* --- Pila de paginas ----------------------------------------------------------
   `stack` son entradas { type, ... }: album, artist, list, all, library,
   settings, la marca "search" (la busqueda de Tu biblioteca, debajo de las
   paginas) y las hojas de Buscar. La pila pertenece a la pestana activa. */

/* "ficha", "resmenu" y "resmore" son las hojas de Buscar (la ficha de un
   resultado, el menu de resoluciones y el menu ⋯ de la fila); "menu", "picker",
   "lmenu" y "file" son el menu de una
   cancion, la hoja "Añadir a una lista", el menu de una lista y la ficha del
   archivo de una cancion (no es la "ficha" de un resultado de Buscar).
   "downmenu" es el menu ⋯ de la ficha del album, de sus canciones y del artista.
   "almenu" y "aldel" son el menu del album y su hoja de confirmacion de borrado.
   "art" es la hoja "Foto de..." de una cancion, un album o un artista.
   Todas viven en la pila para que atras, Escape y el atras de Android las
   cierren, pero la pantalla sigue a la vista debajo, sin pagina propia. */
const OVERLAYS = new Set(["menu", "picker", "lmenu", "file", "almenu", "aldel", "art", "npmenu"]);
/* "albumsheet" es la ficha de un album de Buscar; "descargas" es la hoja de la
   cola que abre la pildora del shell; "discsheet" es la lista de discografia
   del artista. Son hojas, no paginas ("album" ya es la pagina de un album de
   la biblioteca): no esconden la pantalla de debajo ni cuentan para el scroll
   recordado. */
const PAGE_HIDDEN = new Set([SETTINGS, "search", "ficha", "resmenu", "resmore", "downmenu", "albumsheet", "descargas", "discsheet", ...OVERLAYS]);

/* Un menu u hoja de la biblioteca (no una pagina). */
export const isOverlay = (type) => OVERLAYS.has(type);

/* Cambia la entrada de arriba por `view`; con la pila vacia la deja con solo
   `view`. */
export const replaceTop = (stack, view) => (stack.length ? [...stack.slice(0, -1), view] : [view]);

/* La pagina que pinta la pestana: la de arriba sin contar Ajustes (que tiene
   su propia pantalla) ni la marca de busqueda. null = la raiz. */
export function pageOf(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!PAGE_HIDDEN.has(stack[i].type)) return stack[i];
  }
  return null;
}

/* La pila que ve la pestana `id`: la de la activa y ninguna en las demas. */
export const stackFor = (id, active, stack) => (id === active ? stack : []);

/* ---------------------------------------------------------------------------
   PILAS POR PESTANA (fase 14)

   El estado del controlador lleva `stack` (la pila activa) y `stacks` (un
   Map<pestana, pila>). Las dos funciones puras de abajo son las unicas que
   mueven una pila de sitio: `withStack` la cambia, `switchTab` cambia la
   pestana activa sin tocar ninguna. Asi tocar la barra nunca borra lo que
   habia en la pestana que dejas, y el scroll de cada pagina sigue en su clave.
   ------------------------------------------------------------------------- */

export function stackAt(state, id) {
  if (id === state.tab) return state.stack ?? [];
  return state.stacks?.get(id) ?? [];
}

export function withStack(state, stack) {
  return { ...state, stack, stacks: new Map(state.stacks).set(state.tab, stack) };
}

export function switchTab(state, tab) {
  if (!TAB_SET.has(tab)) return state;
  const stacks = new Map(state.stacks);
  stacks.set(state.tab, state.stack);
  return { ...state, tab, stack: stacks.get(tab) ?? [], stacks };
}

/* Quita lo que sobra cuando el historial vuelve a una entrada de `depth`
   paginas. */
export const truncate = (stack, depth) =>
  depth >= stack.length ? stack : stack.slice(0, Math.max(0, depth));

/* Clave del scroll recordado: la raiz de cada pestana, cada pagina por
   separado y Ajustes. */
export function viewKey(tab, stack) {
  if (stack[stack.length - 1]?.type === SETTINGS) return SETTINGS;
  const page = pageOf(stack);
  return page ? `${tab}/${page.type}:${page.what ?? page.id ?? ""}` : tab;
}

/* Cuantas paginas tenia la pila cuando se creo la entrada del historial. */
export const HISTORY_MARK = "spitifoNav";
export const depthOf = (state) => Number(state?.[HISTORY_MARK]) || 0;

/* "Ahora suena" tiene entrada propia ({ spitifo: "np" }) pero NO cambia la
   pila: guarda la profundidad que tenia al abrirse (HISTORY_MARK). Asi un
   popstate que aterra en esa entrada (porque habia un menu encima) deja la
   pila como estaba entonces, sin cerrar la vista. */
export const isNpEntry = (state) => state?.spitifo === "np";
export const npState = (depth) => ({ spitifo: "np", [HISTORY_MARK]: depth });

/* La pila que le corresponde a la entrada alcanzada por un popstate. Sirve
   tanto para las paginas como para la entrada de "Ahora suena": en los dos
   casos el estado dice cuantas entradas tenia la pila al crearla. */
export const stackAfterPop = (stack, state) => truncate(stack, depthOf(state));

/* Con "Ahora suena" abierta, Escape cierra primero lo mas pequeno: si la pila
   crecio desde que se abrio, hay un menu (o una hoja) encima. */
export const aboveNp = (stack, npDepth) => stack.length > npDepth;

/* Cuantas entradas hay que deshacer para cerrar "Ahora suena" desde una hoja
   abierta encima: las hojas y la vista salen en un solo go(-n). Si el menu se
   cerrara antes, el aterrizaje seria la entrada muerta de la vista, sin panel
   que la cierre. */
export const npCloseDelta = (stackDepth, npDepth) => Math.max(0, stackDepth - npDepth) + 1;

/* Un swipe horizontal de verdad: suficiente recorrido, mas horizontal que
   vertical y rapido. Devuelve el indice destino o null si no aplica. */
export function swipeTarget({ dx = 0, dy = 0, dt = Number.POSITIVE_INFINITY } = {}, index, count) {
  if (!Number.isInteger(count) || count < 1) return null;
  if (!Number.isInteger(index) || index < 0 || index >= count) return null;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dt)) return null;
  if (dt > 600) return null;
  if (Math.abs(dx) < 60) return null;
  if (Math.abs(dx) < 1.5 * Math.abs(dy)) return null;
  const next = dx < 0 ? index + 1 : index - 1;
  return next >= 0 && next < count ? next : null;
}

/* Zonas que ya usan el gesto horizontal para lo suyo (barra de progreso,
   carruseles, menus o el video). El swipe no puede nacer ahi. */
export const NO_SWIPE = Object.freeze([
  "[data-no-swipe]",
  "input",
  "textarea",
  "select",
  "[role='slider']",
  "[contenteditable]",
  ".mini",
  ".vhost",
  ".resmenu",
]);

const NO_SWIPE_SELECTOR = NO_SWIPE.join(",");

export function canStartSwipe(target) {
  if (!target || typeof target.closest !== "function") return true;
  return !target.closest(NO_SWIPE_SELECTOR);
}

const PHONE_NAV_KEY = "spitifo.phoneNav";
const PHONE_NAV_VALUES = new Set(["tabs", "swipe"]);

/* localStorage puede no existir (SSR, tests) o lanzar (modo privado con
   almacenamiento bloqueado). Un fallo nunca puede impedir arrancar la app. */
export function readPhoneNav() {
  try {
    const value = globalThis.localStorage?.getItem(PHONE_NAV_KEY);
    return PHONE_NAV_VALUES.has(value) ? value : "tabs";
  } catch (e) {
    return "tabs";
  }
}

export function writePhoneNav(value) {
  if (!PHONE_NAV_VALUES.has(value)) return;
  try {
    globalThis.localStorage?.setItem(PHONE_NAV_KEY, value);
  } catch (e) {
    /* Se queda en memoria; la proxima sesion vuelve a preguntar. */
  }
}

/* La pista del gesto se muestra una sola vez, la primera vez que se elige
   «Páginas deslizables». Un fallo de almacenamiento no la hace repetirse. */
const SWIPE_HINT_KEY = "spitifo.swipeHint";

export function readSwipeHint() {
  try {
    return globalThis.localStorage?.getItem(SWIPE_HINT_KEY) !== "seen";
  } catch (e) {
    return true;
  }
}

export function writeSwipeHint() {
  try {
    globalThis.localStorage?.setItem(SWIPE_HINT_KEY, "seen");
  } catch (e) {
    /* Sin almacenamiento se olvida al recargar, igual que la preferencia. */
  }
}
