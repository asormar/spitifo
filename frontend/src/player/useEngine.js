import { useSyncExternalStore } from "react";
import { engine } from "./engine.js";

/* Suscripcion al motor para las vistas.

   `selector` DEBE devolver un primitivo o un valor que sea estable entre
   fotos del estado. El motor emite en cada timeupdate (~4 veces por segundo) y
   la biblioteca puede tener 300 filas: si el selector devolviera un objeto
   nuevo en cada emision, React veria un cambio en cada fila y repintaria todo
   cuatro veces por segundo. Por eso las filas preguntan por un booleano o un
   numero ("soy la actual?", "que tiempo llevo?") y no por la foto entera. */
export function useEngine(selector = (s) => s) {
  return useSyncExternalStore(engine.subscribe, () => selector(engine.getState()));
}
