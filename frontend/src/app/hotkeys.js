/* Puro: decisiones de los atajos globales del shell. */

/* Ctrl+K o Cmd+K, sin Alt y sin que otra tecla ya lo haya consumido. */
export const isSearchShortcut = (e) =>
  (e.key || "").toLowerCase() === "k" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.defaultPrevented;

/* Foco dentro de un campo de texto (o contenido editable). */
export const isTypingTarget = (tag, editable) =>
  /^(INPUT|TEXTAREA|SELECT)$/.test(tag || "") || !!editable;

/* Atajos de memoria muscular DENTRO de la ventana. Devuelve una accion o null;
   quien escucha decide si el foco esta en un campo y si hay una vista encima.
   Los multimedia de fuera (teclas Media, auriculares) ya los traduce
   mediaSession.js y no pasan por aqui. */
export const desktopShortcut = (e) => {
  if (e.defaultPrevented || e.altKey) return null;
  const k = e.key || "";
  const mod = e.ctrlKey || e.metaKey;
  if (k === "?" || (e.shiftKey && k === "/")) return "help";
  if (mod && e.shiftKey && k.toLowerCase() === "p") return "panel";
  if (mod && !e.shiftKey && (k === "\\" || e.code === "Backslash")) return "rail";
  if (mod && !e.shiftKey && k === "ArrowLeft") return "prev";
  if (mod && !e.shiftKey && k === "ArrowRight") return "next";
  if (mod || e.shiftKey) return null;
  if (k === " " || k === "Spacebar" || e.code === "Space") return "playPause";
  if (k === "ArrowLeft") return "seekBack";
  if (k === "ArrowRight") return "seekFwd";
  if (k.toLowerCase() === "m") return "mute";
  return null;
};
