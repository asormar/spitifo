import { useRef, useState } from "react";
import { keyUrl } from "../shared/api.js";
import { cx } from "../shared/ui.jsx";
import Sheet from "../shared/Sheet.jsx";
import { Icon } from "./icons.jsx";
import { Mosaic } from "./cards.jsx";
import { playlists } from "./playlists.js";
import { PLAYLIST_FILTERS, ariaSortOf, toggleFilterIn } from "./libraryView.js";
import { importSummary, matchTracks, parseImport } from "./playlistImport.js";
import { songs } from "./home.js";
import "./playlists.css";
import "./libraryTools.css";

/* ---------------------------------------------------------------------------
   HERRAMIENTAS DE BIBLIOTECA Y LISTAS

   Controles y hojas para la fase de biblioteca a escala: vista, carpetas,
   columnas que ordenan, buscador y filtros, selección múltiple, aviso de
   duplicados y asistente de importación. La lógica pura vive en libraryView.js
   y playlistImport.js.
   ------------------------------------------------------------------------- */

export function ViewSwitch({ view, onChange, label = "Vista" }) {
  return (
    <div className="seg lseg" role="group" aria-label={label}>
      <button type="button" className="seg__btn" data-view="list"
        aria-pressed={view === "list"} aria-label="Vista de lista"
        onClick={() => onChange("list")}>
        <Icon name="List" size="sm" />
      </button>
      <button type="button" className="seg__btn" data-view="grid"
        aria-pressed={view === "grid"} aria-label="Vista de cuadrícula"
        onClick={() => onChange("grid")}>
        <Icon name="SquaresFour" size="sm" />
      </button>
    </div>
  );
}

/* Una fila de carpetas antes de la rejilla; «Nueva carpeta» pide el nombre. */
export function FolderRow({ folders, onOpen, onNew }) {
  if (!folders.length && !onNew) return null;
  return (
    <div className="folders" role="group" aria-label="Carpetas">
      {folders.map((f) => (
        <button key={f.id} type="button" className="folder-chip" onClick={() => onOpen(f)}>
          <span className="folder-chip__ic"><Icon name="Folder" weight="fill" size="sm" /></span>
          <span>{f.name}</span>
          <span className="folder-chip__n">· {f.keys.length}</span>
        </button>
      ))}
      {onNew && (
        <button type="button" className="folder-chip folder-chip--new" onClick={onNew}>
          <span className="folder-chip__ic"><Icon name="FolderPlus" size="sm" /></span>
          <span>Nueva carpeta</span>
        </button>
      )}
    </div>
  );
}

const HEAD = {
  trk: [["title", "Título"], ["artist", "Artista"], ["duration", "Duración"]],
  lst: [["title", "Título"], ["artist", "Artista"], ["duration", "Duración"]],
  lib: [["title", "Título"], ["artist", "Artista"], ["album", "Álbum"],
    [null, "Verificación"], ["duration", "Duración"]],
};

/* Cabecera de tabla con botones reales: aria-sort y una flecha que gira. */
export function SortableHead({ kind = "trk", sort, onSort, sticky, bulk, onSelectAll, allSelected }) {
  const cols = HEAD[kind] || HEAD.trk;
  const head = (key, label) => key
    ? (
      <button key={key} type="button" aria-sort={ariaSortOf(sort, key)}
        onClick={() => onSort(key)}>
        {label}
        <Icon name="CaretDown" size="sm" className="thd__caret" />
      </button>
    ) : <span key={label}>{label}</span>;

  return (
    <div className={cx("thd", "thd--sort", sticky && "thd--s", `thd--${kind}`)} role="row">
      {kind === "lst" && <span aria-hidden="true" />}
      {kind !== "lib" && <span className="ra" aria-hidden="true">#</span>}
      {bulk && (
        <span className="thd__check">
          <input type="checkbox" aria-label="Seleccionar todas las canciones"
            checked={Boolean(allSelected)} onChange={(e) => onSelectAll(e.target.checked)} />
        </span>
      )}
      {cols.map(([key, label]) => head(key, label))}
      {kind === "lst" && <><span aria-hidden="true" /><span aria-hidden="true" /></>}
      <span />
    </div>
  );
}

export const SORT_LABELS = {
  custom: "Personalizado", title: "Título", artist: "Artista",
  album: "Álbum", duration: "Duración", added: "Recientes",
};

/* Buscador, chips de filtro y selector de orden dentro de una lista. */
export function PlaylistToolbar({ query, onQuery, filters, onFilter, sort, onSort, canDrag = true }) {
  return (
    <div className="ltools">
      <label className="lsearch">
        <Icon name="MagnifyingGlass" size="sm" />
        <span className="vh">Buscar en esta lista</span>
        <input type="search" value={query} placeholder="Buscar en esta lista"
          autoComplete="off" onChange={(e) => onQuery(e.target.value)} />
      </label>
      <div className="lchips" role="group" aria-label="Filtrar">
        {PLAYLIST_FILTERS.map((id) => {
          const label = id === "downloaded" ? "Descargadas"
            : id === "unverified" ? "Sin verificar" : "Duplicadas";
          return (
            <button key={id} type="button"
              className={cx("chip", filters.includes(id) && "is-on")}
              aria-pressed={filters.includes(id)}
              onClick={() => onFilter(toggleFilterIn(filters, id))}>
              {id === "downloaded" && <Icon name="Funnel" size="sm" />}
              {label}
            </button>
          );
        })}
      </div>
      <label className="lsort">
        <Icon name="SortAscending" size="sm" />
        <span className="vh">Orden</span>
        <select value={sort?.key || "custom"} onChange={(e) => onSort(e.target.value)}>
          <option value="custom">Orden personalizado</option>
          {["title", "artist", "album", "duration", "added"].map((k) => (
            <option key={k} value={k}>{SORT_LABELS[k]}</option>
          ))}
        </select>
      </label>
      {canDrag && !sort?.key && <p className="lhint">Arrastra el asa para reordenar.</p>}
    </div>
  );
}

/* Barra inferior de selección múltiple. */
export function BulkBar({ count, onAdd, onFolder, onRemove, onCancel }) {
  return (
    <div className={cx("bulkbar", count > 0 && "is-shown")} role="toolbar" aria-label="Selección múltiple">
      <span className="bulkbar__count">
        {count === 1 ? "1 seleccionada" : `${count} seleccionadas`}
      </span>
      <div className="bulkbar__acts">
        <button type="button" className="icon-btn" aria-label="Añadir a otra lista"
          disabled={!count} onClick={onAdd}><Icon name="Plus" size="md" /></button>
        <button type="button" className="icon-btn" aria-label="Mover a una carpeta"
          disabled={!count} onClick={onFolder}><Icon name="Folder" size="md" /></button>
        <button type="button" className="icon-btn" aria-label="Quitar de la lista"
          disabled={!count} onClick={onRemove}><Icon name="Trash" size="md" /></button>
        <button type="button" className="icon-btn" aria-label="Cancelar selección"
          onClick={onCancel}><Icon name="X" size="md" /></button>
      </div>
    </div>
  );
}

/* Aviso ANTES de escribir: enseña qué canciones ya estaban y deja elegir. */
export function DuplicateSheet({ name, duplicates, onSkip, onAddAll, onClose }) {
  const titleOf = (d) => d.title || d.name || "";
  return (
    <Sheet title="Canciones duplicadas" onClose={onClose} sm>
      <div className="lwarn"><Icon name="Warning" size="lg" /></div>
      <h2 className="sh__bt">
        {duplicates.length} {duplicates.length === 1 ? "canción ya está" : "canciones ya están"} aquí
      </h2>
      <p className="ltext">
        «{duplicates.slice(0, 3).map(titleOf).join("», «")}»
        {duplicates.length > 3 ? ` y ${duplicates.length - 3} más` : ""}
        {name ? ` ya forman parte de «${name}».` : " ya están en la lista."}
        {" ¿Qué quieres hacer con el resto?"}
      </p>
      <div className="mlist lduplist">
        {duplicates.slice(0, 6).map((d, i) => (
          <div key={`${d.key || i}-${i}`} className="ldup">
            <span className="ldup__t">{titleOf(d)}</span>
            {d.artist && <span className="ldup__s">{d.artist}</span>}
          </div>
        ))}
      </div>
      <div className="lactions">
        <button type="button" className="btn btn--acc" data-autofocus="" onClick={onSkip}>
          Omitir las {duplicates.length} duplicadas
        </button>
        <button type="button" className="btn btn--soft" onClick={onAddAll}>
          Añadir de todas formas
        </button>
      </div>
    </Sheet>
  );
}

/* Elegir a qué lista van las canciones marcadas (o las importadas). */
export function PickListSheet({ title, lists, onPick, onClose, onlyFolders = false }) {
  return (
    <Sheet title={title} onClose={onClose} sm>
      <div className="sh__bar">
        <h2 className="sh__bt">{title}</h2>
        <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar" onClick={onClose}>
          <Icon name="X" size="sm" />
        </button>
      </div>
      <div className="mlist">
        {lists.filter((p) => onlyFolders ? p.is_folder : !p.is_folder).map((p) => (
          <button key={p.id} type="button" className="mi pl" data-autofocus="" onClick={() => onPick(p)}>
            <Mosaic tones={[]} className="mos--pl" />
            <span className="pl__x">
              <span className="pl__n">{p.name}</span>
              <span className="pl__c">{songs(p.keys.length)}</span>
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/* Fila de una pista importada que no está en la biblioteca. */
function MissingImportRow({ track, num, onFind }) {
  return (
    <div className="limportrow limportrow--miss">
      <span className="srow__n" aria-hidden="true">{num}</span>
      <span className="srow__txt">
        <span className="srow__t">{track.title}</span>
        <span className="ldup__s">{track.artist || "Artista desconocido"} · no encontrada</span>
      </span>
      <button type="button" className="findbtn" onClick={() => onFind(track)}>Buscar</button>
    </div>
  );
}

/* Asistente de importación: archivo exportado (CSV) o M3U, sin API. */
export function ImportSheet({ onClose, onImport, entries, onFind }) {
  const [source, setSource] = useState("csv");
  const [tracks, setTracks] = useState([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef(null);
  const { matches, missing } = matchTracks(tracks, entries);
  const summary = importSummary(tracks, matches);

  const choose = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    try {
      const parsed = parseImport(await file.text(), source);
      if (!parsed.length) {
        setError("No encontramos canciones en ese archivo. Comprueba el formato.");
        setTracks([]);
      } else {
        setTracks(parsed);
        setFileName(file.name);
      }
    } catch {
      setError("No se pudo leer el archivo.");
    }
  };

  const accept = () => {
    const keys = [];
    tracks.forEach((_track, i) => {
      const entry = matches.get(i);
      if (entry) keys.push(entry.key);
    });
    onImport(keys, { skipped: missing.length });
  };

  return (
    <Sheet title="Importar lista" onClose={onClose} sm>
      <div className="sh__bar">
        <h2 className="sh__bt">Importar lista</h2>
        <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar" onClick={onClose}>
          <Icon name="X" size="sm" />
        </button>
      </div>
      <div className="srctabs" role="group" aria-label="Origen de la importación">
        <button type="button" className="srctab" aria-pressed={source === "csv"}
          onClick={() => { setSource("csv"); setTracks([]); setError(""); }}>
          <Icon name="FileCsv" size="sm" /> Archivo exportado
        </button>
        <button type="button" className="srctab" aria-pressed={source === "m3u"}
          onClick={() => { setSource("m3u"); setTracks([]); setError(""); }}>
          <Icon name="File" size="sm" /> M3U
        </button>
      </div>
      <p className="ltext">
        {source === "csv"
          ? "Sube el CSV de tu propia cuenta (p. ej. de Exportify). No necesitas claves de Spotify."
          : "Sube un archivo .m3u o .m3u8 con tus canciones."}
      </p>
      <input ref={fileRef} className="vh" type="file"
        accept={source === "csv" ? ".csv,text/csv" : ".m3u,.m3u8,audio/x-mpegurl"}
        onChange={choose} aria-label="Elegir archivo" />
      <button type="button" className="dropzone" onClick={() => fileRef.current?.click()}>
        <Icon name={source === "csv" ? "FileCsv" : "UploadSimple"} size="xl" />
        <b>{fileName || "Elige tu archivo"}</b>
        <span>{source === "csv" ? ".csv" : ".m3u, .m3u8"}</span>
      </button>
      {error && <p className="lerror" role="alert">{error}</p>}
      {tracks.length > 0 && (
        <>
          <div className="matchsum">
            <span className="matchsum__n">{summary.found}<span>/{summary.total}</span></span>
            <p>
              {summary.found} de {summary.total} canciones encontradas en spitifo.
              {summary.missing > 0 && ` ${summary.missing} no aparecen: puedes buscarlas o seguir sin ellas.`}
            </p>
          </div>
          <div className="mlist limportlist">
            {tracks.map((track, i) => {
              const entry = matches.get(i);
              return entry
                ? (
                  <div key={i} className="limportrow">
                    <Icon name="Check" size="sm" className="lok" />
                    <span className="ldup__t">{entry.title}</span>
                    <span className="ldup__s">{entry.artist}</span>
                  </div>
                )
                : <MissingImportRow key={i} track={track} num={i + 1} onFind={onFind} />;
            })}
          </div>
          <button type="button" className="btn btn--acc lwide" data-autofocus=""
            disabled={!summary.found} onClick={accept}>
            Crear lista con {summary.found} {summary.found === 1 ? "canción" : "canciones"}
          </button>
        </>
      )}
    </Sheet>
  );
}

/* Campo de descripción en línea. */
export function DescriptionField({ value, onSubmit, onCancel }) {
  const [text, setValue] = useState(value || "");
  return (
    <form className="ldesc" onSubmit={(e) => { e.preventDefault(); onSubmit(text.trim()); }}>
      <label className="vh" htmlFor="l-desc">Descripción de la lista</label>
      <input id="l-desc" autoFocus value={text} maxLength={500}
        placeholder="Descripción de la lista" autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }} />
      <button type="submit" className="lbtn lbtn--go">Guardar</button>
      <button type="button" className="lbtn" onClick={onCancel}>Cancelar</button>
    </form>
  );
}

/* Portada: se elige entre las de las primeras canciones de la propia lista. */
export function CoverSheet({ sources, onPick, onClose }) {
  return (
    <Sheet title="Elegir portada" onClose={onClose} sm>
      <div className="sh__bar">
        <h2 className="sh__bt">Elegir portada</h2>
        <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar" onClick={onClose}>
          <Icon name="X" size="sm" />
        </button>
      </div>
      <p className="ltext">Usa una portada de tus canciones o deja el mosaico de la lista.</p>
      <div className="lcovers">
        <button type="button" className="lcover" data-autofocus="" onClick={() => onPick("")}>
          <Mosaic tones={[]} /><span>Mosaico</span>
        </button>
        {sources.map((cover) => (
          <button key={cover.src} type="button" className="lcover" onClick={() => onPick(cover.key)}>
            <span className="lcover__img"><img src={cover.src} alt="" /></span>
            <span>Portada</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/* Las portadas que puede elegir el usuario, con su clave de archivo. */
export function coverCandidates(entries) {
  const out = [];
  for (const entry of entries || []) {
    if (entry.thumbKey) out.push({ key: entry.thumbKey, src: keyUrl(entry.thumbKey) });
    else if (entry.artworkUrl) out.push({ key: "", src: entry.artworkUrl });
    if (out.length === 4) break;
  }
  return out;
}
