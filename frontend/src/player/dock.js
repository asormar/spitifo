/* Cuando se ve el reproductor flotante (la pastilla del telefono o la barra
   del escritorio): hay una pista, "Ahora suena" y el video estan cerrados y el
   usuario no la cerro con la X. Pura: la regla vive aqui y no en el JSX. */
export const dockVisible = ({ track, npOpen, vhostMode, dismissed }) =>
  Boolean(track) && !npOpen && vhostMode === "closed" && !dismissed;
