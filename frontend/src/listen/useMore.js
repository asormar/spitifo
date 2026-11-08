import { useEffect, useRef, useState } from "react";

/* Rejilla progresiva: pinta `STEP` tarjetas y, al acercarse el centinela al
   borde de la pantalla, otras tantas. Devuelve cuantas pintar y la ref del
   centinela (null cuando ya estan todas). Un cambio de lista se resuelve con
   una `key` en quien la usa. */
const STEP = 60;

export function useMore(total) {
  const [n, setN] = useState(STEP);
  const more = n < total;
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!more || !el) return undefined;
    const io = new IntersectionObserver((hit) => hit[0].isIntersecting && setN(n + STEP), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, n]);

  return [Math.min(n, total), more ? ref : null];
}
