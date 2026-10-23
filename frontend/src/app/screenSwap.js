import { flushSync } from "react-dom";

/* ---------------------------------------------------------------------------
   CAMBIO DE PANTALLA

   Un solo camino para modos y Ajustes. Con View Transitions, el navegador
   congela la pantalla vieja y la nueva entra desde el lado del avance (dir:
   -1 atras, 1 adelante, 0 solo fundido). Sin la API, un fundido con WAAPI.

   `update` lleva SIEMPRE los cambios de estado juntos: flushSync los pinta
   antes de la foto "nueva" y el layout effect del scroll corre dentro, asi
   que la captura ya tiene el scroll correcto.
   ------------------------------------------------------------------------- */

/* La transicion en curso, para interrumpirla si el usuario cambia de pantalla
   otra vez antes de que termine. */
let running = null;

export function swapScreens(update, dir = 0) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    update();
    return;
  }

  const root = document.documentElement;

  if (document.startViewTransition) {
    try {
      running?.skipTransition();
      root.dataset.vt = "mode";
      root.style.setProperty("--vt-dir", dir);
      const y = window.scrollY;
      const vt = document.startViewTransition(() => {
        flushSync(update);
        /* El layout effect ya restauro el scroll de la pantalla nueva: la
           diferencia recoloca la foto vieja (ver shell.css). */
        root.style.setProperty("--vt-shift", `${window.scrollY - y}px`);
      });
      running = vt;
      /* Mismo motivo que en el tema: si el documento queda oculto o `update`
         tira, las promesas rechazan aunque el estado se aplique. */
      vt.ready.catch(() => {});
      vt.updateCallbackDone.catch(() => {});
      vt.finished.catch(() => {}).then(() => {
        /* Una transicion posterior ya es la duena de data-vt. */
        if (running !== vt) return;
        running = null;
        if (root.dataset.vt === "mode") delete root.dataset.vt;
      });
    } catch (e) {
      if (root.dataset.vt === "mode") delete root.dataset.vt;
      update();
    }
    return;
  }

  /* Sin View Transitions: el estado se pinta igual y la pantalla visible
     aparece con un fundido corto. */
  flushSync(update);
  document
    .querySelector(".screen:not([hidden])")
    ?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 240,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    });
}
