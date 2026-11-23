import { useSyncExternalStore } from "react";

/* ---------------------------------------------------------------------------
   AJUSTE LOCAL GUARDADO

   Lo que repetian Descarga automatica y Preferencias de descarga: un valor en
   localStorage, un Set de suscriptores y el par get/set/subscribe para
   useSyncExternalStore. Aqui solo queda el mecanismo; cada ajuste aporta su
   lectura pura (con la que se prueba en Node), como se guarda y que valores
   acepta. El almacen se escribe igual aunque falle: el valor vale para la
   visita, como en el tema.
   ------------------------------------------------------------------------- */

export function localSetting(key, fallback, { read, write, valid = () => true, normalize = (v) => v }) {
  let value = fallback;
  try {
    const initial = normalize(read());
    if (valid(initial)) value = initial;
  } catch {
    /* Modo privado o almacen bloqueado: el default vale para esta visita. */
  }

  const listeners = new Set();
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const get = () => value;
  const set = (next) => {
    const candidate = normalize(next);
    if (!valid(candidate) || candidate === value) return;
    value = candidate;
    try {
      localStorage.setItem(key, write(candidate));
    } catch {
      /* Sin almacenamiento: se aplica igual mientras dure la sesion. */
    }
    listeners.forEach((fn) => fn());
  };

  /* Par valor/cambiar, como useTheme: SettingsView espera los dos. */
  const use = () => [useSyncExternalStore(subscribe, get), set];

  return { get, set, subscribe, use };
}
