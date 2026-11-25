import { useEffect, useRef } from "react";
import { Icon } from "./icons.jsx";
import Sheet, { Popover } from "../shared/Sheet.jsx";
import { keyUrl, rowKey } from "../shared/api.js";
import { coverTone } from "../shared/cover.js";
import { cx } from "../shared/ui.jsx";
import { usePc } from "../shared/viewport.js";
import { engine } from "../player/engine.js";
import { Cover } from "./cards.jsx";
import FileSheet from "./FileSheet.jsx";
import { albumId, artistId, rowArt } from "./library.js";
import { useSaved } from "./saved.js";
import { deferredDelete } from "./deleteSong.js";
import { songMenuGroups } from "./songMenu.js";
import { resultOf, savedEntry, tracksFor } from "../player/savedTrack.js";
import { trackSpec } from "../download/albumText.js";
import { queueStore } from "../download/queueStore.js";
import PlaylistPicker from "./PlaylistPicker.jsx";
import ArtSheet from "./ArtSheet.jsx";
import { songTarget } from "./artLogic.js";
import { useNav } from "../app/useNav.js";
import { closePlayer } from "../player/useDock.js";
import { MenuSurface } from "../download/ResultMenu.jsx";
import { goToArtistWhenCurrent, pickResultAction } from "../download/resultMenuActions.js";
import { readDownloadFormat } from "../settings/downloadPrefs.js";
import { npLinks } from "../player/npLinks.js";
import { npMenuGroups } from "../download/npResultGroups.js";
import { loadAlbumChunk } from "../download/albumChunk.js";
import { loadArtistChunk } from "../download/artistChunk.js";
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

/* [clave, icono, texto, tono]; la clave es lo que recibe `onPick`. El menu de
   una cancion ya no esta aqui: songMenu.js da los grupos y MenuBody los pinta. */
const ALBUM_ITEMS = [
  ["photo", "UploadSimple", "Cambiar foto"],
  ["remove", "Trash", "Quitar álbum de tu biblioteca", "bad"],
];

const ARTIST_ITEMS = [
  ["photo", "UploadSimple", "Cambiar foto"],
];

const LIST_ITEMS = [
  ["rename", "PencilSimple", "Renombrar"],
  ["description", "Note", "Editar descripción"],
  ["cover", "Image", "Cambiar portada"],
  ["import", "FileCsv", "Importar canciones"],
  ["delete", "Trash", "Borrar lista", "bad"],
];

/* El primer item toma el foco al abrir; las flechas recorren el menu en circulo.
   Solo lo usan ya los menus de album y de lista, que siguen siendo planos. */
function MenuItems({ items, label, onPick }) {
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
      {items.map(([kind, icon, text, tone], i) => (
        <button
          key={kind}
          type="button"
          role="menuitem"
          className={cx("mi", tone && `mi--${tone}`)}
          data-autofocus={i === 0 ? "" : undefined}
          onClick={() => onPick(kind)}
        >
          <Icon name={icon} size="lg" />
          {text}
        </button>
      ))}
    </div>
  );
}

/* El menu del album lo pinta su pagina, igual que el de una lista. */
export function AlbumMenu({ name, anchor, onClose, onPick, onPhoto }) {
  return (
    <Popover anchor={anchor} onClose={onClose} width={232}>
      <MenuItems
        items={ALBUM_ITEMS}
        label={`Opciones de ${name}`}
        onPick={(kind) => (kind === "photo" ? onPhoto?.() : onPick(kind))}
      />
    </Popover>
  );
}

/* El artista solo necesita «Cambiar foto»: el play va en la fila, no aquí. */
export function ArtistMenu({ name, anchor, onClose, onPhoto }) {
  return (
    <Popover anchor={anchor} onClose={onClose} width={232}>
      <MenuItems items={ARTIST_ITEMS} label={`Opciones de ${name}`}
        onPick={(kind) => (kind === "photo" ? onPhoto?.() : null)} />
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
            <Icon name="X" size="md" />
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

export function TrackMenu({ entry, anchor, onClose, onPick, closePlayer = false }) {
  const pc = usePc();
  const { title, artist, album } = entry;
  /* El estado de la entrada decide que grupos salen y el formato de descarga
     viaja como dato, igual que en el menu de resultados. */
  const groups = songMenuGroups(entry, { fmt: readDownloadFormat(), closePlayer, pc });
  const head = (
    <div className="mhead">
      <Cover tone={coverTone(artist, album)} label={artist} src={rowArt(entry, keyUrl, true)} target={songTarget(entry)} size={pc ? 40 : 56} />
      <span className="mhead__x">
        <span className="mhead__t">{title}</span>
        <span className="mhead__s">{pc || !album ? artist : `${artist} · ${album}`}</span>
      </span>
    </div>
  );
  return (
    <MenuSurface
      groups={groups}
      title={title}
      anchor={anchor}
      onPick={onPick}
      onClose={onClose}
      head={head}
      width={272}
    />
  );
}

export function ListMenu({ name, anchor, onClose, onPick }) {
  return (
    <Popover anchor={anchor} onClose={onClose} width={232}>
      <MenuItems items={LIST_ITEMS} label={`Opciones de ${name}`} onPick={onPick} />
    </Popover>
  );
}

/* Menu ⋯ de "Ahora suena" cuando la pista es un stream que aun no se puede abrir
   como cancion de la biblioteca: los grupos de Buscar y, al final, cerrar el
   reproductor (la misma accion que la X de la pastilla). */
function NpResultMenu({ top, back, show, goTo, replace, locationToken }) {
  const nav = useNav();
  const fmt = readDownloadFormat();
  const groups = npMenuGroups(top.t, { fmt });
  const pick = (kind) => {
    if (kind === "closePlayer") {
      closePlayer();
      return;
    }
    if (kind === "ficha") {
      /* «Ver ficha» sustituye al menu en su entrada: sin popstate, App no
         interpreta el cambio como un cierre y la hoja queda encima de la
         vista, como en el menu de la biblioteca. */
      return pickResultAction(kind, {
        t: top.t,
        nav,
        show,
        anchor: top.anchor,
        closeMenu: false,
        onFicha: (one, anchor) => replace({ type: "ficha", key: rowKey(one), t: one, anchor }),
      });
    }
    if (kind === "album" || kind === "artist") {
      /* «Ir a» abre una pagina: el menu y "Ahora suena" salen en un solo
         unwind y la pagina se abre desde la raiz. No se pide ademas un back:
         dos go() seguidos dejarian otra entrada muerta. «Ver ficha», en
         cambio, sigue abriendose por encima de la vista. */
      return pickResultAction(kind, {
        t: top.t,
        show,
        nav,
        anchor: top.anchor,
        closeMenu: false,
        onAlbum: (t, anchor) => {
          loadAlbumChunk();
          goTo({ ...npLinks({ result: t }, null).album.sheet, anchor });
        },
        onArtist: (t) => {
          const link = npLinks({ result: t }, null).artist;
          if (link?.view) return goTo(link.view);
          const name = link?.name || t.artist;
          /* Sin id hay que buscar el nombre: mientras llega, un atras desmonta
             este menu. El token del padre (no un ref de aqui) dice si seguimos
             en el mismo sitio antes de navegar o de mostrar el aviso. */
          return goToArtistWhenCurrent({
            name,
            entries: [{ artist: name, artist_id: t.extra?.artist_id }],
            resolve: async (who, list) => {
              loadArtistChunk();
              const { resolveArtistLink } = await import("../download/artistLink.js");
              return resolveArtistLink(who, list);
            },
            locationToken,
            onView: (view) => goTo(view),
            onMiss: (who) => show?.(`No se encontró la página de ${who}`),
          });
        },
      });
    }
    return pickResultAction(kind, {
      t: top.t,
      onDownload: (one) => queueStore.enqueue({ items: [{ ...trackSpec(one, ""), fmt }] }),
      show,
      nav,
      anchor: top.anchor,
      locationToken,
    });
  };
  return (
    <MenuSurface
      groups={groups}
      title={top.t?.title || "sin título"}
      anchor={top.anchor}
      onPick={pick}
      onClose={back}
    />
  );
}

/* El menu de una cancion, la hoja de listas o la ficha del archivo de la
   entrada de arriba de la pila. `back` cierra (nav.back), `replace` cambia el
   menu por otra cosa y `goTo` por una pagina (ListenProvider). */
export default function Overlays({ top, byKey, back, replace, goTo, show, locationToken, storage, hideKeys, restoreFiles, refresh }) {
  const savedById = useSaved((s) => s.byId);
  /* La hoja de foto y el menu de un stream suelto no necesitan entrada de la
     biblioteca: en el segundo lo que viaja es el resultado de Buscar. */
  const bare = top.type === "art" || top.type === "npmenu";
  const entry = bare ? null : byKey.get(top.key) || savedEntry(savedById.get(top.key));

  /* La biblioteca se refresco y la cancion ya no esta: no hay nada que mostrar. */
  useEffect(() => {
    if (!entry && !bare) back();
  }, [entry, bare, back]);

  if (top.type === "art") {
    return (
      <ArtSheet
        target={top.target}
        name={top.name}
        query={top.query || top.name}
        kind={top.kind}
        anchor={top.anchor}
        onClose={back}
      />
    );
  }
  if (top.type === "npmenu") return <NpResultMenu top={top} back={back} show={show} goTo={goTo} replace={replace} locationToken={locationToken} />;
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
    if (kind === "closePlayer") {
      closePlayer();
      return;
    }
    if (kind === "photo") {
      /* La hoja sustituye al menu: atras vuelve a la pagina, no al menu. */
      replace({
        type: "art",
        kind: "song",
        target: songTarget(entry),
        name: entry.title,
        query: `${entry.title} ${entry.artist}`,
        anchor: top.anchor,
      });
      return;
    }
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

  return <TrackMenu entry={entry} anchor={top.anchor} onClose={back} onPick={pick} closePlayer={top.closePlayer} />;
}
