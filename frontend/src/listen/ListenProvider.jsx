import {
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { keyUrl } from "../shared/api.js";
import { engine } from "../player/engine.js";
import { openVideo } from "../player/videoStore.js";
import { normalizeLibrary, toQueue, toTrack } from "./library.js";
import { buildIndex } from "./home.js";
import { history, useHistory } from "./history.js";
import { playlists, usePlaylists } from "./playlists.js";
import { useNotice } from "./Notice.jsx";
import { SongRow } from "./rows.jsx";

/* ---------------------------------------------------------------------------
   LO QUE COMPARTEN LAS PANTALLAS DE LA BIBLIOTECA

   Inicio, Tu biblioteca y Buscar pintan las mismas filas y comparten el menu
   de fila abierto, la hoja "Añadir a una lista", el aviso y las funciones de
   reproducir. Viven aqui, montadas UNA vez alrededor de las pantallas: una
   pantalla oculta (display:none) ya no se lleva su aviso ni su hoja.

   `useListen()` devuelve:
     ctx    lo que reciben las vistas (menu, play, open, back, song...). Se
            rehace al abrir o cerrar un menu: solo repintan quienes lo leen.
     model  { entries, index, byKey, plays, lists, listsReady }, calculado
            una vez para las tres pantallas.
     show   el aviso pasajero.
   `nav` pone open/back (la pila de paginas vive en useNav).
   ------------------------------------------------------------------------- */

/* La hoja solo se abre desde un menu: no hace falta en el primer script. */
const PlaylistPicker = lazy(() => import("./PlaylistPicker.jsx"));

const ListenContext = createContext(null);

export const useListen = () => useContext(ListenContext);

export default function ListenProvider({ files, nav, children }) {
  /* { key, el }: la fila con el menu abierto y su boton. Solo hay uno. */
  const [menu, setMenu] = useState(null);
  /* { key, title, el }: la cancion de la hoja "Añadir a una lista". */
  const [picker, setPicker] = useState(null);
  const [noticeNode, show] = useNotice();

  const lists = usePlaylists((s) => s.list);
  const listsReady = usePlaylists((s) => s.ready);
  const hist = useHistory();

  const entries = useMemo(() => normalizeLibrary(files), [files]);
  const index = useMemo(() => buildIndex(entries), [entries]);
  const byKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const plays = useMemo(
    () => Object.fromEntries(Object.entries(hist.tracks).map(([k, t]) => [k, t.plays])),
    [hist.tracks]
  );
  const model = useMemo(
    () => ({ entries, index, byKey, plays, lists, listsReady }),
    [entries, index, byKey, plays, lists, listsReady]
  );

  /* Las listas y el historial se piden una vez al arrancar; los fallos de
     escritura de las listas (que ya deshizo el almacen) se dicen en el aviso. */
  useEffect(() => {
    playlists.load();
    history.load();
    return playlists.onError(show);
  }, [show]);

  /* Fuera del menu, con scroll o con Tab se cierra. El boton de otra fila
     queda fuera de la excepcion a proposito: su clic ya cambia el menu. */
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onDown = (e) => {
      if (!e.target.closest(".rmenu, .srow__more")) close();
    };
    const onKey = (e) => {
      if (e.key === "Tab") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close);
    };
  }, [menu]);

  const value = useMemo(() => {
    /* Con teclado el foco vuelve al boton que abrio el menu. */
    const closeMenu = (refocus) => {
      if (refocus) menu?.el.focus({ preventScroll: true });
      setMenu(null);
    };

    /* Escape: lo mas pequeno primero. La hoja se cierra sola (captura). */
    const closeTop = () => {
      if (!menu) return false;
      closeMenu(true);
      return true;
    };

    const onMenu = (key, el) => setMenu((m) => (m && m.key === key ? null : { key, el }));

    const pick = (entry, kind) => {
      if (kind === "list") {
        setPicker({ key: entry.key, title: entry.title, el: menu?.el });
        setMenu(null);
        return;
      }
      const track = toTrack(entry, keyUrl);
      /* Con el motor parado las dos opciones arrancan la cancion: el aviso
         tiene que decir eso y no "a continuacion". */
      const idle = !engine.getState().track;
      const done = kind === "next" ? engine.playNext(track) : engine.enqueue(track);
      closeMenu(true);
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

    /* Borrar es inmediato y se puede deshacer unos segundos: la lista vuelve
       con el mismo id, nombre y canciones. */
    const deleteList = (pl) => {
      setMenu(null);
      playlists.remove(pl.id);
      nav.back();
      show(`Lista «${pl.name}» borrada`, { label: "Deshacer", run: () => playlists.undoRemove(pl) });
    };

    const play = (entry, el, list) => {
      if (entry.kind === "video") {
        /* Un video no entra en la cola: se abre en el VideoHost. */
        openVideo(
          { src: keyUrl(entry.key), title: entry.title, artist: entry.artist, hasAudio: entry.hasAudio },
          el
        );
        return;
      }
      const queue = toQueue(list, keyUrl);
      engine.play(toTrack(entry, keyUrl), {
        queue,
        index: queue.findIndex((t) => t.key === entry.key),
      });
    };

    /* Pulsar la que suena la pausa o la reanuda; otra, la pone. */
    const tap = (entry, el, list) => {
      if (engine.getState().track?.key === entry.key) engine.toggle();
      else play(entry, el, list);
    };

    /* "Reproducir" / "Aleatorio" de un grupo. Con aleatorio se empieza por una
       al azar, no siempre por la primera; restart: aunque ya suene esa pista,
       el grupo nuevo sustituye a la cola. */
    const playGroup = (group, shuffle = false) => {
      const queue = toQueue(group, keyUrl);
      if (!queue.length) return;
      if (shuffle) engine.setShuffle(true);
      const i = engine.getState().shuffle ? Math.floor(Math.random() * queue.length) : 0;
      engine.play(queue[i], { queue, index: i, restart: true });
    };

    /* Seguir escuchando: la cola son las pistas a medias y la elegida retoma
       donde se quedo. */
    const resume = (item, items) => {
      const queue = toQueue(
        items.map((i) => i.entry),
        keyUrl
      );
      const at = queue.findIndex((t) => t.key === item.entry.key);
      engine.play(queue[at], { queue, index: at, at: item.at });
    };

    const ctx = {
      menu,
      onMenu,
      closeMenu,
      closeTop,
      play,
      tap,
      playGroup,
      resume,
      open: nav.open,
      back: nav.back,
      deleteList,
      song: (entry, list, extra) => (
        <SongRow
          key={entry.key}
          entry={entry}
          menuOpen={menu?.key === entry.key}
          onPlay={(e, el) => play(e, el, list)}
          onMenu={onMenu}
          onPick={pick}
          {...extra}
        />
      ),
    };
    return { ctx, model, show };
  }, [menu, model, show, nav]);

  const closePicker = useCallback(() => {
    if (picker?.el?.isConnected) picker.el.focus({ preventScroll: true });
    setPicker(null);
  }, [picker]);

  return (
    <ListenContext.Provider value={value}>
      {children}
      {noticeNode}
      {picker && (
        <Suspense fallback={null}>
          <PlaylistPicker
            songKey={picker.key}
            title={picker.title}
            onNotice={show}
            onClose={closePicker}
          />
        </Suspense>
      )}
    </ListenContext.Provider>
  );
}
