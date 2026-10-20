/* ---------------------------------------------------------------------------
   REPRODUCTOR

   El <audio> nativo no admite casi ningun estilo (solo width, height,
   color-scheme y accent-color), asi que sale como una caja oscura de esquinas
   rectas en medio de una interfaz clara. Aqui el <audio> SIGUE en el DOM, sin
   `controls` (no pinta nada), y se le dibuja encima una interfaz propia. Se
   conserva el elemento a proposito: las teclas multimedia del sistema, la
   pestana de Chrome y los lectores de pantalla siguen hablando con el.

   Dos niveles: "row" (biblioteca: boton, barra, tiempo y volumen) y "compact"
   (preview de 30 s en una tarjeta de resultados: prueba de sabor, sin volumen).

   UNA sola cancion suena a la vez. Con 31 <audio> independientes se podian
   tener cinco superpuestas. El registro `players` lo resuelve en el evento
   `play`, asi tambien cubre las teclas multimedia, que no pasan por el boton.
   El volumen y el silencio se comparten entre todos los reproductores.
   ------------------------------------------------------------------------- */

export const players = new Set();
export const shared = { volume: 0.8, muted: false };

/* La fila "activa" (filo coral, volumen, tirador) es solo la ULTIMA que sono.
   Una pausada a medias conserva su progreso, pero no se queda con el volumen
   abierto: tras probar cinco canciones serian cinco sliders. Los Player se
   suscriben para repintarse cuando cambia. */
export let current = null;
export const watchers = new Set();
export function setCurrent(a) {
  current = a;
  watchers.forEach((w) => w());
}

/* Volumen y silencio comparten una sola fuente (`shared`) que escriben el
   Player activo y el mini-reproductor. Estas funciones la actualizan, aplican
   el cambio al <audio> que suena y avisan a los watchers para que ambos
   controles se repinten: ninguno guarda su propia copia del valor. */
export function pushVolume() {
  if (current) {
    current.volume = shared.volume;
    current.muted = shared.muted;
  }
  watchers.forEach((w) => w());
}

export function setSharedVolume(v) {
  shared.volume = v;
  shared.muted = v === 0;
  pushVolume();
}

export function toggleSharedMute() {
  const next = !(shared.muted || shared.volume === 0);
  /* Reactivar desde 0 devolveria el silencio con el icono de sonido. */
  if (!next && shared.volume === 0) shared.volume = 0.8;
  shared.muted = next;
  pushVolume();
}

/* Datos de cada <audio> para quien no es su Player: el mini-reproductor solo
   recibe el elemento (`current`) y de ahi tiene que sacar el titulo, el
   subtitulo y la caja del Player para saber si se ve en pantalla. WeakMap para
   que un Player desmontado no retenga nada. */
export const audioMeta = new WeakMap();
