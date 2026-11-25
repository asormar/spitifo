import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { isOverlay } from "../app/navigation.js";
import { keyUrl } from "../shared/api.js";
import { engine, prefetchKey } from "../player/engine.js";
import { openVideo } from "../player/videoStore.js";
import { checkedSummary } from "./fileCheck.js";
import { mergeLibrary } from "./mergedLibrary.js";
import { buildIndex } from "./home.js";
import { mixEntries } from "./mixes.js";
import { LazyOverlays, loadOverlays, loadPageHost, overlaysReady, pageReady } from "./pageLoader.jsx";
import { history, useHistory } from "./history.js";
import { playlists, usePlaylists } from "./playlists.js";
import { useSaved } from "./saved.js";
import { tracksFor } from "../player/savedTrack.js";
import { useNotice, NoticeProvider } from "./Notice.jsx";
import { SongRow } from "./rows.jsx";
import { useOnline } from "../shared/online.js";
import { allBlocked, OFFLINE_EMPTY, playableEntries, rowState } from "./offline.js";

/* ---------------------------------------------------------------------------
   LO QUE COMPARTEN LAS PANTALLAS DE LA BIBLIOTECA

   Inicio, Tu biblioteca y Buscar pintan las mismas filas y comparten el menu
   de fila, la hoja "Añadir a una lista", el aviso y las funciones de
   reproducir. Viven aqui, montadas UNA vez alrededor de las pantallas y de
   "Ahora suena" (que lee el mapa de la biblioteca para los mosaicos de su hoja
   de listas): una pantalla oculta (display:none) ya no se lleva su aviso ni su
   hoja. El proveedor no pinta DOM propio.

   `useListen()` devuelve:
     ctx    lo que reciben las vistas (openMenu, play, open, goTo, show, song...).
            Es estable: solo se rehace con la biblioteca. Abrir o cerrar un menu
            no repinta ninguna fila (SongRow es memo y sus props no cambian).
     model  { entries, index, byKey, savedById, plays, lists, listsReady, storage, check },
            calculado una vez para las tres pantallas. `storage` es donde
            se guarda la musica ("Google Drive" o "este dispositivo") y `check`
            el resumen de «comprobadas» (vacio si ninguna lo esta).
     show   el aviso pasajero.
   `nav` (useNav) pone open/back/replace: la pila de paginas vive en el shell.
   Los menus y la hoja de listas son la entrada de arriba de esa pila (menu,
   picker, lmenu), asi que atras, Escape y el atras de Android los cierran, y un
   cambio de pestana los quita con el resto de la pila.
   ------------------------------------------------------------------------- */

const ListenContext = createContext(null);

export const useListen = () => useContext(ListenContext);

export default function ListenProvider({ files, nav, leaveNp, locationToken, storage, refresh, hideKeys, restoreFiles, children }) {
  /* Solo se leen las acciones (estables): depender de `nav` entero
     reconstruiria el contexto en cada cambio de pestana. */
  const { open: navOpen, back: navBack, replace: navReplace, getStack } = nav;
  const [noticeNode, show] = useNotice();
  /* Aperturas de pagina o de menu: solo vale la ultima si el chunk aun no ha
     llegado. */
  const opening = useRef(0);

  const lists = usePlaylists((s) => s.list);
  const listsReady = usePlaylists((s) => s.ready);
  const savedById = useSaved((s) => s.byId);
  const hist = useHistory();
  const online = useOnline();

  /* Archivos y guardadas se juntan en UN useMemo: ni una segunda pasada por
     fila, ni dos mapas que se puedan desincronizar. */
  const merged = useMemo(() => mergeLibrary(files, savedById), [files, savedById]);
  const { entries, byKey } = merged;
  const index = useMemo(() => buildIndex(entries), [entries]);
  const plays = useMemo(
    () => Object.fromEntries(Object.entries(hist.tracks).map(([k, t]) => [k, t.plays])),
    [hist.tracks]
  );
  const check = useMemo(() => checkedSummary(entries), [entries]);
  const model = useMemo(
    () => ({ entries, index, byKey, savedById, plays, lists, listsReady, storage, check }),
    [entries, index, byKey, savedById, plays, lists, listsReady, storage, check]
  );

  /* Las listas y el historial se piden una vez al arrancar; los fallos de
     escritura de las listas (que ya deshizo el almacen) se dicen en el aviso. */
  useEffect(() => {
    playlists.load();
    history.load();
    return playlists.onError(show);
  }, [show]);

  const value = useMemo(() => {
    /* Sin red solo entran en la cola las que tienen archivo. Si no queda
       ninguna y habia algo, se dice por que en vez de callar. */
    const usable = (list) => {
      if (allBlocked(list, online)) show(OFFLINE_EMPTY);
      return playableEntries(list, online);
    };

    /* `from` es el origen ("album:X", "library:", ...): lo que dice "Sonando
       desde" en Ahora suena. Una cadena estable, no un objeto: SongRow es memo. */
    const play = (entry, el, list, from) => {
      if (entry.kind === "video") {
        /* Un video no entra en la cola: se abre en el VideoHost. */
        openVideo(
          { src: keyUrl(entry.key), title: entry.title, artist: entry.artist, hasAudio: entry.hasAudio },
          el
        );
        return;
      }
      const state = rowState(entry, online);
      if (state.blocked) {
        show(state.notice);
        return;
      }
      const queue = tracksFor(usable(list), model.byKey, model.savedById, keyUrl);
      const at = queue.findIndex((t) => t.key === entry.key || (entry.sid && t.sid === entry.sid));
      const track = at >= 0 ? queue[at] : tracksFor([entry], model.byKey, model.savedById, keyUrl)[0];
      /* La cola ya esta construida: adelantar la pista que se va a tocar (y no
         solo la siguiente) quita el viaje en frio a Drive del primer toque. */
      if (track?.kind === "library") prefetchKey(track.key);
      engine.play(track, { queue, index: at, source: from });
    };

    /* Pulsar la que suena la pausa o la reanuda; otra, la pone. */
    const tap = (entry, el, list, from) => {
      if (engine.getState().track?.key === entry.key) engine.toggle();
      else play(entry, el, list, from);
    };

    /* "Reproducir" / "Aleatorio" de un grupo. Con aleatorio se empieza por una
       al azar, no siempre por la primera; restart: aunque ya suene esa pista,
       el grupo nuevo sustituye a la cola. */
    const playGroup = (group, shuffle = false, from) => {
      const queue = tracksFor(usable(group), model.byKey, model.savedById, keyUrl);
      if (!queue.length) return;
      if (shuffle) engine.setShuffle(true);
      const i = engine.getState().shuffle ? Math.floor(Math.random() * queue.length) : 0;
      engine.play(queue[i], { queue, index: i, restart: true, source: from });
    };

    /* La Mezcla de Inicio: una cola barajada y sin fin con las canciones de
       esa mezcla. La cola es una foto: no se vacia a medida que se oyen. */
    const playMix = (key) => {
      const queue = tracksFor(
        usable(mixEntries(key, model.entries, history.getState(), model.byKey)),
        model.byKey, model.savedById, keyUrl
      );
      if (!queue.length) return;
      engine.setShuffle(true);
      const i = Math.floor(Math.random() * queue.length);
      engine.play(queue[i], {
        queue,
        index: i,
        restart: true,
        source: `mix:${key}`,
        endless: true,
      });
    };

    /* Seguir escuchando: la cola son las pistas a medias y la elegida retoma
       donde se quedo. */
    const resume = (item, items, from) => {
      const queue = tracksFor(
        usable(items.map((i) => i.entry)),
        model.byKey, model.savedById, keyUrl
      );
      const at = queue.findIndex((t) => t.key === item.entry.key);
      if (at < 0) return;
      engine.play(queue[at], { queue, index: at, at: item.at, source: from });
    };

    /* Espera al chunk que hace falta (la pantalla actual sigue a la vista en vez
       de quedar en blanco) y solo vale la ultima peticion. Si la carga falla se
       navega igual. */
    const whenReady = (ready, load, go) => {
      const n = ++opening.current;
      if (ready()) go();
      else
        load()
          .catch(() => {})
          .then(() => n === opening.current && go());
    };

    /* Abre el menu (o el de una lista, `type` lmenu) de `key` junto a `el`: el
       mismo boton otra vez lo cierra; otro menu o la hoja de listas, lo cambia;
       si no, se apila. */
    const openMenu = (key, el, type = "menu", extra = null) => {
      const on = getStack().at(-1);
      if (on?.type === type && on.key === key) {
        navBack();
        return;
      }
      const view = { type, key, anchor: el, ...extra };
      whenReady(overlaysReady, loadOverlays, () =>
        isOverlay(getStack().at(-1)?.type) ? navReplace(view) : navOpen(view)
      );
    };

    const ctx = {
      openMenu,
      show,
      /* Token del sitio actual: las acciones que esperan la red lo guardan al
         empezar y solo actuan si sigue igual al resolverse. */
      locationToken,
      /* Borrado de la biblioteca: ocultar ahora, restaurar si se deshace y
         volver a consultar /api/library cuando se confirma. */
      hideKeys,
      restoreFiles,
      refreshLibrary: refresh,
      play,
      tap,
      playGroup,
      playMix,
      resume,
      open: (v) => whenReady(pageReady, loadPageHost, () => navOpen(v)),
      /* La hoja de foto vive en el chunk de overlays, como los menus. */
      openArt: (target, kind, name, anchor, query) =>
        whenReady(overlaysReady, loadOverlays, () =>
          navOpen({ type: "art", target, kind, name, query: query || name, anchor })
        ),
      /* Desde un menu se sustituye: atras vuelve a la pagina, no al menu. */
      replaceArt: (target, kind, name, anchor, query) =>
        whenReady(overlaysReady, loadOverlays, () =>
          navReplace({ type: "art", target, kind, name, query: query || name, anchor })
        ),
      /* Cambia el menu de arriba por una pagina ("Ir al album"). Si el menu
         estaba sobre "Ahora suena", primero se cierran el menu y la vista de
         una vez (si solo se sustituyera el menu, la entrada de la vista
         quedaria muerta) y la pagina se apila sobre la que habia debajo: atras
         vuelve ahi, al artista por ejemplo, y no a la raiz. */
      goTo: (v) =>
        whenReady(pageReady, loadPageHost, () => {
          if (leaveNp?.(() => navOpen(v))) return;
          navReplace(v);
        }),
      back: navBack,
      song: (entry, list, extra) => (
        <SongRow key={entry.key} entry={entry} list={list} onPlay={play} onMenu={openMenu} {...extra} />
      ),
    };
    return { ctx, model, show };
  }, [model, show, online, navOpen, navBack, navReplace, getStack, leaveNp, locationToken, refresh, hideKeys, restoreFiles]);

  /* El menu de una cancion, la hoja de listas o la ficha del archivo, si es lo
     de arriba de la pila (el de una lista lo pinta su pagina). */
  const top = nav.stack.at(-1);
  const overlay = top && (top.type === "menu" || top.type === "picker" || top.type === "file" || top.type === "art" || top.type === "npmenu") ? top : null;

  return (
    <NoticeProvider value={show}>
      <ListenContext.Provider value={value}>
        {children}
        {noticeNode}
        {overlay && (
          <LazyOverlays
            top={overlay}
            byKey={model.byKey}
            back={navBack}
            replace={navReplace}
            goTo={value.ctx.goTo}
            show={show}
            locationToken={locationToken}
            storage={model.storage}
            refresh={refresh}
            hideKeys={hideKeys}
            restoreFiles={restoreFiles}
          />
        )}
      </ListenContext.Provider>
    </NoticeProvider>
  );
}
