/* ---------------------------------------------------------------------------
   IDENTIDAD DE UNA CANCION GUARDADA

   Un id estable, NUNCA una URL de streaming (vencen). YouTube sale del
   videoId y Internet Archive del item mas el archivo elegido: un item puede
   traer un disco entero. Las reglas son las de backend/app/saved.py (ADR
   0004). Modulo puro: se importa en Node sin DOM.
   ------------------------------------------------------------------------- */

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const IA_IDENT = /^[A-Za-z0-9._-]{1,100}$/;
const IA_BAD = /[:?#\\\x00-\x1f]/;

/* `URL` existe en el navegador y en Node; una URL relativa o rota no da id. */
const videoParam = (url) => {
  try {
    return new URL(url).searchParams.get("v");
  } catch {
    return null;
  }
};

export function songIdOf(t) {
  if (!t || typeof t !== "object") return null;
  const extra = t.extra || {};

  /* Un resultado de iTunes con video matcheado trae el webpage_url de YouTube;
     una busqueda de YouTube trae ademas el videoId en source_id. */
  const v = videoParam(extra.webpage_url || t.webpage_url);
  if (YT_ID.test(v || "")) return `yt:${v}`;
  if ((t.source === "ytdlp" || t.source === "youtube") &&
      YT_ID.test(t.source_id || "")) {
    return `yt:${t.source_id}`;
  }

  /* En Internet Archive `source_id` es SOLO el identifier (sources.py): el
     archivo esta en extra.filename despues de resolver/verificar. Sin archivo
     no hay identidad: un item puede tener muchas pistas. */
  if (t.source === "archive" && IA_IDENT.test(t.source_id || "")) {
    const file = extra.filename || t.filename;
    if (typeof file === "string" && file) {
      const raw = `${t.source_id}/${file.replace(/^\/+/, "")}`;
      const parts = raw.split("/");
      const ok = parts.slice(1).every((p) => p && p !== "." && p !== "..");
      if (ok && !IA_BAD.test(raw)) return `ia:${raw}`;
    }
  }
  return null;
}

/* Los ids de iTunes viven en `extra` con dos ortografias: la de la API
   (collectionId, trackNumber...) y la del agregado de la biblioteca. */
const ITUNES_FIELDS = {
  track_id: ["track_id", "trackId"],
  collection_id: ["collection_id", "collectionId"],
  artist_id: ["artist_id", "artistId"],
  track_no: ["track_no", "track_number", "trackNumber"],
  disc_no: ["disc_no", "disc_number", "discNumber"],
  track_count: ["track_count", "trackCount"],
};

/* El registro que espera validate_saved_payload (PUT /api/saved). Acepta tanto
   un resultado de Buscar como una pista del motor (que ya trae `sid`). `null`
   cuando no hay identidad, por ejemplo un preview de iTunes. */
export function songFromResult(t) {
  const fromTrack = typeof t?.sid === "string" && /^(yt:|ia:)[^:]+/.test(t.sid);
  const id = songIdOf(t) || (fromTrack ? t.sid : null);
  if (!id) return null;
  const extra = t?.extra || {};
  const youtube = id.startsWith("yt:");
  const itunes = {};
  for (const [name, keys] of Object.entries(ITUNES_FIELDS)) {
    const value = keys.map((k) => extra[k]).find(Number.isInteger);
    if (value !== undefined) itunes[name] = value;
  }
  if (t?.source === "itunes" && /^\d+$/.test(String(t.source_id || ""))) {
    itunes.track_id = Number(t.source_id);
  }
  return {
    id,
    title: t.title || "sin título",
    artist: t.artist || "Artista desconocido",
    album: t.album || null,
    duration: t.duration_s ?? t.duration ?? null,
    artwork_url: t.artwork_url || t.artwork || null,
    source: youtube ? "youtube" : "archive",
    source_id: id.slice(3),
    itunes,
    file_key: null,
  };
}
