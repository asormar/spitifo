import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  HISTORY_MARK,
  TABS,
  depthOf,
  modeDirection,
  pageOf,
  readView,
  replaceTop,
  stackFor,
  truncate,
  viewKey,
  writeView,
} from "./navigation.js";
import { swapScreens } from "./screenSwap.js";

/* ---------------------------------------------------------------------------
   NAVEGACION

   Un solo controlador del historial para las cuatro pestanas, Ajustes y las
   paginas apiladas (album, artista, "Ver todo"...). Hay UNA pila de paginas,
   de la pestana activa: cambiar de pestana la vacia y tocar la pestana activa
   vuelve a su raiz. Ajustes es una pagina mas de esa pila.

   Historial = la entrada de la raiz + una entrada por pagina. Cambiar de
   pestana nunca empuja entradas (replaceState): el atras de Android en la raiz
   de una pestana sale de la app. Cada entrada de pagina lleva en su estado
   cuantas paginas habia al crearla (HISTORY_MARK): un popstate que la propia
   pantalla no pidio (atras del navegador o de Android) se resuelve con esa
   cifra.

   La pantalla manda y el historial la sigue: primero se pinta, despues se
   deshacen las entradas con history.go(-n). Mientras ese retroceso esta en
   vuelo (`skip`), las demas acciones esperan en `deferred`: dos go() seguidos
   saldrian de la app.

   "Ahora suena" tiene su propia entrada ({ spitifo: "np" }) y la lleva App: el
   oyente de popstate de aqui va ANTES que el suyo y no toca esas entradas.
   ------------------------------------------------------------------------- */

export const NavContext = createContext(null);
export const useNav = () => useContext(NavContext);

const TAB_SET = new Set(TABS);

/* writeView devuelve "" para Inicio sin otros parametros, y pushState/
   replaceState con "" no cambian la URL: se cae al pathname. */
const viewUrl = (view) => writeView(window.location.search, view) || window.location.pathname;

const settingsPage = (focus = null) => ({ type: "settings", focus });
const top = (stack) => stack[stack.length - 1];
const activeIdOf = (nav) => (top(nav.stack)?.type === "settings" ? "settings" : nav.tab);
const withVisit = (visited, id) => (visited.has(id) ? visited : new Set(visited).add(id));

/* `leaveNp(then)`: cierra "Ahora suena" si esta abierta y corre `then` cuando
   el historial ya bajo (true = se hizo cargo). `warm(tab)`: adelanto al elegir
   una pestana (el mapa de Descubrir viaja en el mismo gesto). */
export default function useNavController({ leaveNp, warm } = {}) {
  const [nav, setNav] = useState(() => {
    const boot = readView(window.location.search);
    return {
      tab: boot.tab,
      stack: boot.settings ? [settingsPage()] : [],
      visited: new Set(boot.settings ? [boot.tab, "settings"] : [boot.tab]),
    };
  });
  /* El estado logico: se actualiza al pedir el cambio, aunque la View
     Transition pinte un cuadro despues. */
  const ref = useRef(nav);
  const hooks = useRef({ leaveNp, warm });
  hooks.current = { leaveNp, warm };
  const scrolls = useRef(new Map());
  const skip = useRef(0);
  const after = useRef(null);
  const deferred = useRef([]);

  const actions = useMemo(() => {
    const remember = () => {
      scrolls.current.set(viewKey(ref.current.tab, ref.current.stack), window.scrollY);
    };

    /* Las paginas de una pestana no sobreviven a su pila: tampoco su scroll. */
    const forgetPages = (tab) => {
      for (const k of [...scrolls.current.keys()]) {
        if (k.startsWith(`${tab}/`)) scrolls.current.delete(k);
      }
    };

    /* `swap` (0 o -1/1): cambio de pantalla animado; sin ella, las paginas se
       apilan sin transicion, como siempre. */
    const commit = (next, swap) => {
      ref.current = next;
      const update = () => setNav(next);
      if (swap === undefined) update();
      else swapScreens(update, swap);
    };

    /* Lo mismo, animado solo si cambia la pantalla visible (pestana o
       Ajustes); dentro de la misma, las paginas no llevan transicion. */
    const commitScreen = (next) => {
      const from = activeIdOf(ref.current);
      const to = activeIdOf(next);
      commit(next, from === to ? undefined : modeDirection(from, to));
    };

    const act = (fn) => {
      if (skip.current > 0) deferred.current.push(fn);
      else fn();
    };

    /* Baja `n` entradas del historial y corre `then` cuando ya estan abajo. */
    const unwind = (n, then) => {
      if (n < 1) {
        then?.();
        return;
      }
      skip.current += 1;
      after.current = then ?? null;
      window.history.go(-n);
    };

    const open = (view) =>
      act(() => {
        if (view.type === "settings") {
          openSettings(view.focus);
          return;
        }
        const cur = ref.current;
        remember();
        const next = { ...cur, stack: [...cur.stack, view] };
        /* Una pagina nueva empieza por arriba; la marca de busqueda comparte
           clave con la raiz y no la pisa. */
        const key = viewKey(next.tab, next.stack);
        if (key !== viewKey(cur.tab, cur.stack)) scrolls.current.delete(key);
        window.history.pushState({ [HISTORY_MARK]: next.stack.length }, "", window.location.href);
        commit(next);
      });

    /* Quita `n` paginas de arriba de una vez (borrar una lista desde su menu
       cierra el menu y la pagina). Un solo go(-n): un solo popstate. */
    const pop = (n = 1) =>
      act(() => {
        const cur = ref.current;
        const k = Math.min(n, cur.stack.length);
        if (k < 1) return;
        remember();
        const next = { ...cur, stack: cur.stack.slice(0, cur.stack.length - k) };
        commitScreen(next);
        skip.current += 1;
        after.current = null;
        window.history.go(-k);
      });

    /* Sin argumentos porque se cablea como onClick. */
    const back = () => pop(1);

    /* Cambia la entrada de arriba por otra sin dejar entrada nueva en el
       historial (un menu que pasa a la hoja de listas, o a una pagina): atras
       sigue quitando una sola. Recuerda el scroll como `open`. */
    const replace = (view) =>
      act(() => {
        const cur = ref.current;
        if (!cur.stack.length || view.type === "settings") {
          open(view);
          return;
        }
        remember();
        const next = { ...cur, stack: replaceTop(cur.stack, view) };
        const key = viewKey(next.tab, next.stack);
        if (key !== viewKey(cur.tab, cur.stack)) scrolls.current.delete(key);
        window.history.replaceState({ [HISTORY_MARK]: next.stack.length }, "", window.location.href);
        commit(next);
      });

    /* Pestana `t` con la pila vacia o, con `view`, con esa unica pagina. Sirve
       tambien para tocar la pestana activa (vuelve a su raiz) y para pasar de
       una pantalla a una pagina de otra ("Ver en tu biblioteca"). */
    const goTo = (t, view = null) =>
      act(() => {
        if (!TAB_SET.has(t)) return;
        if (t === "discover") hooks.current.warm?.(t);
        if (hooks.current.leaveNp?.(() => goTo(t, view))) return;
        const cur = ref.current;
        const n = cur.stack.length;
        if (t === cur.tab && !view && !n) return;
        remember();
        forgetPages(cur.tab);
        const next = {
          tab: t,
          stack: view ? [view] : [],
          visited: withVisit(cur.visited, t),
        };
        if (view) scrolls.current.delete(viewKey(t, next.stack));
        commitScreen(next);
        unwind(n, () => {
          window.history.replaceState(null, "", viewUrl({ tab: t, settings: false }));
          if (view) window.history.pushState({ [HISTORY_MARK]: 1 }, "", window.location.href);
        });
      });

    const openSettings = (focus = null) =>
      act(() => {
        if (hooks.current.leaveNp?.(() => openSettings(focus))) return;
        const cur = ref.current;
        const on = top(cur.stack);
        if (on?.type === "settings") {
          /* Ya abierta: solo cambia a donde se lleva el foco. */
          if (on.focus !== focus) {
            commit({ ...cur, stack: [...cur.stack.slice(0, -1), settingsPage(focus)] });
          }
          return;
        }
        remember();
        const next = {
          ...cur,
          stack: [...cur.stack, settingsPage(focus)],
          visited: withVisit(cur.visited, "settings"),
        };
        window.history.pushState(
          { [HISTORY_MARK]: next.stack.length },
          "",
          viewUrl({ tab: cur.tab, settings: true })
        );
        commitScreen(next);
      });

    const toggleSettings = () => {
      if (top(ref.current.stack)?.type === "settings") back();
      else openSettings(null);
    };

    /* Atras del navegador o de Android. */
    const onPop = () => {
      if (skip.current > 0) {
        skip.current -= 1;
        if (skip.current > 0) return;
        const then = after.current;
        after.current = null;
        then?.();
        const queued = deferred.current;
        deferred.current = [];
        queued.forEach(act);
        return;
      }
      /* La entrada de "Ahora suena" no es de aqui. */
      if (window.history.state?.spitifo === "np") return;
      const cur = ref.current;
      const depth = depthOf(window.history.state);
      if (depth < cur.stack.length) {
        remember();
        const next = { ...cur, stack: truncate(cur.stack, depth) };
        commitScreen(next);
      } else if (depth > cur.stack.length) {
        /* Un adelante a una pagina que ya no existe: la entrada se reescribe
           con lo que de verdad se ve. */
        window.history.replaceState(
          cur.stack.length ? { [HISTORY_MARK]: cur.stack.length } : null,
          "",
          viewUrl({ tab: cur.tab, settings: top(cur.stack)?.type === "settings" })
        );
      } else if (!cur.stack.length) {
        const view = readView(window.location.search);
        if (view.tab !== cur.tab) {
          if (view.tab === "discover") hooks.current.warm?.(view.tab);
          remember();
          commitScreen({ tab: view.tab, stack: [], visited: withVisit(cur.visited, view.tab) });
        }
      }
    };

    return {
      open,
      back,
      pop,
      replace,
      goTab: (t) => goTo(t),
      goTo,
      openSettings,
      toggleSettings,
      getStack: () => ref.current.stack,
      /* La clave de la vista de ahora (viewKey): donde se abrio el panel. */
      getKey: () => viewKey(ref.current.tab, ref.current.stack),
      onPop,
      scrolls,
    };
  }, []);

  /* Antes que el oyente de "Ahora suena" (App lo registra despues). */
  useEffect(() => {
    window.addEventListener("popstate", actions.onPop);
    return () => window.removeEventListener("popstate", actions.onPop);
  }, [actions]);

  /* Arranque: una profundidad vieja en el estado (recarga con paginas abiertas)
     se descarta, y ?view=settings deja Inicio debajo para que Volver no salga
     de la app. */
  useEffect(() => {
    /* El scroll lo recuerda cada vista (scrolls): sin esto el navegador lo
       devolvia al cerrar un menu que se cerro porque la pagina se movio. */
    window.history.scrollRestoration = "manual";
    const boot = readView(window.location.search);
    if (depthOf(window.history.state) > 0) window.history.replaceState(null, "", window.location.href);
    if (boot.settings) {
      window.history.replaceState(null, "", viewUrl({ tab: boot.tab, settings: false }));
      window.history.pushState({ [HISTORY_MARK]: 1 }, "", viewUrl({ tab: boot.tab, settings: true }));
    }
  }, []);

  /* Cada vista recuerda su scroll: volver la deja donde estaba. Va en layout
     effect y swapScreens lo corre dentro de flushSync, asi la foto de la View
     Transition ya sale con el scroll bueno. */
  const key = viewKey(nav.tab, nav.stack);
  const prevKey = useRef(key);
  useLayoutEffect(() => {
    if (prevKey.current === key) return;
    prevKey.current = key;
    window.scrollTo(0, actions.scrolls.current.get(key) ?? 0);
  }, [key, actions]);

  return useMemo(() => {
    const { scrolls: _scrolls, onPop: _onPop, ...api } = actions;
    return {
      ...api,
      tab: nav.tab,
      stack: nav.stack,
      visited: nav.visited,
      activeId: activeIdOf(nav),
      /* Ajustes abierto, con el destino que se pidio. */
      settings: top(nav.stack)?.type === "settings" ? top(nav.stack) : null,
      pageOf: (id) => pageOf(stackFor(id, nav.tab, nav.stack)),
      stackOf: (id) => stackFor(id, nav.tab, nav.stack),
    };
  }, [nav, actions]);
}
