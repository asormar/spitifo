import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import DetailHero from "./DetailHero.jsx";
import { loadAlbumChunk } from "../download/albumChunk.js";
import { loadArtistChunk } from "../download/artistChunk.js";
import { resolveArtistLink } from "../download/artistLink.js";
import { requestSearch } from "../download/searchRequest.js";
import { Icon } from "./icons.jsx";
import { cx } from "../shared/ui.jsx";
import { usePc } from "../shared/viewport.js";
import "../shared/pinkPlay.css";
import { useNav } from "../app/useNav.js";
import { keyUrl } from "../shared/api.js";
import { crossGo } from "../app/crossMode.js";
import { artistView, relatedArtists } from "./entityLinks.js";
import { useReco } from "../discover/reco.js";
import { absoluteUrl, shareLink } from "../app/share.js";
import { AlbumCard, Cover, ListCard, Mosaic, SectionHead, Shelf, coverOf } from "./cards.jsx";
import { detailMeta, detailOf } from "./detail.js";
import { loadAlbumTracklist, mergeAlbumTracks, mostCommonAlbumId } from "./albumTracks.js";
import { mosaicTones, songs } from "./home.js";
import { skeleton } from "./LibraryGate.jsx";
import { albumDeleteCopy } from "./deletion.js";
import { AlbumMenu, DeleteAlbumSheet, ListMenu } from "./Overlays.jsx";
import { deferredDelete } from "./deleteSong.js";
import { Back, useFocusBack } from "./Pages.jsx";
import { NameField } from "./PlaylistPicker.jsx";
import { ArtistMenu } from "./Overlays.jsx";
import { BulkBar, CoverSheet, DescriptionField, DuplicateSheet, ImportSheet, PickListSheet, PlaylistToolbar, SortableHead, coverCandidates } from "./PlaylistTools.jsx";
import { cycleSort, filterRows, membersOf, mosaicSources, sortRows } from "./libraryView.js";
import { duplicatesIn } from "./playlists.js";
import PlaylistSongs from "./PlaylistSongs.jsx";
import MissingRow from "./MissingRow.jsx";
import VirtualList from "./VirtualList.jsx";
import { playlists, usePlaylists } from "./playlists.js";
import { queueStore } from "../download/queueStore.js";
import { trackSpec } from "../download/albumText.js";
import { resultOf } from "../player/savedTrack.js";
import { formatForQuality, readDownloadQuality } from "../settings/downloadPrefs.js";
import "../shared/sheet.css";
import "./libraryTools.css";
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
          <Back bref={backRef} onClick={ctx.back} label={ctx.backLabel?.()} className="hback cbtn--soft" />
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
  /* Herramientas de la ficha: la barra se pega al bajar, la tabla ordena,
     la lista se busca y se filtra, y se pueden marcar canciones en bloque. */
  const [scrolled, setScrolled] = useState(false);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState([]);
  const [sort, setSort] = useState(null);
  const [picked, setPicked] = useState([]);
  const [sheet, setSheet] = useState(null);
  const [dup, setDup] = useState(null);
  const [descEdit, setDescEdit] = useState(false);
  const listRef = useRef(null);

  useEffect(() => {
    setQuery("");
    setFilters([]);
    setSort(null);
    setPicked([]);
    setSheet(null);
    setDup(null);
    setDescEdit(false);
    setScrolled(false);
  }, [view.id]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 160);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
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
     seccion; el resultado se ignora si mientras tanto cambiamos de ficha. La
     promesa se guarda en un ref para que «Más de» la reuse en vez de pedir lo
     mismo otra vez: una sola llamada a /api/artists/search por artista y
     visita, aunque se pulse el boton antes de que esta termine. */
  const linkPromiseRef = useRef(null);
  const [artistLinkId, setArtistLinkId] = useState(null);
  /* Artistas similares: se usan los datos que Descubrir ya dejo en el
     dispositivo. La vista es estable (el selector devuelve la foto entera). */
  const recoArtists = useReco((s) => s.artists);
  const similar = useMemo(() => relatedArtists(name, recoArtists, 6), [name, recoArtists]);
  useEffect(() => {
    if (d.state !== "ok" || d.kind !== "artist") {
      linkPromiseRef.current = null;
      setArtistLinkId(null);
      return undefined;
    }
    let vivo = true;
    const promise = resolveArtistLink(d.name, d.rows);
    linkPromiseRef.current = promise;
    promise.then((vista) => {
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
  const play = () => ctx.playGroup(shownRows.length ? shownRows : rows, false, from);
  const shuffle = () => ctx.playGroup(shownRows.length ? shownRows : rows, true, from);

  /* Buscar, filtrar y ordenar dentro de la pagina. El orden personalizado no
     ordena: deja las filas como las puso el usuario con el arrastre. */
  const shownRows = useMemo(() => {
    const base = album ? (albumRows || rows) : rows;
    const filtered = isList ? filterRows(base, { query, filters }) : base;
    return sortRows(filtered, sort);
  }, [album, albumRows, rows, isList, query, filters, sort]);
  const onSortColumn = (key) => setSort((cur) => cycleSort(cur, key));
  const onSortMenu = (key) => setSort(key === "custom"
    ? null
    : { key, dir: 1 });

  /* Selección múltiple: una sola escritura con el keys final. */
  const selectedKeys = picked.filter((k) => pl?.keys.includes(k));
  const togglePick = (key, on) =>
    setPicked((cur) => (on ? [...new Set([...cur, key])] : cur.filter((k) => k !== key)));
  const selectAll = (on) => setPicked(on ? shownRows.map((e) => e.key) : []);
  const selectFor = (entry) => picked.length
    ? { checked: picked.includes(entry.key), onChange: (on) => togglePick(entry.key, on) }
    : undefined;

  /* Un aviso ANTES de escribir cuando algo ya estaba en la lista de destino. */
  const writeWithDuplicates = (target, keys, apply, message) => {
    const dups = duplicatesIn(target, keys);
    if (!dups.length) {
      apply(keys.filter((k) => !duplicatesIn(target, [k]).length));
      ctx.show(message);
      return;
    }
    setDup({
      duplicates: keys.filter((k) => dups.includes(k))
        .map((k) => shownRows.find((e) => e.key === k) || { key: k, title: k }),
      name: target?.name,
      onSkip: () => {
        apply(keys.filter((k) => !dups.includes(k)));
        setDup(null);
        ctx.show(message);
      },
      onAddAll: () => {
        apply(keys);
        setDup(null);
        ctx.show(message);
      },
      });
    };

  /* Un tap baja TODA la lista que todavia no tenes, como un solo grupo. Las
     filas con `song` son las que no tienen archivo propio. */
  const downloadList = () => {
    const fmt = formatForQuality(readDownloadQuality());
    const items = rows.filter((r) => r.song && !r.song.file_key).map((r) => {
      const s = r.song;
      return trackSpec(resultOf(s), `${s.title || ""} ${s.artist || ""}`.trim(), fmt);
    });
    if (!items.length) {
      ctx.show("Todas las canciones de esta lista ya están descargadas");
      return;
    }
    queueStore.enqueue({
      items,
      group: { id: `playlist:${pl.id}`, title: pl.name, artwork_url: null },
    });
  };

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

  /* «Compartir» de album y lista: la direccion de la pagina ya es canonica. */
  const sharePage = () => {
    const url = absoluteUrl(window.location.href, window.location.search);
    shareLink({ title: name, url }).then((done) => {
      if (done === "copied") ctx.show("Enlace copiado");
    });
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
      {isList && (
        <button type="button" className="btn btn--ghost" disabled={noSongs} onClick={downloadList}>
          <Icon name="DownloadSimple" size="md" />
          Descargar lista
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
      {/* U9: un solo play y «Cambiar foto» en el menú, no en la fila de acciones. */}
      {artist && (
        <button
          type="button"
          className="btn btn--ghost dacts__more"
          aria-label={`Más opciones de ${name}`}
          title="Más opciones"
          aria-haspopup="menu"
          onClick={(e) => ctx.openMenu(view.id, e.currentTarget, "artmenu")}
        >
          <Icon name="DotsThree" size="md" />
        </button>
      )}
    </div>
  );

  const kindOf = isList ? "lst" : "trk";
  const folderMembers = isList && pl.is_folder ? membersOf(lists, pl) : [];
  const searchSongs = () => nav.goTab("search");
  const tracks = isList && (
    <PlaylistToolbar
      query={query} onQuery={setQuery}
      filters={filters} onFilter={setFilters}
      sort={sort} onSort={onSortMenu}
      canDrag={!empty}
    />
  );
  const bulkRemove = () => {
    const before = [...pl.keys];
    const n = playlists.removeKeys(pl.id, selectedKeys);
    setPicked([]);
    if (n) ctx.show(`${n} ${n === 1 ? "canción quitada" : "canciones quitadas"}`, {
      label: "Deshacer", run: () => playlists.replaceKeys(pl.id, before),
    });
  };

  const body = empty ? (
    <div className="lnote">
      <p>
        {isList ? (
          d.gone
            ? "Ninguna canción de esta lista sigue en tu biblioteca."
            : "Esta lista está vacía. Añade canciones desde el menú ⋯ de cualquier canción, o búscalas ahora mismo."
        ) : "No hay canciones."}
      </p>
      {/* U11: el texto explica y ademas ofrece una salida real. */}
      {isList && (
        <button type="button" className="btn btn--acc" onClick={searchSongs}>
          <Icon name="MagnifyingGlass" size="md" />
          Buscar canciones
        </button>
      )}
    </div>
  ) : !shownRows.length ? (
    <p className="lnote">Ninguna canción coincide con la búsqueda o los filtros.</p>
  ) : (
    <>
      {pc && isList && (
        <SortableHead kind="lst" sort={sort} onSort={onSortColumn} sticky
          bulk={picked.length > 0} onSelectAll={selectAll}
          allSelected={picked.length > 0 && picked.length === shownRows.length} />
      )}
      {pc && !isList && <SortableHead kind="trk" sort={sort} onSort={onSortColumn} sticky />}
      <div className="tcard">
        {isList ? (
          <PlaylistSongs
            playlist={pl}
            rows={shownRows}
            active={active}
            ctx={ctx}
            from={from}
            table={pc ? kindOf : undefined}
            onRemove={removeSong}
            selectFor={selectFor}
            draggable={!sort?.key}
          />
        ) : album ? (
          <VirtualList
            active={active}
            count={shownRows.length}
            getKey={(i) => shownRows[i].key}
            renderRow={(i, enter) => {
              const row = shownRows[i];
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
              return ctx.song(row.entry, shownRows, {
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
            count={shownRows.length}
            getKey={(i) => shownRows[i].key}
            renderRow={(i, enter) =>
              ctx.song(shownRows[i], shownRows, {
                enter,
                num: i + 1,
                from,
                table: pc ? kindOf : undefined,
                sub: artist ? shownRows[i].album || "" : "",
              })
            }
          />
        )}
      </div>
      {isList && (
        <BulkBar count={picked.length} onAdd={() => setSheet("add")}
          onFolder={() => setSheet("folder")} onRemove={bulkRemove}
          onCancel={() => setPicked([])} />
      )}
    </>
  );

  const menu = top?.type === "lmenu" && top.key === pl.id && (
    <ListMenu
      name={pl.name}
      anchor={top.anchor}
      onClose={nav.back}
      onPick={(kindPicked) => {
        if (kindPicked === "share") { sharePage(); nav.back(); }
        else if (kindPicked === "rename") { nav.back(); setNaming(true); }
        else if (kindPicked === "delete") deleteList();
        else {
          nav.back();
          if (kindPicked === "description") setDescEdit(true);
          else setSheet(kindPicked);
        }
      }}
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
      onPick={(kindPicked) => {
        if (kindPicked === "share") {
          sharePage();
          nav.back();
          return;
        }
        nav.replace({ type: "aldel", key: view.id, anchor: stackTop.anchor });
      }}
      onPhoto={() =>
        ctx.replaceArt(view.id, "album", name, stackTop.anchor, `${d.artist} ${name}`)
      }
    />
  );

  const artistMenu = artist && stackTop?.type === "artmenu" && stackTop.key === view.id && (
    <ArtistMenu
      name={name}
      anchor={stackTop.anchor}
      onClose={nav.back}
      onPhoto={() => ctx.replaceArt(view.id, "artist", name, stackTop.anchor, name)}
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
    const view = await (linkPromiseRef.current || resolveArtistLink(name, rows));
    if (seq !== linkSeq.current) return;
    setLinking(false);
    if (!activeRef.current) return;
    /* El contenido local se abre aqui; el catalogo salta a Buscar dejando
       la migaja con el album del que se salio. */
    const origin = { tab: nav.tab, label: name };
    if (view) crossGo(nav, view, origin);
    else {
      requestSearch(name);
      nav.goTab("search");
    }
  };

  /* Hojas de la ficha de lista: importar, elegir portada, destino del bloque
     y carpeta. Todas cierran con Escape/atras como el resto de la app. */
  const doImport = (keys, info) => {
    setSheet(null);
    if (!keys.length) {
      ctx.show(`${info.skipped} ${info.skipped === 1 ? "canción no encontrada" : "canciones no encontradas"}. No se añadió nada.`);
      return;
    }
    writeWithDuplicates(pl, keys, (final) => playlists.addKeys(pl.id, final),
      `Importadas ${keys.length} ${keys.length === 1 ? "canción" : "canciones"}`);
  };
  const addToTarget = (target) => {
    setSheet(null);
    writeWithDuplicates(target, selectedKeys,
      (keys) => playlists.addKeys(target.id, keys),
      `Añadidas a «${target.name}»`);
    setPicked([]);
  };
  const moveToFolder = (folder) => {
    playlists.addToFolder(folder.id, [pl.id]);
    playlists.edit(pl.id, { folder_id: folder.id });
    setSheet(null);
    setPicked([]);
    ctx.show(`«${pl.name}» movida a «${folder.name}»`);
  };

  if (artist) {
    return (
      <div className="lpage dpage dpage--artist">
        <div className="dgrid">
          <DetailHero
            round
            tone={tone}
            art={<Cover tone={tone} label={name} src={coverOf(rows)} target={view.id} round />}
            title={<h1>{name}</h1>}
            meta={meta}
            acts={acts}
            back={!pc && <Back bref={backRef} onClick={ctx.back} label={ctx.backLabel?.()} className="hback" />}
          />
          <div className="dmain">
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
                <SectionHead id="h-dalb" title="Álbumes"
                  onAll={() => ctx.open({ type: "all", what: "albums" })}
                  label="Ver todos los álbumes" />
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
            {similar.length > 0 && (
              <section className="sec" aria-labelledby="h-similares">
                <SectionHead id="h-similares" title="Artistas similares" />
                <div className="chips">
                  {similar.map((a) => (
                    <button
                      key={a.name}
                      type="button"
                      className="chip"
                      onClick={() => {
                        const view = artistView(a.name, index.entries);
                        if (view) crossGo(nav, view, { tab: nav.tab, label: name });
                        else {
                          requestSearch(a.name);
                          nav.goTab("search");
                        }
                      }}
                    >
                      {a.name}
                    </button>
                  ))}
                </div>
              </section>
            )}
            {tracks}
            {body}
            {artistMenu}
          </div>
        </div>
      </div>
    );
  }

  const coverSources = isList ? mosaicSources(pl.keys, byKey, savedById, keyUrl) : [];
  const art = isList ? (
    pl.is_folder ? (
      <span className="dcv dcv--folder" aria-hidden="true"><Icon name="Folder" weight="fill" size="xl" /></span>
    ) : pl.cover_key ? (
      <span className="dcv dcv--cover"><img src={keyUrl(pl.cover_key)} alt="" /></span>
    ) : (
      <Mosaic tones={mosaicTones(pl.keys, byKey)} srcs={coverSources} className="dcv" />
    )
  ) : (
    <Cover tone={tone} label={name} src={coverOf(rows)} target={view.id} />
  );
  const title = naming && isList ? (
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
    <h1>{name}</h1>
  );
  const listInfo = isList && (
    <>
      {pl.folder_id && (
        <p className="dfolder">
          <Icon name="Folder" size="sm" />
          {lists.find((p) => p.id === pl.folder_id)?.name || "En una carpeta"}
        </p>
      )}
      {descEdit ? (
        <DescriptionField value={pl.description} onSubmit={(text) => {
          playlists.setDescription(pl.id, text);
          setDescEdit(false);
        }} onCancel={() => setDescEdit(false)} />
      ) : pl.description ? (
        <p className="ddesc">
          {pl.description}
          <button type="button" className="vf" aria-label="Editar descripción"
            onClick={() => setDescEdit(true)}>
            <Icon name="PencilSimple" size="sm" />
          </button>
        </p>
      ) : null}
    </>
  );
  const liner = album && (
    <p className="liner">
      <b>{shownLiner[0]}</b>
      <br />
      {shownLiner[1]}
    </p>
  );

  return (
    <div className="lpage dpage">
      {!pc && (
        <div className={cx("dbar", scrolled && "is-scrolled")}>
          <Back bref={backRef} onClick={ctx.back} label={ctx.backLabel?.()} className="hback cbtn--soft" />
          <span className="dbar__title">{name}</span>
          {more}
        </div>
      )}
      <div className="dgrid">
        <DetailHero
          art={art}
          title={title}
          meta={meta}
          by={album && { name: d.artist, onClick: () => ctx.open({ type: "artist", id: d.artistId }) }}
          acts={acts}
          foot={<>{listInfo}{liner}</>}
          more={pc && more}
          tone={tone}
        />
        <div className="dmain">
          {isList && pl.is_folder ? (
            <div className="grid">
              {folderMembers.length ? folderMembers.map((member) => (
                <ListCard key={member.id} list={member} byKey={byKey} ctx={ctx} />
              )) : <p className="lnote">Esta carpeta todavía no tiene listas.</p>}
            </div>
          ) : (
            <>
              {tracks}
              {body}
            </>
          )}
        </div>
      </div>
      {menu}
      {albumMenu}
      {artistMenu}
      {deleteSheet}
      {isList && sheet === "import" && (
        <ImportSheet onClose={() => setSheet(null)} onImport={doImport}
          entries={index.entries}
          onFind={(track) => {
            requestSearch(`${track.artist} ${track.title}`.trim());
            nav.goTab("search");
          }} />
      )}
      {isList && sheet === "cover" && (
        <CoverSheet sources={coverCandidates(shownRows)} onClose={() => setSheet(null)}
          onPick={(key) => { playlists.setCover(pl.id, key); setSheet(null); }} />
      )}
      {isList && sheet === "add" && (
        <PickListSheet title={`Añadir ${selectedKeys.length} a una lista`} lists={lists}
          onPick={addToTarget} onClose={() => setSheet(null)} />
      )}
      {isList && sheet === "folder" && (
        <PickListSheet title="Mover la lista a una carpeta" lists={lists} onlyFolders
          onPick={moveToFolder} onClose={() => setSheet(null)} />
      )}
      {isList && dup && (
        <DuplicateSheet name={dup.name} duplicates={dup.duplicates}
          onSkip={dup.onSkip} onAddAll={dup.onAddAll} onClose={() => setDup(null)} />
      )}
    </div>
  );
});
