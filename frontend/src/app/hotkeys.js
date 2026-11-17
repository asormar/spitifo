/* Puro: decisiones de los atajos globales del shell. */

/* Ctrl+K o Cmd+K, sin Alt y sin que otra tecla ya lo haya consumido. */
export const isSearchShortcut = (e) =>
  (e.key || "").toLowerCase() === "k" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.defaultPrevented;

/* Foco dentro de un campo de texto (o contenido editable). */
export const isTypingTarget = (tag, editable) =>
  /^(INPUT|TEXTAREA|SELECT)$/.test(tag || "") || !!editable;
