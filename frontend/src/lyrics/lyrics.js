/* ---------------------------------------------------------------------------
   LETRA — lógica pura

   La vista no decide nada: el backend ya resolvió qué hay (synced, plain,
   instrumental o error) y aquí solo se elige el estado que se pinta. Los alias
   japoneses que iTunes pone en `extra.aliases` viajan al endpoint como
   `alt_title` / `alt_artist`, que es lo que permite encontrar letra para
   canciones J-pop cuyo título en latino no matcha en LRCLIB.
   ------------------------------------------------------------------------- */

export const STATES = {
  LOADING: "loading",
  SYNCED: "synced",
  PLAIN: "plain",
  INSTRUMENTAL: "instrumental",
  NONE: "none",
  UNAVAILABLE: "unavailable",
};

export function lyricsUrl(track) {
  if (!track) return null;
  const params = new URLSearchParams();
  params.set("title", track.title || "sin título");
  params.set("artist", track.artist || "artista desconocido");
  if (track.album) params.set("album", track.album);
  const seconds = Number(track.duration || track.result?.duration_s || 0);
  if (Number.isFinite(seconds) && seconds > 0) params.set("duration", String(Math.round(seconds)));
  const aliases = track.result?.extra?.aliases || track.extra?.aliases || {};
  if (typeof aliases.title === "string" && aliases.title) params.append("alt_title", aliases.title);
  if (typeof aliases.artist === "string" && aliases.artist) params.append("alt_artist", aliases.artist);
  return `/api/lyrics?${params.toString()}`;
}

/** Orden de decisión: un fallo de red manda; luego sincronizada, plana,
 *  instrumental y, solo si todo está vacío, «sin letra». */
export function lyricsState(data) {
  if (!data) return STATES.LOADING;
  if (data.error === "unavailable") return STATES.UNAVAILABLE;
  if (Array.isArray(data.synced) && data.synced.length) return STATES.SYNCED;
  if (typeof data.plain === "string" && data.plain.trim()) return STATES.PLAIN;
  if (data.instrumental) return STATES.INSTRUMENTAL;
  return STATES.NONE;
}

/** Índice de la última línea que ya empezó, o -1 antes de la primera. */
export function activeLine(lines, time) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (Number(lines[i].t) <= time) idx = i;
    else break;
  }
  return idx;
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Un vistazo breve para la tarjeta: la línea que suena, o un texto honesto. */
export function previewLine(data, time) {
  const state = lyricsState(data);
  if (state === STATES.SYNCED) return data.synced[Math.max(0, activeLine(data.synced, time))]?.line || "";
  if (state === STATES.PLAIN) return data.plain.trim().split("\n").filter(Boolean)[0] || "";
  return "";
}
