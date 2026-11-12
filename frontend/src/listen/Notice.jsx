import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { cx } from "../shared/ui.jsx";

/* ---------------------------------------------------------------------------
   AVISO

   El aviso pasajero de la biblioteca y de "Ahora suena": un texto que se retira
   solo, con un boton opcional (Deshacer). La biblioteca lo pinta una vez en
   ListenProvider, fuera de las pantallas; "Ahora suena" pinta el suyo (el de la
   biblioteca queda debajo de el). Descubrir usa el de la biblioteca a traves de
   `useShow()`: asi el "Ocultado {name}. Deshacer" es el mismo toast y sobrevive
   a salir de Descubrir.
   ------------------------------------------------------------------------- */

/* Solo la funcion `show`, estable: quien la usa (Descubrir) no se repinta cada
   vez que cambia la biblioteca o la cola, que es lo que pasaria con
   `useListen()`. */
const NoticeContext = createContext(null);

export const NoticeProvider = NoticeContext.Provider;

export const useShow = () => useContext(NoticeContext);

/* El aviso se retira solo; la salida dura --t-quick (180 ms). Con boton se
   deja mas tiempo: hay que poder leerlo y llegar a el. */
const NOTICE_MS = 1600;
const ACTION_MS = 5000;
const NOTICE_LEAVE_MS = 180;

/* Devuelve [nodo, show]. `show(text, { label, run })`; la accion es opcional. */
export function useNotice() {
  const [notice, setNotice] = useState(null);
  const timers = useRef([]);

  const show = useCallback((text, action) => {
    timers.current.forEach(clearTimeout);
    const wait = action ? ACTION_MS : NOTICE_MS;
    setNotice({ text, action, out: false, id: Date.now() });
    timers.current = [
      setTimeout(() => setNotice((n) => n && { ...n, out: true }), wait),
      setTimeout(() => setNotice(null), wait + NOTICE_LEAVE_MS),
    ];
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const act = () => {
    notice.action.run();
    timers.current.forEach(clearTimeout);
    setNotice(null);
  };

  /* Siempre montada: un aria-live solo anuncia lo que cambia dentro de una
     region que ya existia. El boton recibe el foco al aparecer: si no, quien
     usa teclado tendria que recorrer toda la pagina para llegar a el. */
  const node = (
    <div className="lnotice" aria-live="polite">
      {notice && (
        <span key={notice.id} className={cx("ltoast", notice.out && "is-out")}>
          {notice.text}
          {notice.action && (
            <button type="button" className="ltoast__act" autoFocus onClick={act}>
              {notice.action.label}
            </button>
          )}
        </span>
      )}
    </div>
  );
  return [node, show];
}
