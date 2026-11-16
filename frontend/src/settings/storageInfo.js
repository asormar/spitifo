/* ---------------------------------------------------------------------------
   LO QUE Ajustes CALCULA SIN PINTAR

   Las tres secciones de Ajustes tenian esta logica dentro del componente, donde
   no se puede probar sin DOM: el tamano en GB, la barra de cuota, el texto del
   error de conexion, el subtitulo de Drive y el estado de las cookies. Vive
   aqui, sin React y sin red; los componentes solo la llaman.
   ------------------------------------------------------------------------- */

/* Por debajo de 1 GB va en MB: una biblioteca recien empezada en "0 GB" parece
   vacia aunque ya tenga temas. */
export function fmtGB(bytes) {
  const gb = bytes / 1024 ** 3;
  if (gb < 1) {
    const mb = bytes / 1024 ** 2;
    return `${mb.toLocaleString("es-ES", { maximumFractionDigits: mb < 10 ? 1 : 0 })} MB`;
  }
  return `${gb.toLocaleString("es-ES", { maximumFractionDigits: gb < 100 ? 1 : 0 })} GB`;
}

/* La barra de espacio de Drive. `null` = todavia no se sabe (no se pinta nada).
   Los anchos se recortan al 100 %: un uso mayor que el limite no debe desbordar
   la barra. `others` nunca es negativo (el backend puede redondear). */
export function quotaView(quota) {
  if (!quota) return null;
  const { limit, usage, app } = quota;
  const others = Math.max(0, usage - app);
  if (!limit) return { unlimited: true, legend: `Espacio sin límite · Spitifo ocupa ${fmtGB(app)}` };
  const free = Math.max(0, limit - usage);
  const pct = (n) => `${Math.min(100, (n / limit) * 100)}%`;
  return {
    unlimited: false,
    app: pct(app),
    others: pct(others),
    legend: [
      `Spitifo ${fmtGB(app)}`,
      `Otros ${fmtGB(others)}`,
      `Libre ${fmtGB(free)}`,
    ],
    aria: `Spitifo ${fmtGB(app)}, otros archivos ${fmtGB(others)}, libres ${fmtGB(free)} de ${fmtGB(limit)}`,
  };
}

/* Los mensajes del flujo de Google vienen del backend en ingles y estables: se
   traducen aca para no mostrar texto crudo. */
export function connectErrorText(error) {
  if (!error) return null;
  if (/cancel/i.test(error)) return "Cancelaste el inicio de sesión.";
  if (/timed out/i.test(error)) return "El navegador tardó demasiado. Vuelve a intentarlo.";
  return "No se pudo conectar con Google Drive. Vuelve a intentarlo.";
}

/* El subtitulo de la tarjeta de Drive. `pending` = el sign-in esta esperando;
   `viaAndroid` = lo lleva el shell nativo, no el navegador. `state` dice si el
   texto lleva spinner, punto verde o nada: el componente solo elige el nodo. */
export function driveSub(info, { pending = false, viaAndroid = false } = {}) {
  if (!info) return { text: " ", state: null };
  const google = info.providers?.find((p) => p.id === "google");
  if (!google?.configured) return { text: "No disponible en esta versión", state: null };
  if (pending)
    return { text: viaAndroid ? "Esperando a Google…" : "Esperando al navegador…", state: "pending" };
  if (google.connected) return { text: "Conectada", state: "connected" };
  return { text: "Conecta tu cuenta", state: null };
}

/* El estado de las cookies de YouTube. `fmtDate` entra por parametro para que la
   prueba no dependa del reloj ni del locale del que corre. */
export function cookieStatus(info, fmtDate) {
  if (!info) return "Comprobando…";
  if (!info.configured) return "Sin configurar";
  const fecha = fmtDate(info.imported_at);
  const n = info.count;
  return `Configuradas · ${n} ${n === 1 ? "cookie" : "cookies"}${fecha ? ` · ${fecha}` : ""}`;
}
