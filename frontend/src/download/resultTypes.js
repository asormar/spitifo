import { SOURCE_LABEL } from "./constants.js";

/* ---------------------------------------------------------------------------
   FILTROS DE BUSCAR POR TIPO Y FUENTE (puro, sin React ni DOM)

   Hoy el unico filtro es Todos/Completas y los chips eligen la fuente antes de
   buscar. Aqui se juntan canciones, albumes y artistas ya en pantalla para
   filtrar por lo que son, con recuentos, y para explicar las siglas de la fila.
   ------------------------------------------------------------------------- */

export const TYPE_CHIPS = [
  { id: "all", label: "Todas" },
  { id: "song", label: "Canciones" },
  { id: "album", label: "Álbumes" },
  { id: "artist", label: "Artistas" },
  { id: "live", label: "En vivo" },
];

export const SOURCE_CHIPS = [
  { id: "itunes", label: "iTunes", code: "iT" },
  { id: "archive", label: "Internet Archive", code: "IA" },
  { id: "jamendo", label: "Jamendo", code: "J" },
  { id: "wikimedia", label: "Wikimedia", code: "W" },
  { id: "ytdlp", label: "YouTube", code: "YT" },
];

export const sourceLegend = () => SOURCE_CHIPS.map(({ code, label }) => ({ code, label }));

const asArray = (x) => (Array.isArray(x) ? x.filter(Boolean) : []);

/* Una sola entrada por elemento: las canciones traen `source`, los estantes no
   (son de iTunes) y se marcan como tales. */
export function entriesFor({ results = [], albums = [], artists = [] } = {}) {
  return [
    ...asArray(results).map((t) => ({
      kind: t.extra?.is_live ? "live" : "song",
      source: t.source || "itunes",
      item: t,
    })),
    ...asArray(albums).map((a) => ({
      kind: a.extra?.is_live ? "live" : "album",
      source: a.source || "itunes",
      item: a,
    })),
    ...asArray(artists).map((a) => ({ kind: "artist", source: a.source || "itunes", item: a })),
  ];
}

export const countKind = (entries, kind) =>
  kind === "all" ? entries.length : entries.filter((e) => e.kind === kind).length;

export const countSource = (entries, source) =>
  source === "all" ? entries.length : entries.filter((e) => e.source === source).length;

/* Los dos filtros se combinan: «En vivo» de «YouTube» son las entradas que
   cumplen ambos. `all` no filtra. */
export function filterEntries(entries, { type = "all", source = "all" } = {}) {
  return entries.filter(
    (e) => (type === "all" || e.kind === type) && (source === "all" || e.source === source)
  );
}

/* El nombre entero para el lector de pantalla: la sigla de la fila no se oye
   bien leida en voz alta. */
export const sourceName = (code) =>
  SOURCE_CHIPS.find((s) => s.code === code)?.label || SOURCE_LABEL[code] || code;
