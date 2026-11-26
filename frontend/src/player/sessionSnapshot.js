/* ---------------------------------------------------------------------------
   SESION DE ESCUCHA (R2-robustez-f)

   Una foto ligera de que sonaba, la cola y en que segundo, para retomarla si
   Android (o el usuario) mata la app. Funciones puras, sin React: se guarda
   cada ~5 s y al ocultarse (App.jsx) y se lee una vez al arrancar. Cualquier
   acceso a localStorage va con try/catch: un almacenamiento lleno o bloqueado
   no puede romper el arranque ni la reproduccion.
   ------------------------------------------------------------------------- */

const KEY = "spitifo:session";
/* Cambiar la forma del snapshot invalida los guardados viejos en vez de hacer
   que restore() reciba una pista a medio llenar. */
const VERSION = 1;
/* Una cola completa ("Reproducir todo" de toda la biblioteca) puede tener
   miles de pistas: el snapshot se queda ligero de verdad, no solo de nombre. */
const QUEUE_CAP = 200;

export function readSnapshot() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.v !== VERSION || !data.track?.key || !data.track?.src) return null;
    return data;
  } catch {
    return null;
  }
}

/* `null` en vez de pista borra el snapshot: nada que retomar. El indice se
   recalcula por clave: no depende de que el llamador lo lleve bien contado. */
export function writeSnapshot(track, queue, time) {
  try {
    if (!track) {
      localStorage.removeItem(KEY);
      return;
    }
    const at = queue.findIndex((t) => t.key === track.key);
    const capped = queue.length <= QUEUE_CAP
      ? queue
      : queue.slice(Math.max(0, (at < 0 ? 0 : at) - QUEUE_CAP / 2), undefined).slice(0, QUEUE_CAP);
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: VERSION,
        track,
        queue: capped,
        index: capped.findIndex((t) => t.key === track.key),
        time: Number(time) || 0,
        savedAt: Date.now(),
      })
    );
  } catch {
    /* lleno o bloqueado: simplemente no se puede retomar la sesion */
  }
}

export function clearSnapshot() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nada que limpiar si ni se puede leer */
  }
}
