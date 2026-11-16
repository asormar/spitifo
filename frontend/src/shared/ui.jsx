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
