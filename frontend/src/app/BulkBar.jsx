import { useState } from "react";
import { keyUrl } from "../shared/api.js";
import { Icon } from "../shared/icons.jsx";
import Sheet, { SheetBar } from "../shared/Sheet.jsx";
import { engine } from "../player/engine.js";
import { tracksFor } from "../player/savedTrack.js";
import { playlists, usePlaylists } from "../listen/playlists.js";
import { useListen } from "../listen/ListenProvider.jsx";
import { selection, useSelection } from "./selection.js";

/* ---------------------------------------------------------------------------
   BARRA DE ACCIONES MASIVA

   Aparece cuando hay filas seleccionadas con Ctrl/Shift+clic. Las tres acciones
   son las del menu de una cancion pero sobre toda la seleccion: encolar, meter
   en una lista y quitar de la biblioteca.
   ------------------------------------------------------------------------- */

function PlaylistPicker({ onClose, onPick }) {
  const list = usePlaylists((s) => s.list);
  return (
    <Sheet title="Añadir a una lista" onClose={onClose}>
      <SheetBar title="Añadir a una lista" onClose={onClose} />
      <div className="bulk__picker">
        {list.length ? (
          list.map((p) => (
            <button key={p.id} type="button" className="bulk__pl" onClick={() => onPick(p)}>
              {p.name}
            </button>
          ))
        ) : (
          <p className="bulk__empty">Todavía no tienes listas.</p>
        )}
      </div>
    </Sheet>
  );
}

export default function BulkBar() {
  const picked = useSelection();
  const { ctx, model } = useListen();
  const [picking, setPicking] = useState(false);
  if (!picked.length) return null;

  const keys = picked.map((e) => e.key);
  const note = `${picked.length} ${picked.length === 1 ? "seleccionada" : "seleccionadas"}`;
  const done = (msg) => {
    ctx.show?.(msg);
    selection.clear();
  };

  return (
    <>
      <div className="bulkbar" role="toolbar" aria-label="Acciones sobre la selección">
        <b>{note}</b>
        <button
          type="button"
          className="bulkbar__btn"
          onClick={() => {
            const tracks = tracksFor(picked, model.byKey, model.savedById, keyUrl);
            tracks.forEach((t) => engine.enqueue(t));
            done(tracks.length ? `Añadidas ${tracks.length} a la cola` : "No se pudo añadir a la cola");
          }}
        >
          <Icon name="Queue" size="sm" /> Añadir a cola
        </button>
        <button type="button" className="bulkbar__btn" onClick={() => setPicking(true)}>
          <Icon name="Plus" size="sm" /> Añadir a playlist
        </button>
        <button
          type="button"
          className="bulkbar__btn bulkbar__btn--danger"
          onClick={() => {
            ctx.hideKeys?.(keys);
            done(`Quitadas ${picked.length} de tu biblioteca`);
          }}
        >
          <Icon name="X" size="sm" /> Quitar
        </button>
        <button type="button" className="bulkbar__btn bulkbar__btn--close" aria-label="Limpiar selección" onClick={selection.clear}>
          <Icon name="X" size="sm" />
        </button>
      </div>
      {picking && (
        <PlaylistPicker
          onClose={() => setPicking(false)}
          onPick={(p) => {
            playlists.addKeys(p.id, keys);
            setPicking(false);
            done(`Añadidas a ${p.name}`);
          }}
        />
      )}
    </>
  );
}
