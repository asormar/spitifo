/* Version instalada, inyectada en build por vite.config.js (ver `appVersion()`
   ahi: lee desktop/src-tauri/tauri.conf.json, que scripts/set_version.py deja
   al dia en los dos shells antes de este build). El `typeof` deja un valor
   razonable si algo corriera sin pasar por Vite (por ejemplo un script de Node
   suelto). */
export const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";
