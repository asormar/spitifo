import { useSyncExternalStore } from "react";
import { engine } from "./engine.js";

/* Suscripcion al motor para las vistas.

   `selector` DEBE devolver un primitivo o un valor que sea estable entre
   fotos del estado. El motor emite en cada timeupdate (~4 veces por segundo) y
   la biblioteca puede tener 300 filas: si el selector devolviera un objeto
   nuevo en cada emision, React veria un cambio en cada fila y repintaria todo
   cuatro veces por segundo. Por eso las filas preguntan por un booleano o un
   numero ("soy la actual?", "que tiempo llevo?") y no por la foto entera.

   Desde el reloj se separo el canal: `useEngine` escucha solo cambios de
   pista/estado, y `useEngineTime` el tick. Asi ni una fila ni un control se
   despiertan 4 veces por segundo; solo la barra de progreso lo hace. */
export function useEngine(selector = (s) => s) {
  const subscribe = engine.subscribeState || engine.subscribe;
  return useSyncExternalStore(subscribe, () => selector(engine.getState()));
}

export function useEngineTime(selector = (s) => s) {
  const subscribe = engine.subscribeTime || engine.subscribe;
  return useSyncExternalStore(subscribe, () => selector(engine.getState()));
}
