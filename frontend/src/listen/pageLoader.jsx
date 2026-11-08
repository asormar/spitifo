import { Suspense, lazy, useState } from "react";

/* La pagina apilada de Inicio y de Tu biblioteca va en su propio chunk (Pages.jsx
   y pages.css pesan mas que lo que Inicio necesita para pintarse). Se adelanta
   con la app ociosa (App) y, llegado el chunk, se guarda ya resuelto: abrir una
   pagina no pasa por Suspense ni deja un cuadro en blanco, igual que Descubrir. */
let Ready = null;
export const loadPageHost = () =>
  import("./PageHost.jsx").then((m) => {
    Ready = m.default;
    return m;
  });
export const pageReady = () => Ready !== null;
const Lazy = lazy(loadPageHost);

export default function LazyPageHost(props) {
  /* Se elige al montar: cambiar de tipo en medio desmontaria la pagina. */
  const [View] = useState(() => Ready ?? Lazy);
  return (
    <Suspense fallback={null}>
      <View {...props} />
    </Suspense>
  );
}
