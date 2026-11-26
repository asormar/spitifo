import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { cx } from "../shared/ui.jsx";
import { createDeferred } from "./deferred.js";
import { bindSwipe } from "./swipe.js";

/* ---------------------------------------------------------------------------
   AVISO

   El aviso pasajero de la biblioteca y de "Ahora suena": un texto que se retira
   solo, con un boton opcional (Deshacer). La biblioteca lo pinta una vez en
   ListenProvider, fuera de las pantallas; "Ahora suena" pinta el suyo (el de la
   biblioteca queda debajo de el). Descubrir usa el de la biblioteca a traves de
   `useShow()`: asi el "Ocultado {name}. Deshacer" es el mismo toast y sobrevive
   a salir de Descubrir.

   Cada aviso tiene SU PROPIO temporizador y su propia ranura: uno nuevo nunca
   acorta el deshacer de otro. Se apilan hasta MAX_VISIBLE a la vez (el mas
   nuevo abajo, cerca del pulgar); uno de mas sigue vivo (su `commit` corre
   igual) pero no ocupa pantalla.
   ------------------------------------------------------------------------- */

/* Solo la funcion `show`, estable: quien la usa (Descubrir) no se repinta cada
   vez que cambia la biblioteca o la cola, que es lo que pasaria con
   `useListen()`. */
const NoticeContext = createContext(null);

export const NoticeProvider = NoticeContext.Provider;

export const useShow = () => useContext(NoticeContext);

/* El aviso se retira solo; la salida dura --t-quick (180 ms). Con boton se
   deja mas tiempo: hay que poder leerlo y llegar a el. Un borrado (`commit`)
   tiene mas aun: en el telefono no hay papelera, y TalkBack tarda unos 3 s en
   leer "X borrada. Deshacer, boton" antes de que se pueda reaccionar. */
const NOTICE_MS = 1600;
const ACTION_MS = 5000;
const COMMIT_MS = 8000;
const NOTICE_LEAVE_MS = 180;
const MAX_VISIBLE = 2;

export const noticeWait = (action) =>
  action?.commit ? COMMIT_MS : action ? ACTION_MS : NOTICE_MS;

/* Devuelve [nodo, show]. `show(text, { label, run, commit })`; la accion es
   opcional. `commit` (si la hay) corre al terminar la ventana SIN deshacer: es
   el borrado diferido. Deshacer lo cancela. Cerrar la app no desmonta nada, asi
   que dentro de la ventana no se borra. */
export function useNotice() {
  const [notices, setNotices] = useState([]);
  /* id -> [timeoutOut, timeoutGone]; id -> deferred (solo si tiene commit). */
  const timers = useRef(new Map());
  const deferreds = useRef(new Map());
  const seq = useRef(0);

  const clearNoticeTimers = (id) => {
    (timers.current.get(id) || []).forEach(clearTimeout);
    timers.current.delete(id);
  };

  const remove = useCallback((id) => {
    clearNoticeTimers(id);
    deferreds.current.delete(id);
    setNotices((list) => list.filter((n) => n.id !== id));
  }, []);

  const show = useCallback((text, action) => {
    const id = ++seq.current;
    const wait = noticeWait(action);
    setNotices((list) => [...list, { id, text, action, out: false, wait }]);
    timers.current.set(id, [
      setTimeout(() => setNotices((list) => list.map((n) => (n.id === id ? { ...n, out: true } : n))), wait),
      setTimeout(() => remove(id), wait + NOTICE_LEAVE_MS),
    ]);
    if (action?.commit) {
      const deferred = createDeferred(action.commit);
      deferreds.current.set(id, deferred);
      deferred.start(wait);
    }
  }, [remove]);

  useEffect(() => () => {
    timers.current.forEach((ts) => ts.forEach(clearTimeout));
    deferreds.current.forEach((d) => d.flush());
  }, []);

  const act = (n) => {
    deferreds.current.get(n.id)?.cancel();
    deferreds.current.delete(n.id);
    n.action.run();
    remove(n.id);
  };

  /* Deslizar un aviso es "ya lo vi": su borrado pendiente (si lo hay) sale en
     el acto, no se deshace. Solo afecta a ESE aviso. */
  const dismissBySwipe = (n) => {
    deferreds.current.get(n.id)?.flush();
    deferreds.current.delete(n.id);
    remove(n.id);
  };

  /* Siempre montada: un aria-live solo anuncia lo que cambia dentro de una
     region que ya existia. Solo se pintan los MAX_VISIBLE mas nuevos; los
     demas (si los hay) siguen vivos, con su `commit` corriendo igual. */
  const visible = notices.slice(-MAX_VISIBLE);
  const node = (
    <div className="lnotice" aria-live="polite">
      {visible.map((n) => (
        <NoticeToast key={n.id} n={n} onAct={() => act(n)} onSwipeDismiss={() => dismissBySwipe(n)} />
      ))}
    </div>
  );
  return [node, show];
}

/* Un toast de la pila: su propio nodo para que el swipe y el autoFocus del
   boton (al MONTAR, no al repintar) sean por aviso, no globales. */
function NoticeToast({ n, onAct, onSwipeDismiss }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    return bindSwipe(el, onSwipeDismiss);
  }, [onSwipeDismiss]);

  return (
    <span ref={ref} className={cx("ltoast", n.out && "is-out")} style={{ "--dismiss": `${n.wait}ms` }}>
      {n.text}
      {n.action && (
        <button type="button" className="ltoast__act" autoFocus onClick={onAct}>
          {n.action.label}
        </button>
      )}
      {/* La barra muestra el tiempo real que queda: nunca se reinicia por otro
          aviso, porque --dismiss es de ESTE. */}
      {n.action?.commit && <span className="ltoast__bar" aria-hidden="true" />}
    </span>
  );
}
