export function fmtTime(s) {
  if (!s) return "--:--";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}
export function fmtSize(mb) {
  if (mb == null) return null;
  return `${Number(mb).toFixed(mb < 10 ? 1 : 0)} MB`;
}
/* Tamano aproximado de una resolucion. El backend manda BYTES (o null, que es
   "no se sabe", no "0"): null se pinta como raya, no como "0 MB". */
export function fmtApproxSize(bytes) {
  if (bytes == null) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `~${(mb / 1024).toFixed(1)} GB`;
  return `~${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
/* "m:ss" para el reproductor. fmtTime devuelve "--:--" para 0, que aqui seria
   mentira: el principio de una cancion es 0:00, no un dato que falta. */
export function clock(s) {
  const t = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
