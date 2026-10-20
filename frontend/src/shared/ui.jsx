import { useLayoutEffect } from "react";
import { safeUrl } from "./api.js";

/* El unico lugar del componente que abre una URL externa. Si el esquema no
   pasa safeUrl no se renderiza nada: el link desaparece en vez de quedar roto
   o ejecutable. `rel="noopener noreferrer"` en todos: sin noopear, la pagina
   de destino recibe una referencia a `window.opener` y puede navegar esta
   pestana (reverse tabnabbing). */
export function ExtLink({ url, className, children }) {
  const href = safeUrl(url);
  if (!href) return null;
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
export const cx = (...parts) => parts.filter(Boolean).join(" ");
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
/* La pastilla blanca de un segmentado se DESLIZA hasta la opcion activa en
   vez de saltar. Mide el boton activo y publica --ix / --iw en el contenedor;
   el CSS hace el resto con transform. `data-ready` se pone justo despues de
   la primera medida para que la pastilla no vuele desde 0 al montar. El
   ResizeObserver cubre fuentes que cargan tarde, el cambio de ancho del
   contador de "Todos 40" y el responsive. */
export function useSlidingPill(ref, activeKey) {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return undefined;
    const place = () => {
      const on = box.querySelector(".seg.is-on");
      if (!on) {
        box.style.setProperty("--iw", "0px");
        return;
      }
      box.style.setProperty("--ix", `${on.offsetLeft}px`);
      box.style.setProperty("--iw", `${on.offsetWidth}px`);
    };
    place();
    /* Se lee offsetWidth para forzar el calculo de estilo con la posicion ya
       puesta; solo DESPUES se habilita la transicion. Asi el primer colocado
       nunca anima, y no depende de requestAnimationFrame (que no dispara en una
       pestana oculta). */
    void box.offsetWidth;
    box.setAttribute("data-ready", "");
    const ro = new ResizeObserver(place);
    ro.observe(box);
    box.querySelectorAll(".seg").forEach((b) => ro.observe(b));
    return () => ro.disconnect();
  }, [ref, activeKey]);
}
