/* ---------------------------------------------------------------------------
   BUSQUEDAS RECIENTES (pura, sin React ni DOM)

   Se guardan en localStorage, sin cuenta y sin servidor: el mismo compromiso de
   no-tracking del resto del producto. Cualquier fallo del almacen (modo
   privado, WebView con el almacen bloqueado) se traga: la visita sigue con la
   lista en memoria.
   ------------------------------------------------------------------------- */

export const RECENT_KEY = "spitifo.search.recent";
export const RECENT_MAX = 8;

const fold = (s) =>
  String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const MODES = new Set(["matched", "sources", "ytdlp"]);

/* Solo texto no vacio, modo conocido y sin duplicados (ignorando tildes y
   mayusculas). La mas reciente va primero. */
export function parseRecent(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const text = String(item?.text ?? "").trim();
    const key = fold(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ text, mode: MODES.has(item?.mode) ? item.mode : "matched" });
    if (out.length >= RECENT_MAX) break;
  }
  return out;
}

const store = (storage) =>
  storage ?? (typeof localStorage === "undefined" ? null : localStorage);

export function readRecent(storage) {
  const s = store(storage);
  if (!s) return [];
  try {
    return parseRecent(JSON.parse(s.getItem(RECENT_KEY) || "[]"));
  } catch {
    return [];
  }
}

export function rememberRecent(storage, text, mode = "matched") {
  const t = String(text ?? "").trim();
  if (!t) return readRecent(storage);
  const next = [
    { text: t, mode: MODES.has(mode) ? mode : "matched" },
    ...readRecent(storage).filter((r) => fold(r.text) !== fold(t)),
  ].slice(0, RECENT_MAX);
  try {
    store(storage)?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* Sin almacen: el valor vive mientras dure esta visita. */
  }
  return next;
}

export function clearRecent(storage) {
  try {
    store(storage)?.removeItem(RECENT_KEY);
  } catch {
    /* Igual que al guardar: no puede tumbar la pantalla. */
  }
  return [];
}
