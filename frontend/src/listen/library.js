/* ---------------------------------------------------------------------------
   BIBLIOTECA DE ESCUCHAR

   El backend entrega cada archivo como <Artista>/<Artista> - <Titulo>.<ext>,
   pero las etiquetas del propio archivo son opcionales. Aqui se normaliza esa
   mezcla una sola vez, al llegar de /api/library, para que las vistas no
   repitan los mismos fallbacks ni recorran miles de filas buscando texto.

   Todo son funciones puras y sin acceso a window/document: este modulo tiene
   que poder importarse en Node para las pruebas.
   ------------------------------------------------------------------------- */

const UNKNOWN_ARTIST = "Artista desconocido";

/* Sensibilidad base ignora mayusculas y tildes al ordenar; numeric mantiene
   "Pista 2" antes que "Pista 10". */
export const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });

export function fold(value) {
  return (value == null ? "" : String(value))
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/* El nombre que guarda el backend ya viene sin carpeta, pero puede tener varios
   puntos ("Tema (live).mp3"): solo se quita la ultima extension. */
const stem = (filename) => {
  const name = filename == null ? "" : String(filename);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

export function normalizeEntry(file) {
  const f = file || {};
  const artist = f.artist || f.folder || UNKNOWN_ARTIST;
  let title = f.title || stem(f.filename);
  /* El prefijo del nombre de archivo se repite en el titulo; si el artista ya
     esta en el campo `artist`, dejarlo duplicaria "Artista - Artista - Tema". */
  const prefix = `${artist} - `;
  if (title.startsWith(prefix)) title = title.slice(prefix.length);
  const album = f.album || "";
  return {
    key: f.key,
    kind: f.kind,
    title,
    artist,
    album,
    duration: f.duration_s ?? null,
    filename: f.filename,
    folder: f.folder,
    sizeMb: f.size_mb ?? null,
    thumbKey: f.thumb_key ?? null,
    /* Cuando llego a la biblioteca (mtime en segundos); 0 = no se sabe. */
    added: Number(f.modified) || 0,
    hasAudio: Boolean(f.has_audio),
    /* Precalcular el texto evita normalizar cada fila en cada tecla. */
    search: fold(`${title} ${artist} ${album}`),
  };
}

export function normalizeLibrary(files) {
  return (files || []).map(normalizeEntry);
}

export function filterEntries(entries, query) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return entries;
  return entries.filter((entry) => terms.every((term) => entry.search.includes(term)));
}

export function groupArtists(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const id = `artist:${fold(entry.artist)}`;
    let group = groups.get(id);
    if (!group) {
      group = { id, name: entry.artist, entries: [], albums: new Set() };
      groups.set(id, group);
    }
    group.entries.push(entry);
    if (entry.album) group.albums.add(fold(entry.album));
  }
  return [...groups.values()]
    .map(({ albums, ...group }) => ({
      id: group.id,
      name: group.name,
      entries: group.entries,
      albumCount: albums.size,
    }))
    .sort((a, b) => collator.compare(a.name, b.name));
}

export function groupAlbums(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.album) continue;
    /* Mismo nombre con dos artistas son dos discos distintos. */
    const key = `${fold(entry.artist)}|${fold(entry.album)}`;
    const id = `album:${key}`;
    let group = groups.get(id);
    if (!group) {
      group = { id, name: entry.album, artist: entry.artist, entries: [] };
      groups.set(id, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()].sort(
    (a, b) =>
      collator.compare(a.name, b.name) || collator.compare(a.artist, b.artist)
  );
}

/* `keyUrl` se recibe para no fijar aqui el prefijo de la API: el motor solo
   necesita una URL de audio ya resuelta. La portada es el .jpg que el backend
   deja junto a la pista (`thumb_key`) y se pide por el mismo endpoint; sin
   miniatura no hay portada y la vista dibuja su propia ficha. */
export function toTrack(entry, keyUrl) {
  const meta = entry.album ? `${entry.artist} · ${entry.album}` : entry.artist;
  return {
    key: entry.key,
    src: keyUrl(entry.key),
    title: entry.title,
    meta,
    duration: entry.duration,
    artwork: entry.thumbKey ? keyUrl(entry.thumbKey) : null,
    kind: "library",
    label: `${entry.title}, ${entry.artist}`,
  };
}

export function toQueue(entries, keyUrl) {
  return entries
    .filter((entry) => entry.kind !== "video")
    .map((entry) => toTrack(entry, keyUrl));
}

/* Ventana de filas de una lista virtual. `scrollTop` llega relativo al inicio
   de la lista y puede ser negativo cuando la lista aun esta bajo el pliegue. */
export function visibleRange({
  scrollTop,
  viewport,
  rowHeight,
  count,
  overscan = 8,
}) {
  const total = Math.max(0, Math.floor(count) || 0);
  if (!total) return { start: 0, end: 0 };
  const first = Math.floor(scrollTop / rowHeight);
  const last = Math.ceil((scrollTop + viewport) / rowHeight);
  const start = Math.max(0, Math.min(total, first - overscan));
  const end = Math.max(start, Math.min(total, last + overscan));
  return { start, end };
}
