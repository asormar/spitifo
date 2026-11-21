import { depthOf, isNpEntry, npCloseDelta, npState } from "./navigation.js";

/* ---------------------------------------------------------------------------
   MAQUINA DE ESTADO DE «AHORA SUENA» EN EL HISTORIAL

   Antes este estado vivia en cuatro refs de App y se probaba con un modelo
   que reimplementaba leaveNp y onNpPop: los tests pasaban aunque la conexion
   real se rompiera. Aqui esta todo lo que decide la maquina (que entrada
   empujar, que retroceso pedir, cuando cerrar el panel y cuando correr `then`)
   con un historial inyectado. App solo ejecuta el efecto de cierre.

   npEntry: 0 cerrada, 1 abierta, 2 retroceso en curso (ya se pidio el go; un
   segundo cierre o un leaveNp no puede pedir otro). `then` es la ultima
   intencion del usuario; `morph` si la salida es la animacion de la pastilla.
   ------------------------------------------------------------------------- */

export function createNpHistory({ history, closePanel } = {}) {
  let entry = 0;
  let depth = 0;
  let morph = true;
  let then = null;

  const unwind = (stackDepth) => {
    /* El estado de la entrada de arriba trae la profundidad de la pila: con un
       menu sobre NP es npDepth + 1, y ese menu y la vista salen en un solo go. */
    const delta = npCloseDelta(stackDepth, depth);
    entry = 2;
    history.go(-delta);
  };

  const close = (animated = true) => {
    if (entry === 2) return;
    if (!entry) {
      closePanel?.({ then: null, morph: false, direct: true });
      return;
    }
    morph = animated;
    unwind(depthOf(history.state));
  };

  return {
    get entry() {
      return entry;
    },
    get depth() {
      return depth;
    },
    get open() {
      return entry === 1;
    },

    /* Abrir: se marca al pedir el chunk (para que un segundo tap no empuje dos
       entradas) y se empuja cuando el chunk ya esta, dentro de pushNp. */
    open(stackDepth) {
      if (entry) return false;
      entry = 1;
      depth = stackDepth;
      return true;
    },
    cancelOpen() {
      if (entry === 1) entry = 0;
    },
    pushNp() {
      if (entry === 1) history.push(npState(depth));
    },

    /* La X, Escape sin menu y el arrastre. Con entrada, pide el retroceso y
       deja que el popstate cierre; sin entrada (escritorio) cierra ya. */
    close,

    /* «Cerrar reproductor» del menu: la hoja y la vista salen en un go. Se
       marca como en vuelo y se descarta cualquier `then` pendiente (un cambio
       de pestana, por ejemplo): el usuario acaba de cerrar el reproductor. Un
       segundo tap mientras el go esta en vuelo no hace nada. */
    closeFromMenu() {
      if (!entry) {
        closePanel?.({ then: null, morph: false, direct: true });
        return "desktop";
      }
      if (entry === 2) {
        /* El go ya esta en vuelo: no repetirlo, pero este tap si descarta la
           intencion anterior: el usuario acaba de cerrar el reproductor. */
        then = null;
        morph = false;
        return;
      }
      morph = false;
      then = null;
      unwind(depthOf(history.state));
      return undefined;
    },

    /* Cambiar de pestana, abrir una pagina desde el menu o abrir Ajustes.
       Devuelve true si se hizo cargo, para que el llamador no navegue dos veces.
       Si ya hay un retroceso en vuelo NO se pide otro: se guarda solo la ultima
       intencion (el ultimo tap gana) y la anterior nunca llega a correr. */
    leave(next) {
      if (!entry) return false;
      then = next ?? null;
      if (entry === 1) unwind(depthOf(history.state));
      return true;
    },

    /* Escape con menu encima solo cierra ese menu (nav.back en App); sin menu,
       cierra la vista con animacion. En escritorio no se hace cargo. */
    escape(above) {
      if (!entry) return false;
      if (above) return "overlay";
      close(true);
      return true;
    },

    /* El popstate de Ahora suena va despues del de useNav. Aterrizar en la
       entrada de la vista (porque habia un menu encima) no es un cierre: solo
       se recorta la pila. Al bajar de verdad se cierra el panel y corre `then`. */
    onPop() {
      if (!entry || isNpEntry(history.state)) return;
      entry = 0;
      const pending = then;
      const animated = morph;
      then = null;
      morph = true;
      closePanel?.({ then: pending, morph: animated });
    },
  };
}

/* Token del sitio donde nace una navegacion asincrona (por ejemplo «Ir a
   <artista>» sin id, que espera una busqueda). Lo guarda el que llama y lo
   compara al resolverse: si el usuario retrocedio, cerro el reproductor o
   navego mientras tanto, el token ya no coincide y la accion tardia se
   descarta. Vive en el padre: el menu se desmonta con el primer atras. */
export function createLocationToken({ getStack, np, gen }) {
  return () => {
    const top = getStack()?.at(-1);
    return `${gen.current}|${top?.type ?? ""}|${top?.key ?? ""}|${np.entry}`;
  };
}
