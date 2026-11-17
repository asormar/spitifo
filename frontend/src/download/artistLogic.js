/* ---------------------------------------------------------------------------
   LOGICA DE ARTISTAS (pura, sin React ni DOM)

   Regla del «Mejor resultado», cuentas de lo que ya tienes, valores por
   defecto de la lista de descarga y el orden en que se encolan los discos.
   Todo aqui se prueba en Node. Los textos de la interfaz van en espanol.
   ------------------------------------------------------------------------- */

import { fold } from "../listen/library.js";
import { ownedSlots, trackSlot, trackSpec } from "./albumText.js";

/* Los articulos que se pueden saltar al comparar un nombre. Solo al principio:
   «The Beatles» y «Beatles» son el mismo, «Los Ángeles» y «Ángeles» tambien. */
const ARTICLES = ["the", "los", "las"];

const stripArticle = (value) => {
  const f = fold(value);
  for (const a of ARTICLES) {
    const prefix = `${a} `;
    if (f.startsWith(prefix)) return f.slice(prefix.length).trim();
  }
  return f;
};

/* Igualdad con tildes, mayusculas y articulo inicial: «the Beatles» y
   «Beatles» dan true. Un nombre suelto «the» no pierde su articulo. */
export function isArtistNameMatch(query, name) {
  const q = fold(query);
  const n = fold(name);
  if (!q || !n) return false;
  if (q === n) return true;
  const qb = stripArticle(q);
  return Boolean(qb) && qb === stripArticle(n);
}

/* Solo el PRIMER resultado puede ser «Mejor resultado», y solo si el texto
   escrito nombra de verdad a ese artista. Un fallo de la peticion llega como
   lista vacia y no pinta nada. */
export function bestMatch(query, results = []) {
  if (!query || !Array.isArray(results) || !results.length) return null;
  const first = results.find((r) => r && r.id != null && r.name);
  return first && isArtistNameMatch(query, first.name) ? first : null;
}

/* Igualdad estricta (sin articulo) para el enlace de Escuchar: ahi no queremos
   confundir «The Doors» con un «Doors» que aparezca en la busqueda. */
export function exactArtist(name, results = []) {
  const n = fold(name);
  if (!n) return null;
  return (Array.isArray(results) ? results : []).find((r) => r && fold(r.name) === n) || null;
}

/* El id de iTunes guardado en las canciones del artista. Con el se abre su
   pagina en Buscar sin tener que buscar el nombre. */
export function artistIdFromEntries(entries, name) {
  const who = fold(name);
  if (!who) return null;
  const entry = (Array.isArray(entries) ? entries : []).find(
    (e) => e?.artist_id != null && fold(e.artist) === who
  );
  return entry ? entry.artist_id : null;
}

/* La portada redonda del artista sale del disco mas nuevo que encontremos
   entre los resultados de albumes del mismo artista. Sin coincidencia, el
   componente cae a la inicial. */
export function bestArtwork(artist, albums = []) {
  if (!artist?.id) return null;
  const mine = (Array.isArray(albums) ? albums : []).filter(
    (a) => a?.artwork_url && a.artist_id != null && String(a.artist_id) === String(artist.id)
  );
  if (!mine.length) return null;
  mine.sort((a, b) => Number(b.year) - Number(a.year));
  return mine[0].artwork_url;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* Cuantas canciones de la biblioteca son de este artista (por nombre, con
   tildes y mayusculas ignoradas), para la linea «tienes N canciones». */
export function ownedSongsByArtist(entries, name) {
  const who = fold(name);
  if (!who) return 0;
  return (Array.isArray(entries) ? entries : []).filter((e) => fold(e?.artist) === who).length;
}

/* Lo que ya se tiene de un disco, por el id de iTunes y los huecos pista/disco.
   `have` cuenta canciones, no archivos duplicados. */
export function albumOwnership(release, entries) {
  const owned = ownedSlots(entries, release?.id);
  const total = Number.isInteger(release?.track_count) ? release.track_count : 0;
  const have = owned.size;
  const full = total > 0 && have >= total;
  return {
    have,
    total,
    full,
    missing: Math.max(0, total - have),
    /* null = el disco no tiene nada en la biblioteca y toca mostrar el ano. */
    label: full ? "La tienes" : have > 0 ? `${have} de ${total}` : null,
  };
}

/* La linea del hero: solo las partes que no son cero, en el orden de la ficha. */
export function artistHero(sections = {}, name = "", entries = []) {
  const s = {
    albums: sections.albums || [],
    live: sections.live || [],
    compilations: sections.compilations || [],
    singles: sections.singles || [],
  };
  const parts = [];
  if (s.albums.length) parts.push(plural(s.albums.length, "álbum", "álbumes"));
  if (s.live.length) parts.push(`${s.live.length} en vivo`);
  if (s.compilations.length) parts.push(plural(s.compilations.length, "recopilatorio", "recopilatorios"));
  if (s.singles.length) parts.push(plural(s.singles.length, "sencillo", "sencillos"));
  const owned = ownedSongsByArtist(entries, name);
  if (owned) parts.push(`tienes ${plural(owned, "canción", "canciones")}`);
  return parts.join(" · ");
}

/* Los cuatro grupos de la lista de descarga, en el orden del diseno. Solo
   «Estudio» empieza marcado; un disco entero ya en la biblioteca no se puede
   marcar. Los grupos vacios no se pintan. */
export const CHECKLIST_SECTIONS = [
  { id: "albums", label: "Estudio", key: "albums", checked: true },
  { id: "live", label: "En vivo", key: "live", checked: false },
  { id: "compilations", label: "Recopilatorios", key: "compilations", checked: false },
  { id: "singles", label: "Sencillos", key: "singles", checked: false },
];

export function buildChecklist(sections = {}, entries = []) {
  return CHECKLIST_SECTIONS.map((s) => ({ ...s, releases: sections[s.key] || [] }))
    .filter((s) => s.releases.length > 0)
    .map((s) => ({
      id: s.id,
      label: s.label,
      rows: s.releases
        .filter((r) => r && r.id != null)
        .map((release) => {
          const own = albumOwnership(release, entries);
          let sub;
          if (own.full) sub = "ya la tienes entera";
          else if (own.have > 0) sub = `te faltan ${own.missing} de ${own.total}`;
          else sub = `${release.year || "—"} · ${plural(own.total, "canción", "canciones")}`;
          return {
            release,
            section: s.id,
            have: own.have,
            total: own.total,
            missing: own.missing,
            full: own.full,
            disabled: own.full,
            checked: s.checked && !own.full,
            sub,
          };
        }),
    }));
}

/* El estado inicial de las casillas: solo las que la lista dejo marcadas. */
export function initialSelections(groups = []) {
  const sel = {};
  for (const g of groups) for (const r of g.rows) sel[r.release.id] = r.checked;
  return sel;
}

/* Total en vivo: N canciones que faltan de los discos elegidos, y unos M MB
   (4.1 MB por cancion, redondeado). Un disco ya tuyo nunca cuenta. */
export function checklistTotals(groups = [], selections = {}) {
  let songs = 0;
  for (const g of groups) {
    for (const row of g.rows) {
      if (row.disabled || !selections[row.release.id]) continue;
      songs += row.missing;
    }
  }
  return { songs, mb: Math.round(songs * 4.1) };
}

export function downloadButton(totals) {
  if (!totals.songs) return { text: "Elige al menos un álbum", disabled: true };
  return {
    text: `Descargar ${plural(totals.songs, "canción", "canciones")}`,
    disabled: false,
  };
}

/* Los lotes que se van a encolar, en el orden de los discos elegidos. Igual
   que la ficha: se salta lo que ya esta en la biblioteca y lo que no tiene
   version completa. Cada lote es un POST con su propio grupo. */
export function enqueueBatches(releases = [], matches = {}, owned = {}, queryFor = () => "") {
  const batches = [];
  for (const release of releases) {
    const tracks = matches[release.id]?.tracks || [];
    const have = owned[release.id] || new Set();
    const items = [];
    for (const t of tracks) {
      const slot = trackSlot(t?.extra?.disc_number, t?.extra?.track_number);
      if (slot && have.has(slot)) continue;
      if (t?.extra?.has_full !== true) continue;
      items.push(trackSpec(t, queryFor(release)));
    }
    if (items.length) {
      batches.push({
        items,
        group: {
          id: `album:${release.id}`,
          title: release.title,
          artwork_url: release.artwork_url,
        },
      });
    }
  }
  return batches;
}

/* Un disco por vuelta: se empareja en YouTube y solo entonces se encola. Si
   un match falla se avisa y se sigue con el siguiente. Las dependencias se
   pasan por parametro para probar el orden sin red. */
export async function runDiscography({ selected = [], fetchMatch, enqueue, owned = {}, queryFor, onFail } = {}) {
  const enqueued = [];
  for (const release of selected) {
    /* Un disco a la vez: si falla el match O el POST, se avisa y se sigue con
       el siguiente. Cada disco es un solo lote con su propio grupo. */
    try {
      const match = await fetchMatch(release.id);
      const batches = enqueueBatches([release], { [release.id]: match }, owned, queryFor);
      for (const batch of batches) {
        await enqueue(batch);
        enqueued.push(batch.group.id);
      }
    } catch {
      onFail?.(release);
    }
  }
  return enqueued;
}
