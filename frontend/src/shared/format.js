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
/* 0.34 -> "34 %"; menos de uno por ciento -> "<1 %". */
export function percent(share) {
  const n = Math.round(share * 100);
  return n < 1 ? "<1 %" : `${n} %`;
}

/* "Ana Maria" -> "AM"; "Wisin & Yandel" -> "WY"; un solo nombre, sus dos primeras letras. */
export function initials(name) {
  const words = String(name || "")
    .replace(/&/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const text = words.length > 1 ? [...words[0]][0] + [...words[1]][0] : [...(words[0] || "?")].slice(0, 2).join("");
  return text.toUpperCase();
}

/* "Porque escuchas X y Y" a partir de los artistas que mas aportaron. */
export function becauseText(because) {
  const list = Array.isArray(because) ? because.filter(Boolean).slice(0, 2) : [];
  return list.length ? `Porque escuchas ${list.join(" y ")}` : "";
}
