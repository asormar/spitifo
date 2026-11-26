/* ---------------------------------------------------------------------------
   GUARDIA DE FOTOGRAMAS (U-motion-interaction-11)

   Una sola guardia para los bucles ambientales: la pestaña oculta pone
   `body.is-hidden` y un unico IntersectionObserver marca `is-offscreen` en
   cualquier elemento registrado que salga del viewport. El CSS decide despues
   `animation-play-state: paused`. El anillo del mini ya tenia su propia
   guardia; esta la comparte con las dos respiraciones de Descubrir.
   ------------------------------------------------------------------------- */

let observer = null;
const watched = new WeakSet();

function ensureObserver() {
  if (observer || typeof IntersectionObserver === "undefined") return;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        entry.target.classList.toggle("is-offscreen", !entry.isIntersecting);
      }
    },
    { threshold: 0 }
  );
}

export function watchMotion(el) {
  if (!el) return () => {};
  ensureObserver();
  if (observer && !watched.has(el)) {
    observer.observe(el);
    watched.add(el);
  }
  return () => {
    if (observer && watched.has(el)) {
      observer.unobserve(el);
      watched.delete(el);
    }
  };
}

/* Los dos bucles de Descubrir (el boton ocupado y el pulso del mapa) entran y
   salen del DOM: se registran solos, sin tocar sus componentes. */
const BREATHE = ".fy-btn.is-busy svg, .gmap__pulse";

export function installVisibilityGuard() {
  if (typeof document === "undefined") return () => {};
  const apply = () => document.body.classList.toggle("is-hidden", Boolean(document.hidden));
  const scan = (root = document) => root.querySelectorAll?.(BREATHE).forEach(watchMotion);
  apply();
  scan();
  document.addEventListener("visibilitychange", apply);
  const mutations =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => scan());
  mutations?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  return () => {
    document.removeEventListener("visibilitychange", apply);
    mutations?.disconnect();
  };
}
