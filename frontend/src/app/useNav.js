import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  HISTORY_MARK,
  TABS,
  depthOf,
  modeDirection,
  pageOf,
  readRoute,
  readView,
  replaceTop,
  stackAfterPop,
  stackAt,
  switchTab,
  viewKey,
  withStack,
  writeRoute,
} from "./navigation.js";
import { swapScreens } from "./screenSwap.js";

/* ---------------------------------------------------------------------------
   NAVEGACION

   Un solo controlador del historial para las cuatro pestanas, Ajustes y las
   paginas apiladas (album, artista, "Ver todo"...). Cada pestana tiene SU pila
   en un Map: cambiar de pestana no borra la que dejaste (goTab solo cambia
   cual está activa) y cada pagina conserva su clave de scroll. Ajustes es una
   pagina mas de la pila activa.

   Historial = la entrada de la raiz + una entrada por pagina abrierta en la
   pestana activa. Cambiar de pestana nunca empuja entradas (replaceState): el
   atras de Android en la raiz sale de la app. Cada entrada de pagina lleva en
   su estado cuantas paginas habia al crearla (HISTORY_MARK): un popstate que
   la propia pantalla no pidio (atras del navegador o de Android) se resuelve
   con esa cifra. Esa mecanica NO cambia.

   La URL es un espejo de solo lectura de la pagina visible (?view= y ?page=):
   cada open/replace/pop la reescribe, sin anadir entradas nuevas. Al arrancar
   se replaya sobre la pila antes del primer pintado.

   La pantalla manda y el historial la sigue: primero se pinta, despues se
   deshacen las entradas con history.go(-n). Mientras ese retroceso esta en
   vuelo (`skip`), las demas acciones esperan en `deferred`: dos go() seguidos
   saldrian de la app.

   "Ahora suena" tiene su propia entrada ({ spitifo: "np" }) y la lleva App: el
   oyente de popstate de aqui va ANTES que el suyo. Esa entrada lleva la
   profundidad de la pila al abrirse; al volver a ella se recorta aqui, para
   que el menu que hubiera encima no se quede colgado.
   ------------------------------------------------------------------------- */

export const NavContext = createContext(null);
export const useNav = () => useContext(NavContext);

const TAB_SET = new Set(TABS);

const settingsPage = (focus = null) => ({ type: "settings", focus });
const top = (stack) => stack[stack.length - 1];
const activeIdOf = (nav) => (top(nav.stack)?.type === "settings" ? "settings" : nav.tab);
const withVisit = (visited, id) => (visited.has(id) ? visited : new Set(visited).add(id));

/* La pila activa y el Map van siempre juntos: `withStack` y `switchTab`
   (navigation.js) son las unicas que los mueven. */

/* Direccion canonica del estado que se va a pintar. Las hojas no cambian la
   ruta: pageOf salta todo lo que no sea una pagina. */
const routeFor = (state) => {
  const stack = state.stack ?? stackAt(state, state.tab);
  return (
    writeRoute(window.location.search, {
      tab: state.tab,
      settings: top(stack)?.type === "settings",
      page: pageOf(stack),
    }) || window.location.pathname
  );
};

/* Espejo: sustituye la entrada actual sin crear una nueva. Se pasa el estado
   explicito porque window.history.state puede ser el de "Ahora suena". */
const mirror = (state, histState = window.history.state) =>
  window.history.replaceState(histState, "", routeFor(state));

export default function useNavController({ leaveNp, warm, onNavigate } = {}) {
  const [nav, setNav] = useState(() => {
    const boot = readRoute(window.location.search);
    const stacks = new Map(TABS.map((t) => [t, []]));
    const stack = boot.page ? [boot.page] : [];
    if (boot.settings) stack.push(settingsPage());
    stacks.set(boot.tab, stack);
    return {
      tab: boot.tab,
      stack,
      stacks,
      visited: new Set(boot.settings ? [boot.tab, "settings"] : [boot.tab]),
    };
  });
  /* El estado logico: se actualiza al pedir el cambio, aunque la View
     Transition pinte un cuadro despues. */
  const ref = useRef(nav);
  const hooks = useRef({ leaveNp, warm, onNavigate });
  hooks.current = { leaveNp, warm, onNavigate };
  const scrolls = useRef(new Map());
  const skip = useRef(0);
  const after = useRef(null);
  const deferred = useRef([]);

  const actions = useMemo(() => {
    const remember = () => {
      scrolls.current.set(viewKey(ref.current.tab, ref.current.stack), window.scrollY);
    };

    /* Las claves de scroll son por pagina, no por pestaña: sobreviven a un
       cambio de pestana y a las hojas que se abren encima. */

    /* `swap` (0 o -1/1): cambio de pantalla animado; sin ella, las paginas se
       apilan sin transicion, como siempre. */
    const commit = (next, swap) => {
      hooks.current.onNavigate?.();
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
        const next = withStack(cur, [...cur.stack, view]);
        /* Una pagina nueva empieza por arriba; la marca de busqueda comparte
           clave con la raiz y no la pisa. */
        const key = viewKey(next.tab, next.stack);
        if (key !== viewKey(cur.tab, cur.stack)) scrolls.current.delete(key);
        window.history.pushState({ [HISTORY_MARK]: next.stack.length }, "", routeFor(next));
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
        const next = withStack(cur, cur.stack.slice(0, cur.stack.length - k));
        commitScreen(next);
        skip.current += 1;
        after.current = () => mirror(next);
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
        const next = withStack(cur, replaceTop(cur.stack, view));
        const key = viewKey(next.tab, next.stack);
        if (key !== viewKey(cur.tab, cur.stack)) scrolls.current.delete(key);
        window.history.replaceState({ [HISTORY_MARK]: next.stack.length }, "", routeFor(next));
        commit(next);
      });

    /* Salto real a otra pestana (contenido ajeno, por ejemplo el catalogo).
       Mantiene la pila de origen en el Map y empuja la pagina de destino. */
    const goTo = (t, view = null) =>
      act(() => {
        if (!TAB_SET.has(t)) return;
        if (t === "discover") hooks.current.warm?.(t);
        if (hooks.current.leaveNp?.(() => goTo(t, view))) return;
        const cur = ref.current;
        const n = cur.stack.length;
        if (t === cur.tab && !view && !n) return;
        remember();
        const stacks = new Map(cur.stacks).set(cur.tab, cur.stack);
        const stack = view ? [view] : stacks.get(t) ?? [];
        stacks.set(t, stack);
        const next = { tab: t, stack, stacks, visited: withVisit(cur.visited, t) };
        if (view) scrolls.current.delete(viewKey(t, stack));
        commitScreen(next);
        unwind(n, () => {
          window.history.replaceState(null, "", routeFor({ ...next, stack: [] }));
          if (view) window.history.pushState({ [HISTORY_MARK]: 1 }, "", routeFor(next));
          else if (stack.length) window.history.replaceState({ [HISTORY_MARK]: stack.length }, "", routeFor(next));
        });
      });

    /* Tocar la barra: solo cambia la pestana activa en el Map; la pila de la
       que dejas NO se borra. El historial se comporta como siempre (unwind de
       las paginas de la pestana saliente y replaceState sin entradas nuevas)
       para que el atras fisico de Android siga exactamente igual. */
    const goTab = (t) =>
      act(() => {
        if (!TAB_SET.has(t)) return;
        if (t === "discover") hooks.current.warm?.(t);
        const cur = ref.current;
        const n = cur.stack.length;
        if (t === cur.tab && !n) return;
        remember();
        const next = switchTab(cur, t);
        commitScreen(next);
        unwind(n, () => {
          window.history.replaceState(
            next.stack.length ? { [HISTORY_MARK]: next.stack.length } : null,
            "",
            routeFor(next)
          );
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
            commit(withStack(cur, [...cur.stack.slice(0, -1), settingsPage(focus)]));
          }
          return;
        }
        remember();
        const next = withStack(cur, [...cur.stack, settingsPage(focus)]);
        window.history.pushState({ [HISTORY_MARK]: next.stack.length }, "", routeFor(next));
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
      const cur = ref.current;
      const depth = depthOf(window.history.state);
      /* La entrada de "Ahora suena" tampoco se salta: guarda la profundidad
         que tenia la pila al abrirse, asi que aterrizar en ella (tras cerrar
         un menu que estaba encima) recorta la pila y deja la vista abierta. */
      if (depth < cur.stack.length) {
        remember();
        const next = withStack(cur, stackAfterPop(cur.stack, window.history.state));
        commitScreen(next);
        mirror(next);
      } else if (depth > cur.stack.length) {
        /* Un adelante a una pagina que ya no existe: la entrada se reescribe
           con lo que de verdad se ve. */
        window.history.replaceState(
          cur.stack.length ? { [HISTORY_MARK]: cur.stack.length } : null,
          "",
          routeFor(cur)
        );
      } else if (!cur.stack.length) {
        const view = readView(window.location.search);
        if (view.tab !== cur.tab) {
          if (view.tab === "discover") hooks.current.warm?.(view.tab);
          remember();
          const next = switchTab(cur, view.tab);
          commitScreen(next);
          mirror(next);
        }
      }
    };

    return {
      open,
      back,
      pop,
      replace,
      goTab,
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

  /* Arranque: la ruta se replaya sobre la pila en el estado inicial (antes
     del primer pintado).Una profundidad vieja en el estado se descarta y
     ?view=settings deja Inicio debajo para que Volver no salga de la app. */
  useEffect(() => {
    /* El scroll lo recuerda cada vista (scrolls): sin esto el navegador lo
       devolvia al cerrar un menu que se cerro porque la pagina se movio. */
    window.history.scrollRestoration = "manual";
    const boot = readRoute(window.location.search);
    const depth = boot.page ? 1 : 0;
    if (depthOf(window.history.state) !== depth) {
      window.history.replaceState(depth ? { [HISTORY_MARK]: depth } : null, "", window.location.href);
    }
    if (boot.settings) {
      const base = writeRoute(window.location.search, { tab: boot.tab });
      window.history.replaceState(null, "", base || window.location.pathname);
      window.history.pushState(
        { [HISTORY_MARK]: 1 },
        "",
        writeRoute(base, { tab: boot.tab, settings: true })
      );
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
      stacks: nav.stacks,
      visited: nav.visited,
      activeId: activeIdOf(nav),
      /* Ajustes abierto, con el destino que se pidio. */
      settings: top(nav.stack)?.type === "settings" ? top(nav.stack) : null,
      pageOf: (id) => pageOf(stackAt(nav, id)),
      stackOf: (id) => stackAt(nav, id),
    };
  }, [nav, actions]);
}
