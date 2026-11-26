/* ---------------------------------------------------------------------------
   SEGUNDO PLANO: pestaña tapada o pantalla apagada

   Dos señales dicen que no hace falta trabajo en pantalla: la pestaña tapada
   (`visibilitychange`, ya existente) y la pantalla fisica apagada, que en
   Android llega como el evento nativo "spitifo-screen" (ver MainActivity.kt:
   un BroadcastReceiver de ACTION_SCREEN_OFF/ON). document.visibilityState por
   si solo no distingue "tapada" de "pantalla apagada pero esta Activity sigue
   siendo la actual"; en el resto de plataformas ese evento nunca llega y la
   pantalla se asume siempre encendida.

   `<html data-bg>` es la señal unica que el CSS usa para pausar animaciones
   "infinitas" que no dependen de React (ver listen.css, home.css). Nada de
   esto toca el elemento <audio>: la reproduccion sigue igual.
   ------------------------------------------------------------------------- */

let screenOff = false;

const hasDoc = () => typeof document !== "undefined";

export const isScreenOff = () => screenOff;

export const isBackgrounded = () => screenOff || (hasDoc() && document.visibilityState === "hidden");

const sync = () => {
  if (!hasDoc()) return;
  document.documentElement.toggleAttribute("data-bg", isBackgrounded());
};

/* Solo para pruebas: la app nunca la llama. */
export const __setScreenOff = (value) => {
  screenOff = value;
  sync();
};

if (typeof window !== "undefined") {
  window.addEventListener("spitifo-screen", (e) => {
    screenOff = e.detail?.on === false;
    sync();
  });
  document.addEventListener("visibilitychange", sync);
  sync();
}
