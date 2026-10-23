import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { GoogleDriveLogo, HardDrives, MagnifyingGlass, Play } from "@phosphor-icons/react";
import { keyUrl } from "../shared/api.js";
import { cx, useSlidingPill } from "../shared/ui.jsx";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { openVideo } from "../player/videoStore.js";
import {
  filterEntries,
  groupAlbums,
  groupArtists,
  normalizeLibrary,
  toQueue,
  toTrack,
} from "./library.js";
import { subscribeReveal, takeReveal } from "./reveal.js";
import QueueList from "./QueueList.jsx";
import VirtualList from "./VirtualList.jsx";
import { Icon } from "./icons.jsx";
import { GroupRow, SongRow } from "./rows.jsx";

/* ---------------------------------------------------------------------------
   ESCUCHAR

   La biblioteca (canciones, artistas, albumes) y la cola en una sola pantalla.
   ListenView es dueno de lo que se comparte entre pestanas: la busqueda, el
   menu de fila abierto, el aviso, el scroll de cada vista y la peticion de "ir
   a la cancion" del mini-reproductor. Las listas son virtuales y scrollean con
   la ventana, igual que el resto de pantallas.
   ------------------------------------------------------------------------- */

const TABS = [
  ["songs", "Canciones"],
  ["artists", "Artistas"],
  ["albums", "Álbumes"],
  ["queue", "Cola"],
];

const REPEAT = {
  off: ["Repetir: no", "repeat"],
  all: ["Repetir: todo", "repeat"],
  one: ["Repetir: una", "repeatOnce"],
};

/* El aviso se retira solo; la salida dura --t-quick (180 ms). */
const NOTICE_MS = 1600;
const NOTICE_LEAVE_MS = 180;

export default function ListenView({
  files,
  ready,
  error,
  errorCode,
  health,
  active,
  onOpenStorage,
  onRetry,
  onGoDownload,
}) {
  const [tab, setTab] = useState("songs");
  /* { id, name } del artista o album abierto dentro de su pestana. */
  const [detail, setDetail] = useState(null);
  const [q, setQ] = useState("");
  /* Escribir no tiene que esperar a que se filtre y se pinte la lista. */
  const dq = useDeferredValue(q);
  /* { key, el }: la fila con el menu abierto y su boton. Solo hay uno. */
  const [menu, setMenu] = useState(null);
  const [notice, setNotice] = useState(null);
  const [revealTick, setRevealTick] = useState(0);

  const shuffle = useEngine((s) => s.shuffle);
  const repeat = useEngine((s) => s.repeat);

  const searchRef = useRef(null);
  const segsRef = useRef(null);
  const backRef = useRef(null);
  const listRef = useRef(null);
  const scrolls = useRef(new Map());
  const wanted = useRef(null);
  const noticeTimers = useRef([]);
  const revealRef = useRef(null);
  const firstView = useRef(true);

  useSlidingPill(segsRef, ready ? tab : null);

  const entries = useMemo(() => normalizeLibrary(files), [files]);
  const filtered = useMemo(() => filterEntries(entries, dq), [entries, dq]);
  const groups = useMemo(
    () =>
      tab === "artists"
        ? groupArtists(filtered)
        : tab === "albums"
          ? groupAlbums(filtered)
          : null,
    [tab, filtered]
  );
  const group = detail && groups ? groups.find((g) => g.id === detail.id) : null;

  const showGroups = Boolean(groups) && !detail;
  /* Las canciones que se ven: todas, o las del artista/album abierto. */
  const songs = tab === "songs" ? filtered : detail ? (group ? group.entries : []) : null;
  /* Lo que "Reproducir todo" pone en cola desde la vista actual. */
  const playable = songs || filtered;

  /* --- Scroll por vista --------------------------------------------------- */

  /* Cada vista (pestana, o detalle dentro de una pestana) recuerda su scroll:
     volver a una pestana o salir de un detalle la deja donde estaba, y un
     detalle nuevo empieza por arriba. */
  const viewKey = `${tab}|${detail ? detail.id : ""}`;

  const go = (nextTab, nextDetail = null) => {
    scrolls.current.set(viewKey, window.scrollY);
    if (nextDetail) scrolls.current.delete(`${nextTab}|${nextDetail.id}`);
    setMenu(null);
    setTab(nextTab);
    setDetail(nextDetail);
  };

  useLayoutEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    window.scrollTo(0, scrolls.current.get(viewKey) ?? 0);
  }, [viewKey]);

  useEffect(() => {
    if (detail) backRef.current?.focus({ preventScroll: true });
  }, [detail?.id]);

  /* --- Ir a la cancion (mini-reproductor) --------------------------------- */

  /* La peticion se atiende solo con la pantalla a la vista. Si la cancion no
     esta en el filtro se limpia la busqueda; el scroll espera a que la lista
     la contenga (el filtro diferido puede llegar un render despues). */
  revealRef.current = () => {
    const key = takeReveal();
    if (key === null || !entries.some((e) => e.key === key)) return;
    if (!filtered.some((e) => e.key === key)) setQ("");
    if (tab !== "songs" || detail) go("songs");
    wanted.current = key;
    setRevealTick((n) => n + 1);
  };

  useEffect(() => {
    if (!active) return undefined;
    const run = () => revealRef.current();
    run();
    return subscribeReveal(run);
  }, [active]);

  useLayoutEffect(() => {
    const key = wanted.current;
    if (key === null || tab !== "songs" || detail) return;
    const i = filtered.findIndex((e) => e.key === key);
    if (i < 0) return;
    wanted.current = null;
    listRef.current?.scrollToIndex(i);
  }, [revealTick, tab, detail, filtered]);

  /* --- Menu de fila y aviso ----------------------------------------------- */

  /* Con teclado el foco vuelve al boton que abrio el menu. */
  const closeMenu = (refocus) => {
    if (refocus) menu?.el.focus({ preventScroll: true });
    setMenu(null);
  };

  /* Fuera del menu, con scroll o con Escape se cierra. El boton de otra fila
     queda fuera de la excepcion a proposito: su clic ya cambia el menu. */
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onDown = (e) => {
      if (!e.target.closest(".rmenu, .srow__more")) close();
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", close, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", close);
    };
  }, [menu]);

  const show = (text) => {
    noticeTimers.current.forEach(clearTimeout);
    setNotice({ text, out: false, id: Date.now() });
    noticeTimers.current = [
      setTimeout(() => setNotice((n) => n && { ...n, out: true }), NOTICE_MS),
      setTimeout(() => setNotice(null), NOTICE_MS + NOTICE_LEAVE_MS),
    ];
  };
  useEffect(() => () => noticeTimers.current.forEach(clearTimeout), []);

  const pick = (entry, kind) => {
    const track = toTrack(entry, keyUrl);
    /* Con el motor parado las dos opciones arrancan la cancion: el aviso tiene
       que decir eso y no "a continuacion". */
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

  /* --- Teclado ------------------------------------------------------------ */

  /* "/" lleva el foco al buscador, pero solo con Escuchar a la vista: las
     pantallas ocultas siguen montadas y escuchando el documento. No se mira
     defaultPrevented porque Descargar (siempre montada) ya lo consume. */
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (e.key === "/" && tab !== "queue" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const a = document.activeElement;
        if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape") {
        if (menu) closeMenu(true);
        else if (detail) go(tab);
      } else if (e.key === "Tab" && menu) {
        setMenu(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const onTabKey = (e) => {
    const at = TABS.findIndex(([id]) => id === tab);
    const to =
      e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const n = (to + TABS.length) % TABS.length;
    go(TABS[n][0]);
    e.currentTarget.children[n].focus();
  };

  /* --- Reproduccion ------------------------------------------------------- */

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

  const playAll = () => {
    const queue = toQueue(playable, keyUrl);
    if (!queue.length) return;
    /* Con aleatorio se empieza por una al azar, no siempre por la primera. */
    const i = engine.getState().shuffle ? Math.floor(Math.random() * queue.length) : 0;
    /* restart: aunque ya suene esa pista, "Reproducir todo" empieza de cero
       con la lista nueva. */
    engine.play(queue[i], { queue, index: i, restart: true });
  };

  const onMenu = (key, el) => setMenu((m) => (m && m.key === key ? null : { key, el }));

  /* --- Pintado ------------------------------------------------------------ */

  const [repeatLabel, repeatIcon] = REPEAT[repeat];
  const search = q.trim();

  let list;
  if (tab === "queue") {
    list = <QueueList active={active} />;
  } else if (!entries.length) {
    list = (
      <p className="lnote">
        Todavía no has descargado nada.
        <br />
        <button type="button" className="vf" onClick={onGoDownload}>
          Ir a Descargar
        </button>
      </p>
    );
  } else if (!(showGroups ? groups : songs).length) {
    list = <p className="lnote">Nada coincide con «{search}».</p>;
  } else if (showGroups) {
    list = (
      <VirtualList
        key={viewKey}
        active={active}
        count={groups.length}
        getKey={(i) => groups[i].id}
        renderRow={(i, enter) => (
          <GroupRow
            group={groups[i]}
            album={tab === "albums"}
            enter={enter}
            onOpen={(g) => go(tab, { id: g.id, name: g.name })}
          />
        )}
      />
    );
  } else {
    list = (
      <VirtualList
        key={viewKey}
        ref={listRef}
        active={active}
        count={songs.length}
        getKey={(i) => songs[i].key}
        renderRow={(i, enter) => (
          <SongRow
            entry={songs[i]}
            enter={enter}
            menuOpen={menu?.key === songs[i].key}
            onPlay={(entry, el) => play(entry, el, songs)}
            onMenu={onMenu}
            onPick={pick}
          />
        )}
      />
    );
  }

  let body;
  if (!ready) {
    body = error ? (
      <p className="lnote" role="alert">
        {errorCode === "reconnect_required" ? (
          <>
            Tu sesión de Google Drive ha caducado.
            <br />
            <button type="button" className="vf" onClick={() => onOpenStorage()}>
              Volver a conectar
            </button>
          </>
        ) : (
          <>
            No se pudo cargar la biblioteca.
            <br />
            <button type="button" className="vf" onClick={onRetry}>
              Reintentar
            </button>
          </>
        )}
      </p>
    ) : (
      <div className="lpanel" aria-busy="true">
        {Array.from({ length: 8 }, (_, n) => (
          <div key={n} className="lskel skel skel--pulse" style={{ "--i": n }} aria-hidden="true">
            <span className="art" />
            <span className="lskel__t" />
          </div>
        ))}
      </div>
    );
  } else {
    body = (
      <>
        <div className="ltool">
          <div
            ref={segsRef}
            className="segs"
            role="tablist"
            aria-label="Biblioteca"
            onKeyDown={onTabKey}
          >
            {TABS.map(([id, label]) => (
              <button
                key={id}
                id={`ltab-${id}`}
                type="button"
                role="tab"
                aria-selected={tab === id}
                aria-controls="lpanel"
                tabIndex={tab === id ? 0 : -1}
                className={cx("seg", tab === id && "is-on")}
                onClick={() => go(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab !== "queue" && (
            <div className="lsearch">
              <MagnifyingGlass size={18} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                value={q}
                placeholder="Buscar en tu biblioteca"
                aria-label="Buscar en tu biblioteca"
                autoComplete="off"
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          )}
        </div>

        {detail && (
          <div className="ldetail">
            <button ref={backRef} type="button" className="lbtn" onClick={() => go(tab)}>
              <Icon name="back" />
              Volver
            </button>
            <h2 className="ldetail__h">{detail.name}</h2>
          </div>
        )}

        <div className="lacts">
          {tab !== "queue" && (
            <button
              type="button"
              className="lbtn lbtn--go"
              disabled={!playable.length}
              onClick={playAll}
            >
              <Play size={16} weight="fill" aria-hidden="true" />
              Reproducir todo
            </button>
          )}
          <button
            type="button"
            className={cx("lbtn", shuffle && "is-on")}
            aria-pressed={shuffle}
            onClick={() => engine.setShuffle(!shuffle)}
          >
            <Icon name="shuffle" />
            Aleatorio
          </button>
          <button
            type="button"
            className={cx("lbtn", repeat !== "off" && "is-on")}
            onClick={() => engine.cycleRepeat()}
          >
            <Icon name={repeatIcon} />
            {repeatLabel}
          </button>
        </div>

        <div className="lpanel" role="tabpanel" id="lpanel" aria-labelledby={`ltab-${tab}`}>
          {list}
        </div>
      </>
    );
  }

  return (
    <section className="listen" aria-labelledby="listen-title">
      <header className="lhead">
        <h1 className="lhead__h" id="listen-title">
          Escuchar
          {ready && files.length > 0 && <span className="count">{files.length}</span>}
        </h1>
        {health?.library && (
          <button
            type="button"
            className="panel__store"
            onClick={() => onOpenStorage()}
            title="Cambiar dónde se guarda tu música"
          >
            {/^Google Drive/.test(health.library) ? (
              <GoogleDriveLogo size={15} aria-hidden="true" />
            ) : (
              <HardDrives size={15} aria-hidden="true" />
            )}
            <span className="panel__path">{health.library}</span>
          </button>
        )}
      </header>

      {body}

      {/* Siempre montada: un aria-live solo anuncia lo que cambia dentro de una
          region que ya existia. */}
      <div className="lnotice" aria-live="polite">
        {notice && (
          <span key={notice.id} className={cx("ltoast", notice.out && "is-out")}>
            {notice.text}
          </span>
        )}
      </div>
    </section>
  );
}
