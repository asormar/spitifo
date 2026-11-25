import { localSetting } from "../shared/localSetting.js";
import { collator, fold } from "./library.js";
import { filePill } from "./fileCheck.js";

/* ---------------------------------------------------------------------------
   BIBLIOTECA A ESCALA (logica pura)

   Lo que决定 la vista lista/cuadrícula, el orden de las columnas de PC, los
   filtros y la busqueda dentro de una lista, y las carpetas. Nada aqui toca
   React ni el DOM: se prueba en Node y las vistas solo pintan el resultado.
   ------------------------------------------------------------------------- */

export const VIEWS = ["list", "grid"];

/* La vista se recuerda POR PESTAÑA: cambiar de pestaña no cambia la vista de
   las demas. localStorage puede estar bloqueado; en ese caso vale por la visita. */
const read = () => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem("spitifo.library.view");
  } catch {
    return null;
  }
};
const write = (value) => {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem("spitifo.library.view", value);
  } catch {
    /* Sin almacen: el valor sigue vigente mientras dure la visita. */
  }
};

export function parseViewMap(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [tab, view] of Object.entries(parsed)) {
      if (VIEWS.includes(view)) out[tab] = view;
    }
    return out;
  } catch {
    return {};
  }
}

export const libraryView = localSetting("spitifo.library.view", {}, {
  read,
  write: (map) => write(JSON.stringify(map)),
  normalize: parseViewMap,
});

export const viewOf = (map, tab, fallback = "grid") => map?.[tab] || fallback;
export const withView = (map, tab, view) =>
  VIEWS.includes(view) ? { ...(map || {}), [tab]: view } : (map || {});

/* --- Orden de columnas ------------------------------------------------------ */

/* Tres estados: ascendente, descendente y orden original. Un click en otra
   columna empieza por ascendente. */
export function cycleSort(current, key) {
  if (!current || current.key !== key) return { key, dir: 1 };
  if (current.dir === 1) return { key, dir: -1 };
  return { key: null, dir: 0 };
}

const fieldOf = (entry, key) => {
  switch (key) {
    case "artist": return entry.artist || "";
    case "album": return entry.album || "";
    case "duration": return Number(entry.duration) || 0;
    case "added": return Number(entry.added) || 0;
    case "title":
    default: return entry.title || "";
  }
};

/* Copia ordenada con comparator estable: los empates conservan el orden de
   la lista (el del usuario en una playlist). `dir` 0 no ordena nada. */
export function sortRows(rows, sort) {
  if (!sort?.key || !sort.dir) return rows.slice();
  return rows
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => {
      const x = fieldOf(a.entry, sort.key);
      const y = fieldOf(b.entry, sort.key);
      const cmp = typeof x === "number"
        ? x - y
        : collator.compare(String(x), String(y));
      return (cmp || a.i - b.i) * sort.dir;
    })
    .map(({ entry }) => entry);
}

export const ariaSortOf = (sort, key) =>
  !sort || sort.key !== key || !sort.dir ? "none" : sort.dir === 1 ? "ascending" : "descending";

/* --- Buscar y filtrar dentro de una lista ---------------------------------- */

export const PLAYLIST_FILTERS = ["downloaded", "unverified", "duplicates"];

/* Claves repetidas por titulo y artista (insensible a mayusculas y acentos).
   El titulo basta cuando no hay artista: no inventamos coincidencias. */
export function duplicateKeys(rows) {
  const seen = new Map();
  for (const entry of rows) {
    const id = `${fold(entry.title)}|${fold(entry.artist || "")}`;
    const list = seen.get(id) || [];
    list.push(entry);
    seen.set(id, list);
  }
  const out = new Set();
  for (const list of seen.values()) {
    if (list.length > 1) list.forEach((e) => out.add(e.key));
  }
  return out;
}

export const toggleFilterIn = (active, id) =>
  active.includes(id) ? active.filter((f) => f !== id) : [...active, id];

/* `query` busca titulo, artista y album; los filtros se combinan con AND. */
export function filterRows(rows, { query = "", filters = [] } = {}) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const dups = filters.includes("duplicates") ? duplicateKeys(rows) : null;
  return rows.filter((entry) => {
    if (terms.length) {
      const text = fold(`${entry.title || ""} ${entry.artist || ""} ${entry.album || ""}`);
      if (!terms.every((t) => text.includes(t))) return false;
    }
    if (filters.includes("downloaded") && !entry.downloaded) return false;
    if (filters.includes("unverified") && filePill(entry) !== "unv") return false;
    if (dups && !dups.has(entry.key)) return false;
    return true;
  });
}

/* --- Carpetas --------------------------------------------------------------- */

export const foldersOf = (lists) => lists.filter((p) => p.is_folder);
export const looseOf = (lists) => lists.filter((p) => !p.is_folder);
export const inFolder = (lists, folderId) =>
  folderId ? lists.find((p) => p.id === folderId) : null;
export const membersOf = (lists, folder) =>
  folder?.is_folder ? folder.keys.map((id) => lists.find((p) => p.id === id)).filter(Boolean) : [];

/* Una carpeta la abre un cliente viejo como una lista cualquiera: sus keys
   son ids de playlist y no corresponden a ninguna cancion. detail.js lo
   resuelve a filas vacias, sin error (ver detail.test.js). */
export const songsOfFolder = (folder, byKey, savedById) =>
  (folder?.keys || [])
    .map((k) => byKey.get(k) || savedById?.get?.(k))
    .filter(Boolean);

/* --- Portadas reales -------------------------------------------------------- */

/* Las cuatro primeras portadas de una lista: la miniatura del archivo o la
   imagen de la fuente de una guardada. Sin portada, Mosaic dibuja tonos. */
export function mosaicSources(keys, byKey, savedById, keyUrl) {
  const out = [];
  for (const key of keys || []) {
    const entry = byKey.get(key) || savedById?.get?.(key);
    if (!entry) continue;
    const src = entry.thumbKey
      ? keyUrl(entry.thumbKey)
      : entry.artworkUrl || entry.artwork_url || null;
    if (src) out.push(src);
    if (out.length === 4) break;
  }
  return out;
}
