/* ---------------------------------------------------------------------------
   LOGICA PURA DE FOTOS PERSONALIZADAS

   Sin React ni DOM: target ids, precedencia de portada, candidatos y la
   geometria del recorte se prueban en Node. Las URLs de imagen NO son targets:
   el backend solo acepta texto en minusculas (ADR 0005).
   ------------------------------------------------------------------------- */

/* Un objetivo de cancion es el id guardado (yt:/ia:) o la clave del archivo. */
export const songTarget = (entry) => {
  const id = entry && (entry.sid || entry.key);
  return id ? `song:${id}` : null;
};

/* Misma lista de hosts que validate_art_url en art.py: fuente Detectada por
   host, no por el campo que traiga la busqueda (que puede mentir). */
export function sourceOfUrl(url) {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return null;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "i.ytimg.com") return "youtube";
  if (host === "mzstatic.com" || host.endsWith(".mzstatic.com")) return "itunes";
  if (host === "archive.org" || host.endsWith(".archive.org")) return "archive";
  return null;
}

export const SOURCE_LABEL = {
  itunes: "iTunes",
  youtube: "YouTube",
  archive: "Archive.org",
  upload: "Subida",
};

/* Los resultados matcheados traen el video de YouTube en extra.webpage_url;
   de ahi sale la miniatura sin otra peticion. */
export function youtubeThumb(watchUrl) {
  if (typeof watchUrl !== "string") return null;
  const m = watchUrl.match(/(?:[?&]v=|youtu\.be\/|embed\/)([\w-]{11})/);
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null;
}

/* Recorte central a cuadrado antes de dibujar las dos variantes. */
export function cropRect(width, height) {
  const w = Math.max(1, Math.floor(Number(width) || 0));
  const h = Math.max(1, Math.floor(Number(height) || 0));
  const s = Math.min(w, h);
  return { sx: Math.floor((w - s) / 2), sy: Math.floor((h - s) / 2), s };
}

export const BIG_PX = 600;
export const SMALL_PX = 120;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_SMALL_BYTES = 300 * 1024;
export const QUALITY_STEPS = [0.85, 0.72, 0.6, 0.5, 0.4];

/* Bytes ya decodificados de una base64: son los que limita el backend. */
export function base64Bytes(b64) {
  if (typeof b64 !== "string") return 0;
  const s = b64.replace(/\s/g, "");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

export const dataUrlBase64 = (url) =>
  typeof url === "string" ? url.replace(/^data:[^,]*,/, "") : "";

/* Primera calidad que cabe; si ninguna cabe, la mas baja. `measure(q)` es puro
   y devuelve los bytes que daria exportar a esa calidad. */
export function pickQuality(measure, limit, steps = QUALITY_STEPS) {
  for (let i = 0; i < steps.length; i += 1) {
    if (measure(steps[i]) <= limit) return steps[i];
  }
  return steps[steps.length - 1];
}

/* Un registro confirmado usa sus claves de Storage; uno optimista trae la URL
   directa para que la portada cambie antes de que responda el servidor. */
export function artSrc(record, keyUrl, small = false) {
  if (!record) return null;
  if (record.pending) return (small && record.smallUrl) || record.url || null;
  const key = small ? record.small_key : record.key;
  return key ? keyUrl(key) : null;
}

/* La foto propia gana a la portada del sidecar/artwork. Si no hay registro,
   devuelve la de siempre: nada cambia en las vistas sin foto propia. */
export function coverSrc(fallback, target, byTarget, keyUrl, small = false) {
  if (!target || !byTarget) return fallback || null;
  return artSrc(byTarget.get(target), keyUrl, small) || fallback || null;
}

/* Hasta seis candidatos distintos y con host admitido. `data` son las
   respuestas ya leidas: results de /api/search, albums de /api/albums/search o
   una lista de detalles de /api/artist/{id}. */
export function buildCandidates(kind, data, limit = 6) {
  const out = [];
  const seen = new Set();
  const add = (url, label) => {
    const source = sourceOfUrl(url);
    if (!source || seen.has(url)) return;
    seen.add(url);
    out.push({ url, source, label: label || "" });
  };
  if (kind === "song") {
    for (const r of data?.results || []) {
      add(r?.artwork_url, r?.title);
      add(youtubeThumb(r?.extra?.webpage_url), r?.extra?.video_title || r?.title);
    }
  } else if (kind === "album") {
    for (const a of data?.albums || []) add(a?.artwork_url, a?.title);
  } else if (kind === "artist") {
    for (const a of data || []) {
      add(a?.artwork_url, a?.name);
      /* Un artista con solo sencillos o directos tambien tiene portadas. */
      for (const k of ["albums", "singles", "live", "compilations"]) {
        for (const al of a?.[k] || []) add(al?.artwork_url, al?.title);
      }
    }
  }
  return out.slice(0, limit);
}
