import { Suspense, lazy, useState } from "react";

/* La pagina apilada de Inicio y de Tu biblioteca va en su propio chunk (Pages.jsx
   y pages.css pesan mas que lo que Inicio necesita para pintarse). Se adelanta
   con la app ociosa (App) y, llegado el chunk, se guarda ya resuelto: abrir una
   pagina no pasa por Suspense ni deja un cuadro en blanco, igual que Descubrir.
   Lo mismo para los menus y hojas de la biblioteca (Overlays.jsx). */
let Ready = null;
export const loadPageHost = () =>
  import("./PageHost.jsx").then((m) => {
    Ready = m.default;
    return m;
  });
export const pageReady = () => Ready !== null;
const Lazy = lazy(loadPageHost);

let ReadyOverlays = null;
export const loadOverlays = () =>
  import("./Overlays.jsx").then((m) => {
    ReadyOverlays = m.default;
    return m;
  });
export const overlaysReady = () => ReadyOverlays !== null;
const LazyOverlaysView = lazy(loadOverlays);

export function LazyOverlays(props) {
  const [View] = useState(() => ReadyOverlays ?? LazyOverlaysView);
  return (
    <Suspense fallback={null}>
      <View {...props} />
    </Suspense>
  );
}

export default function LazyPageHost(props) {
  /* Se elige al montar: cambiar de tipo en medio desmontaria la pagina. */
  const [View] = useState(() => Ready ?? Lazy);
  return (
    <Suspense fallback={null}>
      <View {...props} />
    </Suspense>
  );
}
