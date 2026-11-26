import { isYouTubeUrl } from "./constants.js";

/* ---------------------------------------------------------------------------
   SUGERENCIAS (pura, sin React ni DOM)

   Escribir solo pide fuentes baratas: la biblioteca en memoria y una busqueda
   ligera a iTunes. YouTube no se toca hasta que se elige un resultado. Todo lo
   que decide que se muestra vive aca para probarlo en Node.
   ------------------------------------------------------------------------- */

export const SUGGEST_MS = 160;
export const SUGGEST_MIN = 2;
export const SUGGEST_MAX = 6;

/* Un enlace de YouTube no sugiere: se busca directo al enviarlo. */
export function suggestTerm(q) {
  const t = String(q ?? "").trim();
  return t.length >= SUGGEST_MIN && !isYouTubeUrl(t) ? t : null;
}

export const fold = (s) =>
  String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

/* Distancia de edicion de Levenshtein, con dos filas nada mas. */
export function editDistance(a, b) {
  const x = fold(a);
  const y = fold(b);
  if (x === y) return 0;
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[y.length];
}

/* Correcciones acotadas para el «¿Quizas querias…?». Se descartan las que
   casan consigo mismas y las que pasan el tope de distancia. */
export function didYouMean(query, names = [], limit = 3, maxDistance = 3) {
  const q = fold(query);
  if (!q) return [];
  const seen = new Set();
  const scored = [];
  for (const value of names) {
    const name = String(value ?? "").trim();
    const key = fold(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const d = editDistance(q, key);
    if (d > 0 && d <= maxDistance) scored.push({ name, d });
  }
  return scored
    .sort((a, b) => a.d - b.d || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((x) => x.name);
}

export const suggestionKey = (s) => `${s?.kind || "song"}:${s?.id ?? s?.title ?? ""}`;

/* Normaliza una sugerencia de cualquier fuente. La biblioteca manda `source:
   "library"` y el resto viene del endpoint ligero de iTunes. */
export function normalizeSuggestion(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title ?? "").trim();
  if (!title) return null;
  const kind = raw.kind === "artist" || raw.kind === "album" ? raw.kind : "song";
  const out = {
    kind,
    id: raw.id ?? null,
    title,
    sub: String(raw.sub ?? "").trim(),
    source: raw.source || (kind === "song" ? "library" : "itunes"),
  };
  if (raw.artwork_url) out.artwork_url = raw.artwork_url;
  return out;
}

/* La biblioteca va primero: es gratis y es lo que el usuario ya tiene. Luego
   iTunes, sin repetir ninguna clave. */
export function mergeSuggestions(library = [], remote = [], limit = SUGGEST_MAX) {
  const seen = new Set();
  const out = [];
  for (const raw of [...library, ...remote]) {
    const s = normalizeSuggestion(raw);
    if (!s) continue;
    const k = suggestionKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}
