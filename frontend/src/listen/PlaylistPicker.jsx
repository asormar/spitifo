import { useEffect, useRef, useState } from "react";
import { playlists, usePlaylists } from "./playlists.js";
import { Icon } from "./icons.jsx";
import "./playlists.css";

/* ---------------------------------------------------------------------------
   AÑADIR A UNA LISTA

   Hoja para elegir a que lista va una cancion. Es la misma desde el menu de una
   fila (Escuchar) y desde "Ahora suena", que la pinta dentro de su capa para
   que quede por encima. En telefono sube desde abajo; desde 720 px es una
   tarjeta centrada.

   No guarda nada propio: elige con playlists.addKeys / playlists.create y
   avisa al que la abrio (`onNotice`) para que lo diga en SU aviso, porque el
   de una pantalla oculta no se ve. Quien la abre devuelve el foco al cerrar.
   ------------------------------------------------------------------------- */

/* Campo de nombre en linea (crear y renombrar). Enter envia y Escape cancela.
   El Escape no sale de aqui: no debe cerrar tambien el detalle ni la vista. */
export function NameField({ value = "", label, submit, onSubmit, onCancel }) {
  const [text, setText] = useState(value);
  const name = text.trim();

  return (
    <form
      className="nfield"
      onSubmit={(e) => {
        e.preventDefault();
        if (name) onSubmit(name);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onCancel();
      }}
    >
      <input
        autoFocus
        value={text}
        maxLength={100}
        aria-label={label}
        placeholder="Nombre de la lista"
        autoComplete="off"
        onFocus={(e) => e.target.select()}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="lbtn lbtn--go" disabled={!name}>
        {submit}
      </button>
      <button type="button" className="lbtn" onClick={onCancel}>
        Cancelar
      </button>
    </form>
  );
}

const plural = (n) => `${n} ${n === 1 ? "canción" : "canciones"}`;

export default function PlaylistPicker({ songKey, title, onClose, onNotice }) {
  const list = usePlaylists((s) => s.list);
  const ready = usePlaylists((s) => s.ready);
  const error = usePlaylists((s) => s.error);
  const errorCode = usePlaylists((s) => s.errorCode);
  const [naming, setNaming] = useState(false);
  const ref = useRef(null);
  const label = `Añadir «${title}» a…`;

  useEffect(() => {
    ref.current.querySelector("button, input")?.focus();
    playlists.load();
  }, []);

  /* En captura y antes que el resto de manejadores de Escape de la pagina
     (cerrar el detalle, o la vista "Ahora suena" entera). El campo de nombre
     lo gestiona solo: cancela el campo, no la hoja. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape" || e.target.closest?.(".nfield")) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  /* El foco no sale de la hoja con Tab. */
  const onKeyDown = (e) => {
    if (e.key !== "Tab") return;
    const items = [...ref.current.querySelectorAll("button:not(:disabled), input")];
    const edge = e.shiftKey ? 0 : items.length - 1;
    if (items.indexOf(document.activeElement) !== edge) return;
    e.preventDefault();
    items[e.shiftKey ? items.length - 1 : 0].focus();
  };

  const done = (text) => {
    onNotice(text);
    onClose();
  };

  const add = (p) =>
    done(playlists.addKeys(p.id, [songKey]) ? `Añadida a «${p.name}»` : `Ya estaba en «${p.name}»`);

  const create = (name) => {
    playlists.create(name, [songKey]);
    done(`Añadida a «${name}»`);
  };

  return (
    <div className="pick" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className="pick__sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={onKeyDown}
      >
        <h2 className="pick__h">{label}</h2>
        {!ready ? (
          <p className="lnote">
            {!error
              ? "Cargando listas…"
              : errorCode === "reconnect_required"
                ? "Tu sesión de Google Drive ha caducado."
                : "No se pudieron cargar las listas."}
            {error && errorCode !== "reconnect_required" && (
              <>
                <br />
                <button type="button" className="vf" onClick={() => playlists.load(true)}>
                  Reintentar
                </button>
              </>
            )}
          </p>
        ) : (
          <>
            <div className="pick__list">
              {list.map((p) => (
                <button key={p.id} type="button" className="pick__it" onClick={() => add(p)}>
                  <span className="pick__n">{p.name}</span>
                  <span className="pick__c">{plural(p.keys.length)}</span>
                </button>
              ))}
            </div>
            {naming ? (
              <NameField
                label="Nombre de la nueva lista"
                submit="Crear"
                onSubmit={create}
                onCancel={() => setNaming(false)}
              />
            ) : (
              <button type="button" className="pick__it pick__new" onClick={() => setNaming(true)}>
                <Icon name="Plus" size={18} />
                Nueva lista
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
