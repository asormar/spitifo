import { useEffect, useRef, useState } from "react";
import { NavIcon } from "../app/navIcons.jsx";
import Ico from "../shared/ico.jsx";
import Sheet from "../shared/Sheet.jsx";
import { Mosaic } from "./cards.jsx";
import { mosaicTones } from "./home.js";
import { playlists, usePlaylists } from "./playlists.js";
import "./playlists.css";

/* ---------------------------------------------------------------------------
   AÑADIR A UNA LISTA

   Hoja para elegir a que lista va una cancion (shared/Sheet.jsx: sube desde
   abajo en telefono; desde 960 px, tarjeta centrada de 400). La misma desde el
   menu de una fila (la biblioteca, donde vive en la pila de navegacion y la
   cierra nav.back) y desde "Ahora suena", que la abre con su propio estado y,
   fuera del proveedor de la biblioteca, sin `byKey`: sus listas llevan el
   mosaico neutro.

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

function Row({ p, byKey, onPick }) {
  const tones = byKey ? mosaicTones(p.keys, byKey) : [];
  return (
    <button type="button" className="mi pl" onClick={() => onPick(p)}>
      <Mosaic tones={tones} className="mos--pl" />
      <span className="pl__x">
        <span className="pl__n">{p.name}</span>
        <span className="pl__c">{plural(p.keys.length)}</span>
      </span>
    </button>
  );
}

export default function PlaylistPicker({ songKey, title, onClose, onNotice, anchor, byKey }) {
  const list = usePlaylists((s) => s.list);
  const ready = usePlaylists((s) => s.ready);
  const error = usePlaylists((s) => s.error);
  const errorCode = usePlaylists((s) => s.errorCode);
  const [naming, setNaming] = useState(false);
  const newRef = useRef(null);
  const label = `Añadir «${title}» a…`;

  useEffect(() => {
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
    <Sheet title={label} onClose={onClose} anchor={anchor} sm>
      <div className="sh__bar">
        <h2 className="sh__bt">{label}</h2>
        <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar" onClick={onClose}>
          <Ico n="x" size={18} />
        </button>
      </div>
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
              <button type="button" className="vf" data-autofocus="" onClick={() => playlists.load(true)}>
                Reintentar
              </button>
            </>
          )}
        </p>
      ) : (
        <div className="mlist">
          <button ref={newRef} type="button" className="mi" data-autofocus="" onClick={() => setNaming(true)}>
            <NavIcon name="plus" size={22} />
            Nueva lista
          </button>
          {naming && (
            <NameField
              label="Nombre de la nueva lista"
              submit="Crear"
              onSubmit={create}
              onCancel={() => {
                setNaming(false);
                requestAnimationFrame(() => newRef.current?.focus({ preventScroll: true }));
              }}
            />
          )}
          {list.map((p) => (
            <Row key={p.id} p={p} byKey={byKey} onPick={add} />
          ))}
        </div>
      )}
    </Sheet>
  );
}
