import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadAlbumChunk } from "../download/albumChunk.js";
import { loadArtistChunk } from "../download/artistChunk.js";
import { resolveArtistLink } from "../download/artistLink.js";
import { requestSearch } from "../download/searchRequest.js";
import { Icon } from "./icons.jsx";
import { toneVars } from "../shared/cover.js";
import { cx } from "../shared/ui.jsx";
import { usePc } from "../shared/viewport.js";
import "../shared/pinkPlay.css";
import { useNav } from "../app/useNav.js";
import { AlbumCard, Cover, Mosaic, SectionHead, Shelf, coverOf } from "./cards.jsx";
import { detailMeta, detailOf } from "./detail.js";
import { loadAlbumTracklist, mergeAlbumTracks, mostCommonAlbumId } from "./albumTracks.js";
import { mosaicTones, songs } from "./home.js";
import { skeleton } from "./LibraryGate.jsx";
import { albumDeleteCopy } from "./deletion.js";
import { AlbumMenu, DeleteAlbumSheet, ListMenu } from "./Overlays.jsx";
import { deferredDelete } from "./deleteSong.js";
import { Back, useFocusBack } from "./Pages.jsx";
import { NameField } from "./PlaylistPicker.jsx";
import PlaylistSongs from "./PlaylistSongs.jsx";
import MissingRow from "./MissingRow.jsx";
import { Thead } from "./rows.jsx";
import VirtualList from "./VirtualList.jsx";
import { playlists, usePlaylists } from "./playlists.js";
import "../shared/sheet.css";
/* La ficha de Escuchar ya es un chunk perezoso: el top y sus filas se piden
   aparte al pintar, sin meter nada en el chunk de arranque. */
import ArtistPopulares from "../download/ArtistPopulares.jsx";

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
            <>
              Esta lista ya no existe.
              <br />
              <button type="button" className="vf" onClick={() => nav.goTab("home")}>
                Vuelve a Inicio
              </button>
            </>
          ) : (
            <>
              Ya no está en tu biblioteca.
              <br />
              <button type="button" className="vf" onClick={() => nav.goTab("search")}>
                Búscala de nuevo
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

export default memo(function DetailPage({ view, index, byKey, savedById, lists, listsReady, storage, active, ctx }) {
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
    () => detailOf(view, { index, byKey, savedById, lists: ls, listsReady: ready, listsError: failed }),
    [view, index, byKey, savedById, ls, ready, failed]
  );

  /* Solo una ficha de album con id de iTunes pide la lista real. El pedido se
     guarda en albumTracks (una vez por album y sesion) y se comparte: al
     desmontar no se aborta, solo se ignora la respuesta. */
  const tracklistId = d.state === "ok" && d.kind === "album" ? mostCommonAlbumId(d.rows) : null;
  const [tracklist, setTracklist] = useState(null);
  useEffect(() => {
    setTracklist(null);
    if (!tracklistId) return undefined;
    let live = true;
    loadAlbumTracklist(tracklistId).then((data) => {
      if (live) setTracklist(data);
    });
    return () => {
      live = false;
    };
  }, [tracklistId]);
  const merged = useMemo(
    () => (d.state === "ok" && d.kind === "album" ? mergeAlbumTracks(d.rows, tracklist?.tracks) : null),
    [d, tracklist]
  );

  /* El boton de una fila que falta abre la misma ficha que Buscar. El album
     sale de la respuesta de /api/album, con la forma que AlbumSheet espera. */
  const openAlbumSheet = useCallback(
    (anchor) => {
      const a = tracklist?.album;
      const id = String(a?.id ?? tracklistId ?? "");
      if (!a || !id) return;
      loadAlbumChunk();
      nav.open({
        type: "albumsheet",
        id,
        anchor,
        from: "listen",
        album: {
          id,
          title: a.title || (d.state === "ok" ? d.name : ""),
          artist: a.artist,
          year: a.year,
          track_count: a.track_count,
          artwork_url: a.artwork_url,
        },
      });
    },
    [nav.open, tracklist, tracklistId, d]
  );

  /* «Más de <artista>» puede tardar (busca el nombre en iTunes). Mientras
     tanto el boton queda ocupado, y si cambias de ficha o de pestana la
     respuesta vieja se ignora: nunca te arrastra a Buscar sin pedirlo. */
  const [linking, setLinking] = useState(false);
  const linkSeq = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const linkKey = d.state === "ok" ? d.name : "";
  useEffect(
    () => () => {
      linkSeq.current += 1;
      setLinking(false);
    },
    [linkKey]
  );

  /* El id de iTunes para Populares se resuelve con la MISMA funcion de «Más
     de»: id guardado en las canciones o busqueda por nombre. Sin id no hay
     seccion; el resultado se ignora si mientras tanto cambiamos de ficha. */
  const [artistLinkId, setArtistLinkId] = useState(null);
  useEffect(() => {
    if (d.state !== "ok" || d.kind !== "artist") {
      setArtistLinkId(null);
      return undefined;
    }
    let vivo = true;
    resolveArtistLink(d.name, d.rows).then((vista) => {
      if (vivo) setArtistLinkId(vista?.id ?? null);
    });
    return () => {
      vivo = false;
    };
  }, [d.state, d.kind, d.name]);

  if (d.state !== "ok") return <Gone d={d} backRef={backRef} ctx={ctx} nav={nav} pc={pc} />;

  const { kind, name, rows, pl, tone } = d;
  const album = kind === "album";
  const artist = kind === "artist";
  const isList = kind === "list";
  const albumRows = merged?.rows ?? null;
  const noSongs = !rows.length;
  const empty = album ? !albumRows?.length : !rows.length;
  /* Con la lista conocida, la linea de la ficha dice cuantas pistas del disco
     estan en la biblioteca, sin perder los minutos ni el veredicto. */
  const { meta, liner: shownLiner } = detailMeta(d, storage, merged);

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
      <Icon name="DotsThree" size="lg" />
    </button>
  );

  const acts = (
    <div className="dacts">
      <button type="button" className="btn btn--pink" disabled={noSongs} onClick={play}>
        <Icon name="Play" size="md" weight="fill" />
        Reproducir
      </button>
      <button type="button" className="btn btn--ghost" disabled={noSongs} onClick={shuffle}>
        <Icon name="Shuffle" size="md" />
        Aleatorio
      </button>
      {artist && (
        <button
          type="button"
          className="btn btn--ghost"
          onClick={(e) => ctx.openArt(view.id, "artist", name, e.currentTarget)}
        >
          <Icon name="UploadSimple" size="md" />
          Cambiar foto
        </button>
      )}
      {album && (
        <button
          type="button"
          className="btn btn--ghost dacts__more"
          aria-label={`Más opciones de ${name}`}
          title="Más opciones"
          aria-haspopup="menu"
          onClick={(e) => ctx.openMenu(view.id, e.currentTarget, "almenu")}
        >
          <Icon name="DotsThree" size="md" />
        </button>
      )}
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
            <Icon name="DotsThree" size="md" /> de cualquier canción.
          </>
        )
      ) : (
        <>
          No hay canciones.
          <br />
          <button type="button" className="vf" onClick={() => nav.goTab("search")}>
            Añade alguna desde Buscar
          </button>
        </>
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
        ) : album ? (
          /* Las filas que faltan son otro tipo de fila de la misma lista
             virtual; la cola de reproduccion sigue siendo solo `rows`. */
          <VirtualList
            active={active}
            count={albumRows.length}
            getKey={(i) => albumRows[i].key}
            renderRow={(i, enter) => {
              const row = albumRows[i];
              if (row.type === "missing") {
                return (
                  <MissingRow
                    num={row.num}
                    title={row.title}
                    table={pc ? kindOf : undefined}
                    onOpen={openAlbumSheet}
                    prefetch={loadAlbumChunk}
                  />
                );
              }
              return ctx.song(row.entry, rows, {
                enter,
                num: i + 1,
                from,
                table: pc ? kindOf : undefined,
                sub: "",
              });
            }}
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

  /* Borrar un album es como borrar una lista, pero con confirmacion: el menu
     y la hoja son entradas de la pila, asi que atras y Escape los cierran. */
  const stackTop = nav.stack.at(-1);
  const albumMenu = album && stackTop?.type === "almenu" && stackTop.key === view.id && (
    <AlbumMenu
      name={name}
      anchor={stackTop.anchor}
      onClose={nav.back}
      onPick={() => nav.replace({ type: "aldel", key: view.id, anchor: stackTop.anchor })}
      onPhoto={() =>
        ctx.replaceArt(view.id, "album", name, stackTop.anchor, `${d.artist} ${name}`)
      }
    />
  );

  /* Las filas del album son las que agrupa esta pagina. El tamano solo se dice
     si todas las filas lo traen: nunca inventamos un MB. */
  const albumKeys = album ? d.rows.filter((r) => r.downloaded).map((r) => r.key) : [];
  const albumSids = album ? d.rows.filter((r) => r.sid).map((r) => r.sid) : [];
  const albumCount = album ? d.rows.length : 0;
  const albumSize = album && albumKeys.length && d.rows.every((r) => Number.isFinite(r.sizeMb))
    ? d.rows.reduce((sum, r) => sum + r.sizeMb, 0)
    : null;
  const alDel = album && stackTop?.type === "aldel" && stackTop.key === view.id;
  const deleteSheet = alDel && (
    <DeleteAlbumSheet
      copy={albumDeleteCopy({ name, storage, count: albumCount, sizeMb: albumSize })}
      anchor={stackTop.anchor}
      onClose={nav.back}
      onConfirm={() => {
        nav.pop(2);  // cierra la hoja y vuelve de la pagina del album
        deferredDelete({
          files: albumKeys,
          sids: albumSids,
          name,
          notice: `Se quitó «${name}» · ${albumCount} canciones`,
          show: ctx.show,
          hideKeys: ctx.hideKeys,
          restoreFiles: ctx.restoreFiles,
          refreshLibrary: ctx.refreshLibrary,
        });
      }}
    />
  );

  /* «Más de <artista>»: con el id guardado se abre la pagina de iTunes; si no,
     se resuelve por nombre y, sin coincidencia exacta, se cae a una busqueda
     normal en Buscar. El chunk del artista se adelanta al enfocar. */
  const moreArtist = async () => {
    const seq = ++linkSeq.current;
    loadArtistChunk();
    setLinking(true);
    const view = await resolveArtistLink(name, rows);
    if (seq !== linkSeq.current) return;
    setLinking(false);
    if (!activeRef.current) return;
    if (view) nav.goTo("search", view);
    else {
      requestSearch(name);
      nav.goTab("search");
    }
  };

  if (artist) {
    const cover = (
      <Cover tone={tone} label={name} src={coverOf(rows)} target={view.id} size={pc ? 156 : 340} round={pc} />
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
                  <Icon name="Play" size="xl" weight="fill" />
                </button>
              </div>
            </>
          )}
        </header>
        {!pc && <p className="ghead">{meta}</p>}
        {acts}
        <button
          type="button"
          className="btn btn--ghost amore"
          onPointerEnter={loadArtistChunk}
          onFocus={loadArtistChunk}
          onClick={moreArtist}
          disabled={linking}
          aria-busy={linking || undefined}
        >
          Más de {name}
        </button>
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
        {/* Encima de las canciones guardadas, como en Spotify. El boton rosa
            sigue reproduciendo `rows`: lo tuyo, no el top de iTunes. */}
        <ArtistPopulares name={name} artistId={artistLinkId} />
        {tracks}
      </div>
    );
  }

  const art = isList ? (
    <Mosaic tones={mosaicTones(pl.keys, byKey)} className="dcv" />
  ) : (
    <Cover tone={tone} label={name} src={coverOf(rows)} target={view.id} className="dcv" />
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
              <b>{shownLiner[0]}</b>
              <br />
              {shownLiner[1]}
            </p>
          )}
        </div>
        <div className="dmain">
          {tracks}
          {album && !pc && (
            <p className="liner">
              <b>{shownLiner[0]}</b>
              <br />
              {shownLiner[1]}
            </p>
          )}
        </div>
      </div>
      {menu}
      {albumMenu}
      {deleteSheet}
    </div>
  );
});
