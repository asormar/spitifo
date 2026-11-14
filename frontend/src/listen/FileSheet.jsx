import Ico from "../shared/ico.jsx";
import Sheet from "../shared/Sheet.jsx";
import { VerdictPill } from "../shared/Verdict.jsx";
import { keyUrl } from "../shared/api.js";
import { coverTone } from "../shared/cover.js";
import { fileFacts } from "../player/nowInfo.js";
import { Cover } from "./cards.jsx";
import { filePill } from "./fileCheck.js";
import { checkText } from "./fileText.js";
import { rowArt } from "./library.js";

/* ---------------------------------------------------------------------------
   FICHA DEL ARCHIVO (hoja del menu de una cancion)

   Lo que se sabe de un archivo de la biblioteca: su veredicto y de donde sale
   cada dato. Sin enlaces ni acciones. Sin registro guardado (un archivo
   anterior), «Sin verificar» y solo lo que dice el propio archivo. Es una hoja
   en el telefono y una tarjeta centrada desde 960 px (shared/Sheet.jsx).
   ------------------------------------------------------------------------- */

export default function FileSheet({ entry, storage, anchor, onClose }) {
  const v = filePill(entry);
  const rows = fileFacts(entry, { storage, sheet: true });
  const sub = entry.album ? `${entry.artist} · ${entry.album}` : entry.artist;

  return (
    <Sheet title={`Ficha de ${entry.title}`} onClose={onClose} anchor={anchor}>
      <div className="mhead fsheet__h">
        <Cover tone={coverTone(entry.artist, entry.album)} label={entry.artist} src={rowArt(entry, keyUrl)} size={56} />
        <span className="mhead__x">
          <span className="mhead__t">{entry.title}</span>
          <span className="mhead__s">{sub}</span>
        </span>
        <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar" title="Cerrar" onClick={onClose}>
          <Ico n="x" size={18} />
        </button>
      </div>
      <div className="fsheet__b">
        <div className="fvcard">
          <VerdictPill v={v} />
          <p>{checkText(entry)}</p>
        </div>
        <dl className="dfacts ffacts">
          {rows.map((r) => (
            <div key={r.k}>
              <dt>{r.k}</dt>
              <dd className={r.mono ? "is-mono" : undefined}>{r.v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Sheet>
  );
}
