import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

/* Tema claro/oscuro. El valor inicial ya lo puso index.html en <html> antes de
   pintar; aqui solo se lee de ahi. Se guarda en localStorage cuando el usuario
   lo elige a mano; mientras no haya eleccion guardada, sigue al sistema. */
export const THEME_KEY = "spitifo-theme";
export const THEME_COLOR = { light: "#CFE6F5", dark: "#14293B" };

export function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLOR[t]);
}

export function useTheme() {
  const [theme, setTheme] = useState(
    () => document.documentElement.getAttribute("data-theme") || "light"
  );

  const choose = useCallback((t) => {
    /* El cambio se hace dentro de una View Transition: el navegador congela la
       pagina vieja y el tema nuevo se descubre encima con una cortina que baja
       (ver ::view-transition-new en app/nav.css). flushSync hace que React pinte
       el boton y el resto ya en el nuevo estado antes de que el navegador
       tome la foto "nueva". Sin la API, o con movimiento reducido, se cambia
       directamente. */
    const commit = () =>
      flushSync(() => {
        applyTheme(t);
        setTheme(t);
      });
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (document.startViewTransition && !reduce) {
      /* La transicion RECHAZA si el documento queda oculto (el usuario cambia
         de pestana justo al apretar) y tambien si `commit` tira. El rechazo
         llega como `unhandledrejection` aunque el tema se aplique igual, porque
         el callback se corre en cualquier caso: por eso se tragan las tres
         promesas. Sin esto la consola del usuario se llena de
         "InvalidStateError: Transition was aborted". */
      try {
        const vt = document.startViewTransition(commit);
        vt.ready.catch(() => {});
        vt.finished.catch(() => {});
        vt.updateCallbackDone.catch(() => {});
      } catch (e) {
        commit();
      }
    } else {
      commit();
    }
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch (e) {
      /* Sin almacenamiento (modo privado): el tema vale para esta visita. */
    }
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  /* Sin eleccion guardada, cambiar el tema del sistema se refleja en vivo. */
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e) => {
      let saved = null;
      try {
        saved = localStorage.getItem(THEME_KEY);
      } catch (err) {
        /* igual que arriba */
      }
      if (saved === "light" || saved === "dark") return;
      const t = e.matches ? "dark" : "light";
      applyTheme(t);
      setTheme(t);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return [theme, choose];
}
