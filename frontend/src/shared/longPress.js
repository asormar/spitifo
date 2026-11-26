/* ---------------------------------------------------------------------------
   PORTADA SIN EL MENU DEL WEBVIEW (U-mobile-native-feel-7)

   Mantener presionada una portada abre el MISMO menu que el boton «⋯» de la
   fila: no hay segunda interfaz que mantener. Un movimiento del dedo cancela
   el temporizador, asi un arrastre normal no dispara el menu por error.
   ------------------------------------------------------------------------- */

export const LONG_PRESS_MS = 450;
const SLOP = 8;

/* El boton de mas opciones mas cercano: fila de biblioteca, cola o reproductor. */
export function menuAnchorFor(el) {
  const host = el?.closest?.(".srow, .qrow, .np__cover, .fy-card, .card");
  /* Solo el boton «⋯» lleva aria-haspopup: la X de «Quitar de la lista» tambien
     es .srow__more y no debe dispararse con un gesto largo. */
  return host?.querySelector?.('[aria-haspopup="menu"], .np__more') ?? null;
}

export function bindCoverMenu(root) {
  if (!root) return () => {};
  let timer = null;
  let anchor = null;
  let x = 0;
  let y = 0;

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    anchor = null;
  };

  const down = (e) => {
    if (e.target.tagName !== "IMG" || e.button > 0) return;
    anchor = menuAnchorFor(e.target);
    if (!anchor) return;
    x = e.clientX;
    y = e.clientY;
    timer = setTimeout(() => {
      const btn = anchor;
      anchor = null;
      if (btn?.isConnected) btn.click();
    }, LONG_PRESS_MS);
  };

  const move = (e) => {
    if (timer && Math.hypot(e.clientX - x, e.clientY - y) > SLOP) cancel();
  };

  /* Chromium muestra «Guardar imagen» en el contextmenu de una imagen. */
  const context = (e) => {
    if (e.target.tagName === "IMG") e.preventDefault();
  };

  root.addEventListener("pointerdown", down);
  root.addEventListener("pointermove", move);
  root.addEventListener("pointerup", cancel);
  root.addEventListener("pointercancel", cancel);
  root.addEventListener("contextmenu", context);
  return () => {
    cancel();
    root.removeEventListener("pointerdown", down);
    root.removeEventListener("pointermove", move);
    root.removeEventListener("pointerup", cancel);
    root.removeEventListener("pointercancel", cancel);
    root.removeEventListener("contextmenu", context);
  };
}
