import { flushSync } from "react-dom";
import { motion, reducedMotion } from "../shared/motion.js";

/* ---------------------------------------------------------------------------
   CAMBIO DE PANTALLA

   Un solo camino para pestanas y Ajustes. Con View Transitions, el navegador
   congela la pantalla vieja y la nueva entra desde el lado del avance (dir:
   -1 atras, 1 adelante, 0 solo fundido). Sin la API, un fundido con WAAPI.

   `update` lleva SIEMPRE los cambios de estado juntos: flushSync los pinta
   antes de la foto "nueva" y el layout effect del scroll corre dentro, asi
   que la captura ya tiene el scroll correcto.

   "Ahora suena" usa el mismo motor con otro valor de data-vt ("np"): la
   pastilla del mini-reproductor se convierte en la vista a pantalla completa.
   ------------------------------------------------------------------------- */

/* La transicion en curso, para interrumpirla si el usuario cambia de pantalla
   otra vez antes de que termine. */
let running = null;

/* Arranca una View Transition con data-vt = `kind`. `setup` corre antes de
   congelar la foto vieja y puede devolver una funcion que corre justo despues
   de pintar el estado nuevo. Devuelve false si el navegador no la tiene o
   fallo al arrancar (el llamador pinta el estado por su cuenta). */
function viewTransition(kind, update, setup) {
  if (!document.startViewTransition) return false;
  const root = document.documentElement;
  try {
    running?.skipTransition();
    root.dataset.vt = kind;
    const after = setup?.(root);
    const vt = document.startViewTransition(() => {
      flushSync(update);
      after?.();
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
      if (root.dataset.vt === kind) delete root.dataset.vt;
    });
  } catch (e) {
    if (root.dataset.vt === kind) delete root.dataset.vt;
    update();
  }
  return true;
}

export function swapScreens(update, dir = 0) {
  if (reducedMotion()) {
    update();
    return;
  }

  if (
    viewTransition("mode", update, (root) => {
      root.style.setProperty("--vt-dir", dir);
      const y = window.scrollY;
      /* El layout effect ya restauro el scroll de la pantalla nueva: la
         diferencia recoloca la foto vieja (ver shell.css). */
      return () => root.style.setProperty("--vt-shift", `${window.scrollY - y}px`);
    })
  ) {
    return;
  }

  /* Sin View Transitions: el estado se pinta igual y la pantalla visible
     aparece con un fundido corto. */
  flushSync(update);
  document
    .querySelector(".screen:not([hidden])")
    ?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: motion(280),
      easing: "cubic-bezier(0.32, 0.72, 0, 1)",
    });
}

/* Abre o cierra "Ahora suena". Con la API, la pastilla y la vista comparten
   nombre y el navegador mueve una caja en un solo gesto. Sin ella, la vista
   sube desde abajo y, ademas, la portada hace su propio FLIP con WAAPI desde
   el rectangulo de la pastilla hasta el suyo (transform, nada de layout): en
   un WebView sin View Transitions la continuidad no se pierde, solo pierde el
   recorte compartido. Con movimiento reducido, cambia de golpe. */
export function swapNowPlaying(update, opening) {
  if (reducedMotion()) {
    update();
    return;
  }
  if (viewTransition("np", update)) return;

  const slide = { duration: 360, easing: "cubic-bezier(0.23, 1, 0.32, 1)" };
  const up = [{ transform: "translateY(100%)" }, { transform: "none" }];
  if (opening) {
    const first = document.querySelector(".mini__art")?.getBoundingClientRect();
    flushSync(update);
    document.querySelector(".np")?.animate(up, slide);
    const art = first && document.querySelector(".np__art");
    const last = art?.getBoundingClientRect();
    if (last) {
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      const sx = first.width / last.width;
      const sy = first.height / last.height;
      art.animate(
        [{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transform: "none" }],
        { duration: 360, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }
      );
    }
    return;
  }
  const el = document.querySelector(".np");
  if (!el) {
    update();
    return;
  }
  const out = el.animate(up, { ...slide, direction: "reverse", fill: "forwards" });
  out.onfinish = () => flushSync(update);
}
