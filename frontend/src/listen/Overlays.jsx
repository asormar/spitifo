import { useEffect, useRef } from "react";
import Ico from "../shared/ico.jsx";
import Sheet, { Popover } from "../shared/Sheet.jsx";
import { keyUrl } from "../shared/api.js";
import { coverTone } from "../shared/cover.js";
import { cx } from "../shared/ui.jsx";
import { usePc } from "../shared/viewport.js";
import { engine } from "../player/engine.js";
import { VerdictPill } from "../shared/Verdict.jsx";
import { Cover } from "./cards.jsx";
import { checkOf } from "./fileCheck.js";
import FileSheet from "./FileSheet.jsx";
import { albumId, artistId, rowArt } from "./library.js";
import { useSaved } from "./saved.js";
import { deferredDelete } from "./deleteSong.js";
import { menuKinds } from "./songMenu.js";
import { resultOf, savedEntry, tracksFor } from "../player/savedTrack.js";
import { trackSpec } from "../download/albumText.js";
import { queueStore } from "../download/queueStore.js";
import PlaylistPicker from "./PlaylistPicker.jsx";
import "./menus.css";

/* ---------------------------------------------------------------------------
   MENUS Y HOJAS DE LA BIBLIOTECA

   El menu de una cancion (hoja en telefono, popover en escritorio), el menu de
   una lista (popover) y la hoja "Añadir a una lista". Viven en la pila de
   navegacion (entradas menu, lmenu y picker, ver navigation.js): atras, Escape
   y el atras de Android los cierran, y la fila que los abrio ni se entera.
   Van en su propio chunk (pageLoader.jsx) y se adelantan con la app ociosa.

   El menu de una lista lo pinta la pagina de la lista (es la duena de renombrar
   y borrar); aqui solo se dibuja.
   ------------------------------------------------------------------------- */

/* [clave, icono, texto, tono, pastilla]; la clave es lo que recibe `onPick`.
   La ficha lleva la pastilla del archivo, asi que se arma en songItems. */
const SONG_MENU = {
  next: ["next", "next", "Reproducir a continuación"],
  end: ["end", "queue", "Añadir a la cola"],
  list: ["list", "addlist", "Añadir a una lista…"],
  album: ["album", "disc", "Ir al álbum"],
  artist: ["artist", "user", "Ir al artista"],
  download: ["download", "dl", "Descargar"],
  undownload: ["undownload", "nodl", "Quitar descarga"],
  remove: ["remove", "trash", "Quitar de tu biblioteca", "bad"],
};

function songItems(entry, pc) {
  return menuKinds(entry).map((kind) => kind === "file"
    ? ["file", "file", pc ? "Ver la ficha del archivo" : "Ficha del archivo", null, checkOf(entry)]
    : SONG_MENU[kind]);
}

const ALBUM_ITEMS = [
  ["remove", "trash", "Quitar álbum de tu biblioteca", "bad"],
];

const LIST_ITEMS = [
  ["rename", "pen", "Renombrar"],
  ["delete", "trash", "Borrar lista", "bad"],
];

/* El primer item toma el foco al abrir; las flechas recorren el menu en circulo. */
function MenuItems({ items, label, onPick, stack }) {
  const ref = useRef(null);

  const onKeyDown = (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const els = [...ref.current.querySelectorAll("button")];
    const at = els.indexOf(document.activeElement);
    els[(at + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length].focus();
  };

  return (
    <div ref={ref} className="mlist" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {items.map(([kind, icon, text, tone, pill], i) => (
        <button
          key={kind}
          type="button"
          role="menuitem"
          className={cx("mi", tone && `mi--${tone}`)}
          data-autofocus={i === 0 ? "" : undefined}
          onClick={() => onPick(kind)}
        >
          <Ico n={icon} size={22} />
          {pill ? (
            <span className={cx("mi__t", stack && "mi__t--stack")}>
              {text}
              <VerdictPill v={pill} />
            </span>
          ) : (
            text
          )}
        </button>
      ))}
    </div>
  );
}

/* El menu del album lo pinta su pagina, igual que el de una lista. */
export function AlbumMenu({ name, anchor, onClose, onPick }) {
  return (
    <Popover anchor={anchor} onClose={onClose} width={232}>
      <MenuItems items={ALBUM_ITEMS} label={`Opciones de ${name}`} onPick={onPick} />
    </Popover>
  );
}

/* Confirmacion de borrado de un album. Hoja de la app (no window.confirm), con
   el dialogo etiquetado por el titulo y el foco en la accion destructiva. */
export function DeleteAlbumSheet({ copy, anchor, onClose, onConfirm }) {
  return (
    <Sheet title={copy.title} onClose={onClose} anchor={anchor} sm>
      <div className="delsh">
        <div className="sh__bar">
          <h2 className="sh__bt">{copy.title}</h2>
          <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar" onClick={onClose}>
            <Ico n="x" size={18} />
          </button>
        </div>
        <p className="delsh__body">{copy.body}</p>
        <dl className="dfacts delsh__facts">
          {copy.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        <div className="delsh__acts">
          <button type="button" className="btn btn--ghost" data-autofocus onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn btn--bad" onClick={onConfirm}>
            {copy.confirm}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

export function TrackMenu({ entry, anchor, onClose, onPick }) {
  const pc = usePc();
  const { title, artist, album } = entry;
  const label = `Opciones de ${title}`;
  /* Guardada sin archivo: se puede descargar y quitar de la biblioteca. Con
     archivo: quitar descarga, ficha y quitar de la biblioteca. Lo destructivo
     va siempre al final (menuKinds ya lo pone ahi). */
  const items = songItems(entry, pc);
  const head = (
    <div className="mhead">
      <Cover tone={coverTone(artist, album)} label={artist} src={rowArt(entry, keyUrl, true)} size={pc ? 40 : 56} />
      <span className="mhead__x">
        <span className="mhead__t">{title}</span>
        <span className="mhead__s">{pc || !album ? artist : `${artist} · ${album}`}</span>
      </span>
    </div>
  );
  const menu = <MenuItems items={items} label={label} onPick={onPick} stack={pc} />;

  if (pc) {
    return (
      <Popover anchor={anchor} onClose={onClose} width={272}>
        {head}
        {menu}
      </Popover>
    );
  }
  return (
    <Sheet title={label} onClose={onClose} anchor={anchor}>
      {head}
      {menu}
    </Sheet>
  );
}

export function ListMenu({ name, anchor, onClose, onPick }) {
  return (
    <Popover anchor={anchor} onClose={onClose} width={232}>
      <MenuItems items={LIST_ITEMS} label={`Opciones de ${name}`} onPick={onPick} />
    </Popover>
  );
}

/* El menu de una cancion, la hoja de listas o la ficha del archivo de la
   entrada de arriba de la pila. `back` cierra (nav.back), `replace` cambia el
   menu por otra cosa y `goTo` por una pagina (ListenProvider). */
export default function Overlays({ top, byKey, back, replace, goTo, show, storage, hideKeys, restoreFiles, refresh }) {
  const savedById = useSaved((s) => s.byId);
  const entry = byKey.get(top.key) || savedEntry(savedById.get(top.key));

  /* La biblioteca se refresco y la cancion ya no esta: no hay nada que mostrar. */
  useEffect(() => {
    if (!entry) back();
  }, [entry, back]);
  if (!entry) return null;

  if (top.type === "picker") {
    return (
      <PlaylistPicker
        songKey={entry.key}
        title={entry.title}
        byKey={byKey}
        anchor={top.anchor}
        onNotice={show}
        onClose={back}
      />
    );
  }

  if (top.type === "file") {
    return <FileSheet entry={entry} storage={storage} anchor={top.anchor} onClose={back} />;
  }

  const pick = (kind) => {
    if (kind === "download") {
      /* Mi entrada en la cola del servidor: la misma que usa Buscar, con el
         resultado de Buscar que guardamos al anadir la cancion. */
      queueStore.enqueue({ items: [trackSpec(resultOf(entry.song), "")] });
      back();
      show(`Descargando «${entry.title}»`);
      return;
    }
    if (kind === "undownload" || kind === "remove") {
      /* Ocultar la fila al instante y cerrar: con el archivo quitado la guardada
         vuelve como fila de streaming, o desaparece del todo. */
      const hadFile = Boolean(entry.downloaded);
      deferredDelete({
        files: hadFile ? [entry.key] : [],
        sids: kind === "remove" && entry.sid ? [entry.sid] : [],
        name: entry.title,
        notice: kind === "undownload"
          ? `Se quitó la descarga de «${entry.title}»`
          : `Se quitó «${entry.title}»${hadFile ? " y se borró su archivo" : ""}`,
        show,
        hideKeys,
        restoreFiles,
        refreshLibrary: refresh,
      });
      back();
      return;
    }
    if (kind === "file") {
      replace({ type: "file", key: entry.key, anchor: top.anchor });
      return;
    }
    if (kind === "list") {
      replace({ type: "picker", key: entry.key, anchor: top.anchor });
      return;
    }
    if (kind === "album") {
      goTo({ type: "album", id: albumId(entry) });
      return;
    }
    if (kind === "artist") {
      goTo({ type: "artist", id: artistId(entry) });
      return;
    }
    const [track] = tracksFor([entry], byKey, savedById, keyUrl);
    /* Con el motor parado las dos opciones arrancan la cancion: el aviso tiene
       que decir eso y no "a continuacion". */
    const idle = !engine.getState().track;
    const done = kind === "next" ? engine.playNext(track) : engine.enqueue(track);
    back();
    show(
      idle
        ? "Reproduciendo"
        : !done
          ? "Ya está en la cola"
          : kind === "next"
            ? "Sonará a continuación"
            : "Añadida a la cola"
    );
  };

  return <TrackMenu entry={entry} anchor={top.anchor} onClose={back} onPick={pick} />;
}
