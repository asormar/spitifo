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

/* "ficha" y "resmenu" son las hojas de Buscar (la ficha de un resultado y el
   menu de resoluciones); "menu", "picker" y "lmenu" son el menu de una cancion,
   la hoja "Añadir a una lista" y el menu de una lista. Todas viven en la pila
   para que atras, Escape y el atras de Android las cierren, pero la pantalla
   sigue a la vista debajo, sin pagina propia. */
const OVERLAYS = new Set(["menu", "picker", "lmenu"]);
const PAGE_HIDDEN = new Set([SETTINGS, "search", "ficha", "resmenu", ...OVERLAYS]);

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
