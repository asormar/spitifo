/* ---------------------------------------------------------------------------
   MODELO DE NAVEGACION

   Puro, sin React ni DOM: la URL es la unica fuente de verdad del modo y la
   pantalla de Ajustes. Asi el boton atras de Android (que primero pasa por el
   historial del WebView) y un enlace compartido hacen exactamente lo mismo.
   ------------------------------------------------------------------------- */

export const MODES = ["download", "listen", "discover"];

const MODE_SET = new Set(MODES);
const SETTINGS = "settings";

/* `settings` gana sobre cualquier modo: es una pantalla, no un cuarto modo.
   Un `view` desconocido no rompe: se cae al modo por defecto. */
export function readView(search) {
  const params = new URLSearchParams(search || "");
  const view = params.get("view");
  if (view === SETTINGS) return { mode: "download", settings: true };
  return { mode: MODE_SET.has(view) ? view : "download", settings: false };
}

/* Cambia SOLO el parametro `view`: `mode`, `q` y cualquier otro (por ejemplo
   los que deja una busqueda en curso) sobreviven al cambio de pantalla. Se
   acepta un modo suelto por comodidad de los llamadores. */
export function writeView(search, view) {
  const next =
    typeof view === "string"
      ? { mode: view, settings: false }
      : { mode: view?.mode, settings: Boolean(view?.settings) };
  const params = new URLSearchParams(search || "");
  if (next.settings) {
    params.set("view", SETTINGS);
  } else if (next.mode === "download" || !MODE_SET.has(next.mode)) {
    params.delete("view");
  } else {
    params.set("view", next.mode);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/* El modo que conviene adelantar mientras la app esta ociosa. */
export function nextGuess(mode) {
  if (mode === "download") return "listen";
  if (mode === "listen") return "discover";
  return "listen";
}

/* Direccion del cambio de pantalla para la transicion: 1 avanza en MODES, -1
   retrocede y 0 cuando alguno de los dos no es un modo (por ejemplo Ajustes). */
export function modeDirection(from, to) {
  const a = MODES.indexOf(from);
  const b = MODES.indexOf(to);
  if (a < 0 || b < 0) return 0;
  return Math.sign(b - a);
}

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
   carruseles, menus, el video o el cajon). El swipe no puede nacer ahi. */
export const NO_SWIPE = Object.freeze([
  "[data-no-swipe]",
  "input",
  "textarea",
  "select",
  "[role='slider']",
  "[contenteditable]",
  ".drawer",
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
