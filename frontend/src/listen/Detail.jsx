import { memo, useMemo, useRef, useState } from "react";
import Ico from "../shared/ico.jsx";
import { Icon } from "../shared/icons.jsx";
import { toneVars } from "../shared/cover.js";
import { cx } from "../shared/ui.jsx";
import { usePc } from "../shared/viewport.js";
import { useNav } from "../app/useNav.js";
import { AlbumCard, Cover, Mosaic, SectionHead, Shelf, coverOf } from "./cards.jsx";
import { detailMeta, detailOf } from "./detail.js";
import { mosaicTones, songs } from "./home.js";
import { skeleton } from "./LibraryGate.jsx";
import { ListMenu } from "./Overlays.jsx";
import { Back, useFocusBack } from "./Pages.jsx";
import { NameField } from "./PlaylistPicker.jsx";
import PlaylistSongs from "./PlaylistSongs.jsx";
import { Thead } from "./rows.jsx";
import VirtualList from "./VirtualList.jsx";
import { playlists, usePlaylists } from "./playlists.js";
import "../shared/sheet.css";

/* ---------------------------------------------------------------------------
   FICHA DE UN ALBUM, UN ARTISTA O UNA LISTA

   Telefono: barra con "Volver" (y los puntos de la lista), portada, titulo,
   acciones y las canciones en una tarjeta. Escritorio: una columna pegajosa con
   lo mismo a la izquierda y la tabla a la derecha; "Volver" lo pone la barra de
   arriba. El artista lleva portada grande (telefono) o un banner (escritorio),
   y sus albumes ENCIMA de las canciones: con cientos de filas virtuales unas
   canciones por encima dejarian los albumes fuera de alcance.

   Lo que hay que saber de cada pagina sale de detail.js (puro). Aqui viven el
   renombrar, el menu de la lista (que es la entrada `lmenu` de la pila), borrar
   y quitar, los dos con "Deshacer".
   ------------------------------------------------------------------------- */

/* Una pagina que no puede pintarse: esperando a las listas, sin ellas o ya sin
   su contenido. */
function Gone({ d, backRef, ctx, nav, pc }) {
  const { state, kind } = d;
  const code = usePlaylists((s) => s.errorCode);
  return (
    <div className="lpage dpage">
      {!pc && (
        <div className="dbar">
          <Back bref={backRef} onClick={ctx.back} className="hback cbtn--soft" />
        </div>
      )}
      {state === "loading" ? (
        <div className="lpanel" aria-busy="true">
          <p className="sr-only">Cargando la lista…</p>
          {skeleton(6)}
        </div>
      ) : (
        <p className="lnote" role={state === "error" ? "alert" : undefined}>
          {state === "error" ? (
            code === "reconnect_required" ? (
              <>
                Tu sesión de Google Drive ha caducado.
                <br />
                <button type="button" className="vf" onClick={() => nav.openSettings("storage")}>
                  Volver a conectar
                </button>
              </>
            ) : (
              <>
                No se pudieron cargar las listas.
                <br />
                <button type="button" className="vf" onClick={() => playlists.load(true)}>
                  Reintentar
                </button>
              </>
            )
          ) : kind === "list" ? (
            "Esta lista ya no existe."
          ) : (
            "Ya no está en tu biblioteca."
          )}
        </p>
      )}
    </div>
  );
}

export default memo(function DetailPage({ view, index, byKey, lists, listsReady, storage, active, ctx }) {
  const nav = useNav();
  const pc = usePc();
  const listsError = usePlaylists((s) => s.error);
  const backRef = useRef(null);
  const moreRef = useRef(null);
  const [naming, setNaming] = useState(false);
  useFocusBack(backRef);

  /* Un album o un artista no dependen de las listas: no se recalcula con cada
     cambio de ellas. */
  const forList = view.type === "list";
  const ls = forList ? lists : null;
  const ready = forList && listsReady;
  const failed = forList && listsError;
  const d = useMemo(
    () => detailOf(view, { index, byKey, lists: ls, listsReady: ready, listsError: failed }),
    [view, index, byKey, ls, ready, failed]
  );
  if (d.state !== "ok") return <Gone d={d} backRef={backRef} ctx={ctx} nav={nav} pc={pc} />;

  const { kind, name, rows, pl, tone } = d;
  const album = kind === "album";
  const artist = kind === "artist";
  const isList = kind === "list";
  const empty = !rows.length;
  const { meta, liner } = detailMeta(d, storage);

  /* Origen de la cola: "Sonando desde" el album, el artista o la lista. */
  const from = `${kind}:${name}`;
  const play = () => ctx.playGroup(rows, false, from);
  const shuffle = () => ctx.playGroup(rows, true, from);

  /* El menu de la lista es lo de arriba de la pila: atras lo cierra. Borrar es
     inmediato y se puede deshacer unos segundos (la lista vuelve con el mismo
     id, nombre y canciones); cierra el menu y la pagina de una vez. */
  const top = isList && nav.stack.at(-1);
  const deleteList = () => {
    playlists.remove(pl.id);
    nav.pop(2);
    ctx.show(`Lista «${pl.name}» borrada`, { label: "Deshacer", run: () => playlists.undoRemove(pl) });
  };

  /* Quitar una cancion se deshace: vuelve a su sitio de antes en la lista. */
  const removeSong = (entry) => {
    const at = pl.keys.indexOf(entry.key);
    if (!playlists.removeKey(pl.id, entry.key)) return;
    ctx.show(`Quitada de «${pl.name}»`, { label: "Deshacer", run: () => playlists.restoreKey(pl.id, entry.key, at) });
  };

  /* En escritorio "Volver" no se ve: el foco vuelve a los puntos. */
  const endNaming = () => {
    setNaming(false);
    requestAnimationFrame(() => moreRef.current?.focus({ preventScroll: true }));
  };

  const more = isList && !naming && (
    <button
      ref={moreRef}
      type="button"
      className="cbtn cbtn--l cbtn--soft"
      aria-label={`Más opciones de ${pl.name}`}
      title="Más opciones"
      aria-haspopup="menu"
      onClick={(e) => ctx.openMenu(pl.id, e.currentTarget, "lmenu")}
    >
      <Ico n="dots" size={22} />
    </button>
  );

  const acts = (
    <div className="dacts">
      <button type="button" className="btn btn--pink" disabled={empty} onClick={play}>
        <Icon name="Play" size={18} weight="fill" />
        Reproducir
      </button>
      <button type="button" className="btn btn--ghost" disabled={empty} onClick={shuffle}>
        <Icon name="Shuffle" size={18} />
        Aleatorio
      </button>
    </div>
  );

  const kindOf = isList ? "lst" : "trk";
  const tracks = empty ? (
    <p className="lnote">
      {isList ? (
        d.gone ? (
          "Ninguna canción de esta lista sigue en tu biblioteca."
        ) : (
          <>
            Esta lista está vacía. Añade canciones desde el menú{" "}
            <Ico n="dots" size={18} /> de cualquier canción.
          </>
        )
      ) : (
        "No hay canciones."
      )}
    </p>
  ) : (
    <>
      {pc && <Thead kind={kindOf} sticky />}
      <div className="tcard">
        {isList ? (
          <PlaylistSongs
            playlist={pl}
            rows={rows}
            active={active}
            ctx={ctx}
            from={from}
            table={pc ? kindOf : undefined}
            onRemove={removeSong}
          />
        ) : (
          <VirtualList
            active={active}
            count={rows.length}
            getKey={(i) => rows[i].key}
            renderRow={(i, enter) =>
              ctx.song(rows[i], rows, {
                enter,
                num: i + 1,
                from,
                table: pc ? kindOf : undefined,
                sub: artist ? rows[i].album || "" : "",
              })
            }
          />
        )}
      </div>
    </>
  );

  const menu = top?.type === "lmenu" && top.key === pl.id && (
    <ListMenu
      name={pl.name}
      anchor={top.anchor}
      onClose={nav.back}
      onPick={(kindPicked) => (kindPicked === "rename" ? (nav.back(), setNaming(true)) : deleteList())}
    />
  );

  if (artist) {
    const cover = (
      <Cover tone={tone} label={name} src={coverOf(rows)} size={pc ? 156 : 340} round={pc} />
    );
    return (
      <div className="lpage dpage dpage--artist">
        <header className="ahero" style={toneVars(tone)}>
          {cover}
          {pc ? (
            <div className="ahero__t">
              <h1>{name}</h1>
              <p>{meta}</p>
            </div>
          ) : (
            <>
              <Back bref={backRef} onClick={ctx.back} className="hback ahero__back" />
              <div className="ahero__in">
                <h1>{name}</h1>
                <button type="button" className="pk" aria-label={`Reproducir ${name}`} disabled={empty} onClick={play}>
                  <Icon name="Play" size={28} weight="fill" />
                </button>
              </div>
            </>
          )}
        </header>
        {!pc && <p className="ghead">{meta}</p>}
        {acts}
        {d.albums.length > 0 && (
          <section className="sec dalb" aria-labelledby="h-dalb">
            <SectionHead id="h-dalb" title="Álbumes" />
            <Shelf grid={pc}>
              {d.albums.map((g) => (
                <AlbumCard key={g.id} g={g} ctx={ctx} sub={songs(g.entries.length)} />
              ))}
            </Shelf>
          </section>
        )}
        {tracks}
      </div>
    );
  }

  const art = isList ? (
    <Mosaic tones={mosaicTones(pl.keys, byKey)} className="dcv" />
  ) : (
    <Cover tone={tone} label={name} src={coverOf(rows)} className="dcv" />
  );

  return (
    <div className="lpage dpage">
      {!pc && (
        <div className="dbar">
          <Back bref={backRef} onClick={ctx.back} className="hback cbtn--soft" />
          {more}
        </div>
      )}
      <div className="dgrid">
        <div className="dside">
          {art}
          <div className="dtrow">
            {naming && isList ? (
              <NameField
                value={pl.name}
                label="Nuevo nombre de la lista"
                submit="Guardar"
                onSubmit={(next) => {
                  playlists.rename(pl.id, next);
                  endNaming();
                }}
                onCancel={endNaming}
              />
            ) : (
              <h1 className="dtl">{name}</h1>
            )}
            {pc && more}
          </div>
          {album && (
            <button
              type="button"
              className="dby"
              aria-label={`Abrir artista ${d.artist}`}
              onClick={() => ctx.open({ type: "artist", id: d.artistId })}
            >
              {d.artist}
            </button>
          )}
          {meta && <p className="dmeta">{meta}</p>}
          {acts}
          {album && pc && (
            <p className="liner">
              <b>{liner[0]}</b>
              <br />
              {liner[1]}
            </p>
          )}
        </div>
        <div className="dmain">
          {tracks}
          {album && !pc && (
            <p className="liner">
              <b>{liner[0]}</b>
              <br />
              {liner[1]}
            </p>
          )}
        </div>
      </div>
      {menu}
    </div>
  );
});
