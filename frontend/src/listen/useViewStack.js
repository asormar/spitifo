import { useCallback, useEffect, useRef, useState } from "react";

/* ---------------------------------------------------------------------------
   PILA DE VISTAS DE ESCUCHAR

   Las paginas de Escuchar (un album, "Ver todo", Explorar la biblioteca) y la
   busqueda activa se apilan sobre el inicio. Cada una empuja UNA entrada al
   historial, como Ajustes y "Ahora suena": asi el atras del navegador y el de
   Android las cierran de una en una en vez de salir de la app.

   Cada entrada lleva en su estado cuantas vistas habia al crearla. Cuando llega
   un popstate que la propia pantalla no pidio, esa cifra dice a cuantas vistas
   hay que volver. Si la pantalla lo pidio (el boton Volver), el estado ya se
   cambio y el popstate se ignora (`skip`). `then` es lo que hay que hacer cuando
   el historial ya esta abajo: sustituir la pila entera sin pasar por el inicio.
   ------------------------------------------------------------------------- */

const MARK = "spitifoListen";

/* Cuantas vistas tenia la pila al crearse la entrada del historial. */
const depthOf = (state) => Number(state?.[MARK]) || 0;

export default function useViewStack() {
  const [stack, setStack] = useState([]);
  const ref = useRef(stack);
  const skip = useRef(0);
  const after = useRef(null);

  const commit = useCallback((next) => {
    ref.current = next;
    setStack(next);
  }, []);

  const push = useCallback(
    (view) => {
      const next = [...ref.current, view];
      window.history.pushState({ [MARK]: next.length }, "", window.location.href);
      commit(next);
    },
    [commit]
  );

  /* Quita las `count` vistas de arriba (por defecto una). */
  const pop = useCallback(
    (count = 1) => {
      const n = Math.min(count, ref.current.length);
      if (n < 1) return;
      commit(ref.current.slice(0, ref.current.length - n));
      skip.current += 1;
      window.history.go(-n);
    },
    [commit]
  );

  /* Deja `view` como unica pagina: el historial baja hasta el inicio y, cuando
     ya esta abajo, se empuja la nueva. Sin paginas abiertas es un push. */
  const reset = useCallback(
    (view) => {
      const n = ref.current.length;
      if (!n) {
        push(view);
        return;
      }
      skip.current += 1;
      after.current = () => {
        commit([]);
        push(view);
      };
      window.history.go(-n);
    },
    [commit, push]
  );

  useEffect(() => {
    const onPop = () => {
      if (skip.current > 0) {
        skip.current -= 1;
        const then = after.current;
        after.current = null;
        then?.();
        return;
      }
      /* history.state y no e.state: otro oyente del mismo popstate (App, al
         cerrar "Ahora suena") pudo empujar ya una entrada nueva, y la foto del
         evento seria la de antes. */
      const depth = depthOf(window.history.state);
      if (depth < ref.current.length) commit(ref.current.slice(0, depth));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [commit]);

  return { stack, getStack: () => ref.current, push, pop, reset };
}
