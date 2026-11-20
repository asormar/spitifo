import { useSyncExternalStore } from "react";

/* ---------------------------------------------------------------------------
   SENAL DE RED COMPARTIDA

   navigator.onLine mas los eventos online/offline. Un solo store para toda la
   app: volver a conectarse repinta las filas sin recargar. No toca window en
   Node, asi que se puede importar en las pruebas.
   ------------------------------------------------------------------------- */

const subs = new Set();
let bound = false;

const current = () =>
  typeof navigator === "undefined" || navigator.onLine !== false;

const notify = () => subs.forEach((fn) => fn());

function subscribe(fn) {
  if (typeof window === "undefined") return () => {};
  if (!bound) {
    window.addEventListener("online", notify);
    window.addEventListener("offline", notify);
    bound = true;
  }
  subs.add(fn);
  return () => {
    subs.delete(fn);
    if (!subs.size) {
      window.removeEventListener("online", notify);
      window.removeEventListener("offline", notify);
      bound = false;
    }
  };
}

export const useOnline = () =>
  useSyncExternalStore(subscribe, current, () => true);
