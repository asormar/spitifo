import { API } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   ARRANQUE DE LA COLA (sin arrastrar el espejo al primer script)

   Este modulo es el unico que importa App del download. No conoce el store:
   solo lo carga cuando hace falta y avisa de que ya esta. El espejo, sus textos
   y el anillo quedan fuera del chunk de arranque hasta que el usuario baja algo
   o el sondeo de entrada encuentra trabajo pendiente.
   ------------------------------------------------------------------------- */

const BUSY = new Set(["queued", "pending", "downloading", "processing", "saving"]);

let mod = null;
let loading = null;
let seed = undefined;
let started = false;
const waiters = new Set();

const afterPaint = (fn) => {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => setTimeout(fn, 0));
  } else {
    setTimeout(fn, 0);
  }
};

/* Una sola importacion: la segunda llamada devuelve la misma promesa. */
export function loadQueue() {
  if (!loading) loading = import("./queueStore.js");
  return loading;
}

/* El espejo se anuncia al final de su cuerpo. Ahi ya estan las funciones que
   App necesita; si App monto antes, sus callbacks se disparan ahora. */
export function markQueueReady(m) {
  mod = m;
  for (const cb of [...waiters]) cb(m);
  waiters.clear();
  if (seed === undefined && !started) {
    started = true;
    /* Modulo cargado por una descarga, no por el sondeo: no hay payload que
       aplicar ni aviso de reenganche. Solo se arman los eventos de red. */
    afterPaint(() => m.queueStore.bind());
  }
}

/* Se llama al montar App. Devuelve una funcion para darse de baja. */
export function onQueueReady(cb) {
  if (mod) {
    cb(mod);
    return () => {};
  }
  waiters.add(cb);
  return () => waiters.delete(cb);
}

/* Un GET al abrir, despues del primer pintado. Sin red o sin trabajo pendiente
   no se hace nada: no hay lazo de reintentos en el arranque. */
export function probeQueue() {
  afterPaint(async () => {
    try {
      const r = await fetch(`${API}/downloads`);
      if (!r.ok) return;
      const d = await r.json();
      if (!(d?.items || []).some((i) => BUSY.has(i?.status))) return;
      seed = d;
      const m = await loadQueue();
      m.queueStore.hydrate(d);
    } catch {
      /* sin red al arrancar: lo decide el espejo cuando el usuario descarga */
    }
  });
}
