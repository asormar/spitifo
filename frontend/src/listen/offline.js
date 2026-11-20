/* ---------------------------------------------------------------------------
   ESCUCHAR SIN CONEXION

   Funciones puras: ni React ni window. Con red todo sigue igual; sin red una
   cancion guardada sin archivo no puede sonar.
   ------------------------------------------------------------------------- */

export const OFFLINE_EMPTY =
  "Sin conexión no hay nada descargado para escuchar aquí.";

export const offlineNotice = (entry) =>
  `Sin conexión. «${entry.title}» no está descargada.`;

export const offlineLabel = (entry) =>
  `«${entry.title}» no está descargada: sin conexión no se puede escuchar`;

/* Estado de una fila: se atenua y avisa, pero sigue siendo pulsable para
   poder explicar por que no suena. */
export const rowState = (entry, online) => {
  const blocked = !online && Boolean(entry) && entry.downloaded === false;
  return {
    blocked,
    label: blocked ? offlineLabel(entry) : "",
    notice: blocked ? offlineNotice(entry) : "",
  };
};

/* Entradas que pueden entrar en una cola. Un archivo siempre puede; una
   guardada sin archivo solo con red. */
export const playableEntries = (entries, online) =>
  online ? entries || [] : (entries || []).filter(
    (e) => e && e.downloaded !== false);

/* Diferencia entre "no habia nada" y "habia, pero no se podia escuchar". */
export const allBlocked = (entries, online) =>
  !online && Boolean(entries?.length) &&
  entries.every((e) => e && e.downloaded === false);
