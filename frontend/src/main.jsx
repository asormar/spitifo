import "@fontsource-variable/outfit";
import "@fontsource-variable/figtree";
import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  ArrowUpRight,
  CaretRight,
  Check,
  CheckCircle,
  CircleNotch,
  Crosshair,
  DeviceMobile,
  DownloadSimple,
  GoogleDriveLogo,
  HardDrives,
  Headphones,
  Laptop,
  ListBullets,
  MagnifyingGlass,
  MusicNotes,
  Pause,
  Play,
  Prohibit,
  Question,
  SpeakerHigh,
  SpeakerLow,
  SpeakerSlash,
  Sparkle,
  Stack,
  Sun,
  Moon,
  Waveform,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import "./style.css";

const API = "/api";

/* Cuanto tarda en desaparecer el aviso de descarga una vez terminada. */
const JOB_DISMISS_MS = 5000;

document.title = "Spitifo: descarga música libre";

const SOURCE_LABEL = {
  itunes: "iTunes",
  archive: "Internet Archive",
  jamendo: "Jamendo",
  wikimedia: "Wikimedia",
  ytdlp: "YouTube",
};

/* Los tres modos que ve el usuario. Los nombres internos (matched, sources,
   ytdlp) no salen nunca a la pantalla. La explicacion que vivia debajo del
   selector (y el aviso legal antes que ella) ya no esta en la UI: se
   eliminaron por decision del usuario, no por descuido. */
const MODES = [
  { id: "matched", label: "Música" },
  { id: "sources", label: "Todas las fuentes" },
  { id: "ytdlp", label: "YouTube" },
];

const MODE_IDS = MODES.map((m) => m.id);

/* Formatos que acepta el backend. El valor que viaja en el POST de descarga es
   exactamente este string, sin traducirlo. */
const FORMATS = [
  { value: "mp3", label: "mp3", title: "Convertir el audio a MP3" },
  { value: "m4a", label: "m4a", title: "Convertir el audio a M4A" },
  {
    value: "original",
    label: "original",
    // "original" no recodifica en ninguna fuente: las libres dejan el archivo
    // como lo publica la fuente (FLAC, OGG...; downloader.py) y YouTube deja
    // el audio en su contenedor natural, normalmente .opus o .m4a
    // (ytdlp_source.py, preferredcodec "best").
    title: "Sin convertir: el audio tal cual lo publica la fuente (en YouTube, normalmente Opus o AAC)",
  },
];

/* Aviso bajo los controles cuando se elige "original". El title de FORMATS no
   se ve en tactil, asi que la misma informacion sale como linea visible. */
/* Un enlace de YouTube solo tiene sentido en "YouTube" (iTunes no sabe
   que hacer con una URL). Misma regla de hosts que parse_youtube_url del
   backend; el ID lo valida el. */
const YT_URL = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\/\S+$/i;
const isYouTubeUrl = (text) => YT_URL.test(text.trim());

const PLACEHOLDER = {
  ytdlp: "Busca el título o pega la URL",
  default: "Busca una canción, un artista, un género",
};

const ORIGINAL_HINT = "Original: el archivo tal cual. Lo que venga de YouTube conserva su audio, sin recomprimir (normalmente Opus o AAC).";
const ORIGINAL_HINT_YT = "Original: el audio tal como viene de YouTube, sin recomprimir (normalmente Opus o AAC).";

const EXAMPLES = [
  "Nick Cave Into My Arms",
  "Chopin Nocturne",
  "Radiohead Creep",
  "Miles Davis So What",
];

/* El `detail` de FastAPI no siempre es un string: en un 422 es un array de
   {loc, msg, type}. Con `new Error(detail)` eso se convierte en
   "[object Object]" y el usuario lee eso en el aviso. Aplanar a los `msg`.
   Un string se devuelve tal cual; si no hay nada util, el fallback. */
function errMsg(d, fallback) {
  const detail = d?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((e) => (typeof e === "string" ? e : e?.msg))
      .filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  return fallback;
}

/* El aviso de identidad, en un solo lugar. Antes vivia inline en el camino sin
   job_id, asi que el camino CON job_id (modo Música, que es el default)
   salia con `return` antes de llegar y nunca avisaba: te bajabas la cancion
   equivocada con un cartel verde.

   "unknown" tambien avisa, y a proposito: significa que nadie pudo leer de
   donde viene el audio. "No se pudo verificar" es mas honesto que un visto
   bueno que nadie emitio. */
function mismatchNotice(d, match, realTitle, query) {
  if (match === "mismatch" || match === "unknown") {
    const donde = realTitle
      ? `en el archivo dice "${realTitle}"`
      : "no se pudo verificar de donde viene el audio";
    return { ...d, warning: `Ojo: ${donde} y tu buscaste "${query}".` };
  }
  return d;
}

/* fetch() tira TypeError con "Failed to fetch" (en ingles) cuando el server esta
   caido o se corta la red. Sin esto el usuario lee eso crudo en el aviso. */
function fetchErr(e, fallback) {
  const m = typeof e?.message === "string" ? e.message : "";
  if (/failed to fetch|networkerror|load failed/i.test(m)) {
    return "No se pudo contactar con el servidor. Esta sigue en marcha?";
  }
  return fallback;
}

/* Una URL que viene del servidor no se pone en `href` sin revisarle el
   esquema.

   Motivo concreto: `item_url` y `webpage_url` vienen de APIs externas
   (archive.org, iTunes, YouTube) y llegan tal cual al DOM. Con
   `javascript:...` en un href, un click ejecuta codigo en el ORIGEN de esta
   pagina, no en el sitio de la URL. No se demostro que hoy exista una URL
   asi —las fuentes actuales no la producen y el HeadlessChrome la bloquea—,
   pero el dato es externo y no verificado: la defensa va aca y no depende de
   que la fuente de hoy sea benigna.

   Solo pasan http/https. Una src relativa tambien, porque la genera la propia
   app. Cualquier otra cosa (javascript:, data:, vbscript:, blob:) devuelve
   null y el link no se renderiza. */
function safeUrl(u) {
  if (typeof u !== "string") return null;
  const s = u.trim();
  if (!s) return null;
  /* Relativa de un solo slash: la genera la app (ej. /api/audio?key=...).
     Un `//host` NO: es protocol-relativa, y `new URL` la resolveria contra
     el origin dandonos un http:// VALIDO que nunca fue una URL absoluta del
     servidor. Por eso se rechazan las dos barras. */
  if (s.startsWith("/")) return s.startsWith("//") ? null : s;
  /* Sin esquema explicito NO se toca. `new URL("basura", origin)` no lanza:
     la resuelve como ruta relativa y devuelve un http:// propio, o sea,
     ACEPTARIA cualquier cadena sin esquema como si fuera nuestra. Solo pasan
     las que traen http:// o https:// de verdad. */
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const parsed = new URL(s);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/* El unico lugar del componente que abre una URL externa. Si el esquema no
   pasa safeUrl no se renderiza nada: el link desaparece en vez de quedar roto
   o ejecutable. `rel="noopener noreferrer"` en todos: sin noopear, la pagina
   de destino recibe una referencia a `window.opener` y puede navegar esta
   pestana (reverse tabnabbing). */
function ExtLink({ url, className, children }) {
  const href = safeUrl(url);
  if (!href) return null;
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/* La clave que identifica una fila para el estado de "descargando". Antes se
   usaba `t.source + t.source_id` en Track pero SOLO `s.source_id` en las
   pistas del setlist (ShowGroup), asi que el ahi nunca coincidia con lo que
   guardaba onDownload y su spinner no aparebia nunca. Una sola funcion. */
const rowKey = (t) => (t?.source || "") + (t?.source_id || "");

function fmtTime(s) {
  if (!s) return "--:--";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function fmtSize(mb) {
  if (mb == null) return null;
  return `${Number(mb).toFixed(mb < 10 ? 1 : 0)} MB`;
}

/* El estado que domina la fila: se baja entero / solo preview / no coincide.

   OJO con el campo `downloadable` en modo Música: el backend lo deja en
   False aunque el archivo exista, porque la descarga sale de webpage_url. Por
   eso NO se lee ese campo solo: se mira tambien webpage_url y needs_resolve. */
function trackState(t) {
  const full = !!(
    t.downloadable ||
    t.audio_url ||
    t.extra?.needs_resolve ||
    t.extra?.webpage_url
  );
  if (full) return "full";
  if (t.preview_url) return "preview";
  return "none";
}

const STATE_UI = {
  full: { label: "Completo", tone: "ok" },
  preview: { label: "Solo preview", tone: "warn" },
  none: { label: "No coincide", tone: "bad" },
};

/* El "30 s" ya no cabe en el chip: sale como linea de texto junto al icono sin
   descarga (y como title, por si se recorta). */
const NODL_TITLE = {
  preview: "Solo hay 30 s de esta fuente",
  none: "No hay versión completa",
};

const cx = (...parts) => parts.filter(Boolean).join(" ");
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* "m:ss" para el reproductor. fmtTime devuelve "--:--" para 0, que aqui seria
   mentira: el principio de una cancion es 0:00, no un dato que falta. */
function clock(s) {
  const t = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/* Tema claro/oscuro. El valor inicial ya lo puso index.html en <html> antes de
   pintar; aqui solo se lee de ahi. Se guarda en localStorage cuando el usuario
   lo elige a mano; mientras no haya eleccion guardada, sigue al sistema. */
const THEME_KEY = "spitifo-theme";
const THEME_COLOR = { light: "#CFE6F5", dark: "#14293B" };

function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLOR[t]);
}

function useTheme() {
  const [theme, setTheme] = useState(
    () => document.documentElement.getAttribute("data-theme") || "light"
  );

  const choose = useCallback((t) => {
    /* El cambio se hace dentro de una View Transition: el navegador congela la
       pagina vieja y el tema nuevo se descubre encima con una cortina que baja
       (ver ::view-transition-new en style.css). flushSync hace que React pinte
       el boton y el resto ya en el nuevo estado antes de que el navegador
       tome la foto "nueva". Sin la API, o con movimiento reducido, se cambia
       directamente. */
    const commit = () =>
      flushSync(() => {
        applyTheme(t);
        setTheme(t);
      });
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (document.startViewTransition && !reduce) {
      /* La transicion RECHAZA si el documento queda oculto (el usuario cambia
         de pestana justo al apretar) y tambien si `commit` tira. El rechazo
         llega como `unhandledrejection` aunque el tema se aplique igual, porque
         el callback se corre en cualquier caso: por eso se tragan las tres
         promesas. Sin esto la consola del usuario se llena de
         "InvalidStateError: Transition was aborted". */
      try {
        const vt = document.startViewTransition(commit);
        vt.ready.catch(() => {});
        vt.finished.catch(() => {});
        vt.updateCallbackDone.catch(() => {});
      } catch (e) {
        commit();
      }
    } else {
      commit();
    }
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch (e) {
      /* Sin almacenamiento (modo privado): el tema vale para esta visita. */
    }
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  /* Sin eleccion guardada, cambiar el tema del sistema se refleja en vivo. */
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e) => {
      let saved = null;
      try {
        saved = localStorage.getItem(THEME_KEY);
      } catch (err) {
        /* igual que arriba */
      }
      if (saved === "light" || saved === "dark") return;
      const t = e.matches ? "dark" : "light";
      applyTheme(t);
      setTheme(t);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return [theme, choose];
}

/* La pastilla blanca de un segmentado se DESLIZA hasta la opcion activa en
   vez de saltar. Mide el boton activo y publica --ix / --iw en el contenedor;
   el CSS hace el resto con transform. `data-ready` se pone justo despues de
   la primera medida para que la pastilla no vuele desde 0 al montar. El
   ResizeObserver cubre fuentes que cargan tarde, el cambio de ancho del
   contador de "Todos 40" y el responsive. */
function useSlidingPill(ref, activeKey) {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return undefined;
    const place = () => {
      const on = box.querySelector(".seg.is-on");
      if (!on) {
        box.style.setProperty("--iw", "0px");
        return;
      }
      box.style.setProperty("--ix", `${on.offsetLeft}px`);
      box.style.setProperty("--iw", `${on.offsetWidth}px`);
    };
    place();
    /* Se lee offsetWidth para forzar el calculo de estilo con la posicion ya
       puesta; solo DESPUES se habilita la transicion. Asi el primer colocado
       nunca anima, y no depende de requestAnimationFrame (que no dispara en una
       pestana oculta). */
    void box.offsetWidth;
    box.setAttribute("data-ready", "");
    const ro = new ResizeObserver(place);
    ro.observe(box);
    box.querySelectorAll(".seg").forEach((b) => ro.observe(b));
    return () => ro.disconnect();
  }, [ref, activeKey]);
}

/* ---------------------------------------------------------------------------
   REPRODUCTOR

   El <audio> nativo no admite casi ningun estilo (solo width, height,
   color-scheme y accent-color), asi que sale como una caja oscura de esquinas
   rectas en medio de una interfaz clara. Aqui el <audio> SIGUE en el DOM, sin
   `controls` (no pinta nada), y se le dibuja encima una interfaz propia. Se
   conserva el elemento a proposito: las teclas multimedia del sistema, la
   pestana de Chrome y los lectores de pantalla siguen hablando con el.

   Dos niveles: "row" (biblioteca: boton, barra, tiempo y volumen) y "compact"
   (preview de 30 s en una tarjeta de resultados: prueba de sabor, sin volumen).

   UNA sola cancion suena a la vez. Con 31 <audio> independientes se podian
   tener cinco superpuestas. El registro `players` lo resuelve en el evento
   `play`, asi tambien cubre las teclas multimedia, que no pasan por el boton.
   El volumen y el silencio se comparten entre todos los reproductores.
   ------------------------------------------------------------------------- */

const players = new Set();
const shared = { volume: 0.8, muted: false };

/* La fila "activa" (filo coral, volumen, tirador) es solo la ULTIMA que sono.
   Una pausada a medias conserva su progreso, pero no se queda con el volumen
   abierto: tras probar cinco canciones serian cinco sliders. Los Player se
   suscriben para repintarse cuando cambia. */
let current = null;
const watchers = new Set();
function setCurrent(a) {
  current = a;
  watchers.forEach((w) => w());
}

/* Volumen y silencio comparten una sola fuente (`shared`) que escriben el
   Player activo y el mini-reproductor. Estas funciones la actualizan, aplican
   el cambio al <audio> que suena y avisan a los watchers para que ambos
   controles se repinten: ninguno guarda su propia copia del valor. */
function pushVolume() {
  if (current) {
    current.volume = shared.volume;
    current.muted = shared.muted;
  }
  watchers.forEach((w) => w());
}

function setSharedVolume(v) {
  shared.volume = v;
  shared.muted = v === 0;
  pushVolume();
}

function toggleSharedMute() {
  const next = !(shared.muted || shared.volume === 0);
  /* Reactivar desde 0 devolveria el silencio con el icono de sonido. */
  if (!next && shared.volume === 0) shared.volume = 0.8;
  shared.muted = next;
  pushVolume();
}

/* Datos de cada <audio> para quien no es su Player: el mini-reproductor solo
   recibe el elemento (`current`) y de ahi tiene que sacar el titulo, el
   subtitulo y la caja del Player para saber si se ve en pantalla. WeakMap para
   que un Player desmontado no retenga nada. */
const audioMeta = new WeakMap();

function Player({ src, label, title, meta, duration, artwork, variant = "row", index = 0, registerAudio, onStart, onEnded }) {
  const audioRef = useRef(null);
  const railRef = useRef(null);
  const rootRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [cur, setCur] = useState(0);
  const [realDur, setRealDur] = useState(0);
  /* Posicion (0..1) mientras se arrastra la barra. null = no se arrastra. */
  const [drag, setDrag] = useState(null);
  const [, repaint] = useReducer((n) => n + 1, 0);

  useEffect(() => {
    const a = audioRef.current;
    players.add(a);
    watchers.add(repaint);
    a.volume = shared.volume;
    a.muted = shared.muted;
    return () => {
      players.delete(a);
      watchers.delete(repaint);
      audioMeta.delete(a);
      if (current === a) setCurrent(null);
      a.pause();
    };
  }, []);

  /* El auto-advance de la biblioteca necesita el <audio> de la fila VECINA: el
     cajon registra cada fila por su indice y reproduce la siguiente al terminar.
     No se consulta el DOM por selectores: el mapa lo llena cada Player. */
  useEffect(() => {
    if (!registerAudio) return undefined;
    registerAudio(index, audioRef.current);
    return () => registerAudio(index, null);
  }, [index, registerAudio]);

  /* Aparte del efecto de montaje: titulo y meta pueden cambiar sin que el
     elemento se remonte, y el registro tiene que seguirlos. */
  useEffect(() => {
    audioMeta.set(audioRef.current, {
      label,
      title,
      meta,
      duration,
      artwork,
      variant,
      el: rootRef.current,
    });
  }, [label, title, meta, duration, artwork, variant]);

  /* Se leen de `shared` en cada pintado: los watchers fuerzan el repintado
     cuando el volumen cambia desde el mini-reproductor. */
  const vol = shared.volume;
  const muted = shared.muted;
  const dur = realDur || duration || 0;
  const pct = drag !== null ? drag : dur ? clamp(cur / dur, 0, 1) : 0;
  const shownTime = drag !== null ? drag * dur : cur;
  const isCurrent = !!audioRef.current && current === audioRef.current;
  const active = !failed && isCurrent && (playing || cur > 0 || drag !== null);
  const total = dur ? clock(Math.round(dur)) : "--:--";

  const toggle = () => {
    const a = audioRef.current;
    if (!a || failed) return;
    if (a.paused) {
      a.volume = shared.volume;
      a.muted = shared.muted;
      setBuffering(true);
      /* play() rechaza con AbortError si se pausa antes de arrancar: no es un
         fallo del audio. Los fallos reales llegan por onError. */
      a.play().catch(() => setBuffering(false));
    } else {
      a.pause();
    }
  };

  const seekTo = (t) => {
    const a = audioRef.current;
    const v = clamp(t, 0, dur || 0);
    if (a && dur) a.currentTime = v;
    setCur(v);
  };

  const pctAt = (e) => {
    const r = railRef.current.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };

  const onPointerDown = (e) => {
    if (!dur || failed) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(pctAt(e));
  };
  const onPointerMove = (e) => {
    if (drag !== null) setDrag(pctAt(e));
  };
  const onPointerUp = (e) => {
    if (drag === null) return;
    seekTo(pctAt(e) * dur);
    setDrag(null);
  };

  const onKeyDown = (e) => {
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      /* Se parte del reloj real del <audio>, no de `cur`: ese estado se
         refresca ~4 veces por segundo y las flechas repetidas no sumaban. */
      seekTo((audioRef.current?.currentTime ?? cur) + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      seekTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      seekTo(dur - 1);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle();
    }
  };

  const onVolume = (e) => {
    setSharedVolume(Number(e.target.value) / 100);
    /* Por si el cambio llega antes de que este <audio> sea `current`. */
    const a = audioRef.current;
    a.volume = shared.volume;
    a.muted = shared.muted;
  };

  const toggleMute = () => {
    toggleSharedMute();
    const a = audioRef.current;
    a.volume = shared.volume;
    a.muted = shared.muted;
  };

  const icon = failed ? "play" : buffering ? "load" : playing ? "pause" : "play";
  const verb = playing ? "Pausar" : "Reproducir";
  const small = variant === "compact";
  const iconSize = small ? 13 : 16;

  const audio = (
    <audio
      ref={audioRef}
      src={src}
      /* Con la duracion ya conocida no hace falta pedir metadatos de cada fila:
         31 filas eran 31 peticiones al abrir la biblioteca. */
      preload={duration ? "none" : "metadata"}
      onLoadedMetadata={(e) => {
        if (Number.isFinite(e.currentTarget.duration)) setRealDur(e.currentTarget.duration);
      }}
      onDurationChange={(e) => {
        if (Number.isFinite(e.currentTarget.duration)) setRealDur(e.currentTarget.duration);
      }}
      onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
      onPlay={(e) => {
        players.forEach((o) => {
          if (o !== e.currentTarget) o.pause();
        });
        e.currentTarget.volume = shared.volume;
        e.currentTarget.muted = shared.muted;
        setCurrent(e.currentTarget);
        setPlaying(true);
        onStart?.();
      }}
      onPlaying={() => setBuffering(false)}
      onWaiting={() => setBuffering(true)}
      onPause={() => {
        setPlaying(false);
        setBuffering(false);
      }}
      onEnded={(e) => {
        e.currentTarget.currentTime = 0;
        setPlaying(false);
        setCur(0);
        onEnded?.();
      }}
      onError={() => {
        setFailed(true);
        setPlaying(false);
        setBuffering(false);
      }}
    />
  );

  const button = (
    <button
      type="button"
      className="pbtn"
      data-icon={icon}
      onClick={toggle}
      disabled={failed}
      aria-label={`${verb} ${label}`}
    >
      <span className="pbtn__ico pbtn__ico--play">
        <Play size={iconSize} weight="fill" />
      </span>
      <span className="pbtn__ico pbtn__ico--pause">
        <Pause size={iconSize} weight="fill" />
      </span>
      <span className="pbtn__ico pbtn__ico--load">
        <CircleNotch size={iconSize} weight="bold" className="spin" />
      </span>
    </button>
  );

  const rail = (
    <div
      ref={railRef}
      className={cx("scrub", drag !== null && "is-drag")}
      role="slider"
      tabIndex={failed ? -1 : 0}
      aria-label={`Progreso de ${label}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct * 100)}
      aria-valuetext={`${clock(shownTime)} de ${total}`}
      aria-disabled={failed || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={onKeyDown}
    >
      <span className="scrub__rail">
        <span className="scrub__fill" style={{ transform: `scaleX(${pct})` }} />
      </span>
      <span className="scrub__knob" style={{ left: `${pct * 100}%` }} />
    </div>
  );

  if (small) {
    return (
      <div
        ref={rootRef}
        className={cx("pv", active && "is-active", playing && "is-playing")}
      >
        {audio}
        {button}
        {rail}
        <span className="pv__time">{active ? clock(shownTime) : total}</span>
      </div>
    );
  }

  const quiet = muted || vol === 0;
  return (
    <div
      ref={rootRef}
      className={cx("pl", active && "is-active", playing && "is-playing", failed && "is-failed")}
      style={{ "--i": index }}
    >
      {audio}
      {button}
      <div className="pl__mid">
        <div className="pl__top">
          <span className="pl__title" title={title}>
            {title}
          </span>
          <span className="eq" aria-hidden="true" data-on={playing && !buffering ? "" : undefined}>
            <i />
            <i />
            <i />
          </span>
          <span className="pl__time">
            {clock(shownTime)} / {total}
          </span>
        </div>
        <div className="pl__meta" title={failed ? undefined : meta}>
          {failed ? "No se pudo reproducir este audio" : meta}
        </div>
        <div className="pl__bar">
          {rail}
          {/* El volumen solo existe en la fila activa: 31 filas con 31
              deslizadores serian ruido. Vive en la fila de la barra para que su
              aparicion no mueva el titulo. */}
          <div className="pl__vol" aria-hidden={!active}>
            <button
              type="button"
              className="pl__mute"
              tabIndex={active ? 0 : -1}
              onClick={toggleMute}
              aria-label={quiet ? "Activar el sonido" : "Silenciar"}
            >
              {quiet ? (
                <SpeakerSlash size={17} />
              ) : vol < 0.45 ? (
                <SpeakerLow size={17} />
              ) : (
                <SpeakerHigh size={17} />
              )}
            </button>
            <input
              type="range"
              className="vol"
              min={0}
              max={100}
              step={1}
              value={Math.round((quiet ? 0 : vol) * 100)}
              tabIndex={active ? 0 : -1}
              aria-label={`Volumen de ${label}`}
              style={{ "--v": `${Math.round((quiet ? 0 : vol) * 100)}%` }}
              onChange={onVolume}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   MINI-REPRODUCTOR

   La biblioteca ya no se desmonta al cerrarse (la musica sigue), pero entonces
   la cancion que suena queda sin controles: su fila esta oculta, o fuera de
   pantalla a mitad de scroll. Esta pastilla fija los devuelve. No tiene
   <audio> propio: se cuelga del elemento `current` y lo gobierna directamente,
   asi no hay una segunda fuente de verdad que pueda desincronizarse.

   Solo se ve cuando hace falta: hay una cancion empezada Y su Player no esta a
   la vista (cajon cerrado o fuera del viewport). Con la fila delante, los
   controles duplicados sobrarian. Si el usuario la cierra, se queda cerrada
   hasta el siguiente `play`.
   ------------------------------------------------------------------------- */

const MINI_IDLE = { playing: false, buffering: false, time: 0, dur: 0 };

function MiniPlayer({ libOpen, onReveal }) {
  const [, repaint] = useReducer((n) => n + 1, 0);
  const [st, setSt] = useState(MINI_IDLE);
  const [dismissed, setDismissed] = useState(false);
  /* true hasta que el IntersectionObserver diga lo contrario: mejor tardar un
     fotograma en aparecer que parpadear con la fila aun a la vista. */
  const [srcSeen, setSrcSeen] = useState(true);
  const [drag, setDrag] = useState(null);
  /* Portada que ya fallo al cargar: no se vuelve a pintar (icono roto). */
  const [badArt, setBadArt] = useState(null);
  const railRef = useRef(null);
  const lastInfo = useRef(null);

  useEffect(() => {
    watchers.add(repaint);
    return () => watchers.delete(repaint);
  }, []);

  const audio = current;
  const meta = audio ? audioMeta.get(audio) : null;
  /* Al desmontarse el Player se pierde su registro; se recuerda el ultimo para
     que el texto no se vacie mientras la pastilla se desvanece. */
  if (meta) lastInfo.current = meta;
  const info = meta || lastInfo.current;
  const srcEl = meta?.el ?? null;

  /* Espejo del estado del <audio> con sus eventos nativos. Layout effect: al
     cambiar de cancion el estado viejo no llega a pintarse. */
  useLayoutEffect(() => {
    setDismissed(false);
    setDrag(null);
    if (!audio) {
      setSt(MINI_IDLE);
      return undefined;
    }
    const sync = (buffering) =>
      setSt((p) => {
        const n = {
          playing: !audio.paused,
          buffering: buffering ?? p.buffering,
          time: audio.currentTime || 0,
          dur: Number.isFinite(audio.duration) ? audio.duration : 0,
        };
        return n.playing === p.playing &&
          n.buffering === p.buffering &&
          n.time === p.time &&
          n.dur === p.dur
          ? p
          : n;
      });
    const handlers = {
      play: () => {
        setDismissed(false);
        sync(audio.readyState < 3);
      },
      playing: () => sync(false),
      pause: () => sync(false),
      ended: () => sync(false),
      waiting: () => sync(true),
      emptied: () => sync(false),
      timeupdate: () => sync(),
      durationchange: () => sync(),
      loadedmetadata: () => sync(),
    };
    Object.entries(handlers).forEach(([n, h]) => audio.addEventListener(n, h));
    sync(!audio.paused && audio.readyState < 3);
    return () => {
      Object.entries(handlers).forEach(([n, h]) => audio.removeEventListener(n, h));
    };
  }, [audio]);

  /* Se observa la caja del Player de origen, no el audio. */
  useLayoutEffect(() => {
    if (!srcEl || typeof IntersectionObserver === "undefined") {
      setSrcSeen(false);
      return undefined;
    }
    setSrcSeen(true);
    const io = new IntersectionObserver(([e]) => setSrcSeen(e.isIntersecting), {
      threshold: 0,
    });
    io.observe(srcEl);
    return () => io.disconnect();
  }, [srcEl]);

  /* Con el cajon cerrado el IO tambien lo detecta (el recorte deja la fila en
     0), pero solo cuando termina de cerrarse. Esto lo adelanta al clic. */
  const inClosedDrawer = !libOpen && !!srcEl?.closest(".drawer");
  const started = st.playing || st.time > 0;
  const show = !!audio && started && !dismissed && (!srcSeen || inClosedDrawer);

  /* Reserva sitio en la pagina y aparta los avisos de descarga (CSS). */
  useEffect(() => {
    document.body.classList.toggle("has-mini", show);
    return () => document.body.classList.remove("has-mini");
  }, [show]);

  /* Teclas multimedia, auriculares y pantalla de bloqueo. Progresivo: sin la
     API no pasa nada. Los try/catch son porque cada navegador soporta un
     subconjunto de acciones y las que no conoce lanzan en vez de ignorarse. */
  useEffect(() => {
    if (!("mediaSession" in navigator) || !audio || !info) return undefined;
    const ms = navigator.mediaSession;
    try {
      if (typeof MediaMetadata !== "undefined") {
        ms.metadata = new MediaMetadata({
          title: info.title || "",
          artist: info.meta || "",
          /* Solo las filas de resultados traen portada; las de la biblioteca
             no, y ahi se omite en vez de mandar una lista vacia. */
          ...(info.artwork ? { artwork: [{ src: info.artwork, sizes: "300x300" }] } : {}),
        });
      }
    } catch {
      /* los metadatos son opcionales */
    }
    const actions = {
      play: () => audio.play().catch(() => {}),
      pause: () => audio.pause(),
      seekto: (d) => {
        if (typeof d?.seekTime === "number") audio.currentTime = d.seekTime;
      },
    };
    Object.entries(actions).forEach(([n, h]) => {
      try {
        ms.setActionHandler(n, h);
      } catch {
        /* accion no soportada */
      }
    });
    return () => {
      Object.keys(actions).forEach((n) => {
        try {
          ms.setActionHandler(n, null);
        } catch {
          /* idem */
        }
      });
      ms.metadata = null;
    };
  }, [audio, info]);

  const dur = st.dur || info?.duration || 0;
  const pct = drag !== null ? drag : dur ? clamp(st.time / dur, 0, 1) : 0;
  const shownTime = drag !== null ? drag * dur : st.time;
  const total = dur ? clock(Math.round(dur)) : "--:--";
  const icon = st.buffering ? "load" : st.playing ? "pause" : "play";
  const label = info?.label || "la canción";
  /* Leidos de `shared` en cada pintado: los watchers repintan al cambiar. */
  const quiet = shared.muted || shared.volume === 0;
  const volPct = Math.round((quiet ? 0 : shared.volume) * 100);
  const art = info?.artwork && badArt !== info.artwork ? info.artwork : null;

  const toggle = () => {
    if (!audio) return;
    if (audio.paused) {
      audio.volume = shared.volume;
      audio.muted = shared.muted;
      setSt((p) => ({ ...p, buffering: true }));
      /* Igual que en Player: AbortError no es un fallo del audio. */
      audio.play().catch(() => setSt((p) => ({ ...p, buffering: false })));
    } else {
      audio.pause();
    }
  };

  const seekTo = (t) => {
    const v = clamp(t, 0, dur || 0);
    if (audio && dur) audio.currentTime = v;
    setSt((p) => ({ ...p, time: v }));
  };

  const pctAt = (e) => {
    const r = railRef.current.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };
  const onPointerDown = (e) => {
    if (!dur) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(pctAt(e));
  };
  const onPointerMove = (e) => {
    if (drag !== null) setDrag(pctAt(e));
  };
  const onPointerUp = (e) => {
    if (drag === null) return;
    seekTo(pctAt(e) * dur);
    setDrag(null);
  };
  const onKeyDown = (e) => {
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      seekTo((audio?.currentTime ?? st.time) + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      seekTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      seekTo(dur - 1);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle();
    }
  };

  const close = () => {
    audio?.pause();
    setDismissed(true);
  };

  return (
    <section
      className={cx("mini", st.playing && "is-playing")}
      aria-label="Reproductor"
      data-state={show ? "open" : "closed"}
      aria-hidden={show ? undefined : true}
      inert={show ? undefined : ""}
    >
      <div className="mini__row">
        <button
          type="button"
          className="pbtn"
          data-icon={icon}
          onClick={toggle}
          aria-label={`${st.playing ? "Pausar" : "Reproducir"} ${label}`}
        >
          <span className="pbtn__ico pbtn__ico--play">
            <Play size={16} weight="fill" />
          </span>
          <span className="pbtn__ico pbtn__ico--pause">
            <Pause size={16} weight="fill" />
          </span>
          <span className="pbtn__ico pbtn__ico--load">
            <CircleNotch size={16} weight="bold" className="spin" />
          </span>
        </button>
        {art && (
          <img
            className="mini__art"
            src={art}
            alt=""
            loading="lazy"
            onError={() => setBadArt(art)}
          />
        )}
        {/* Tocar el titulo lleva a la cancion, como en cualquier app de musica.
            En movil es el UNICO camino (el boton de la mira se oculta para que
            el titulo quepa); fuera del orden de tabulacion porque con teclado
            ya esta ese boton. */}
        <button
          type="button"
          className="mini__txt"
          tabIndex={-1}
          onClick={() => onReveal(srcEl)}
          disabled={!srcEl}
          aria-label={`Ir a la canción: ${info?.title ?? ""}`}
        >
          <span className="mini__title" title={info?.title}>
            {info?.title}
          </span>
          <span className="mini__meta" title={info?.meta}>
            {info?.meta}
          </span>
        </button>
        {/* Silencio siempre; el deslizador solo con raton y pantalla ancha (CSS).
            En tactil manda el volumen del telefono. */}
        <div className="mini__vol">
          <button
            type="button"
            className="pl__mute"
            onClick={toggleSharedMute}
            aria-label={quiet ? "Activar el sonido" : "Silenciar"}
          >
            {quiet ? (
              <SpeakerSlash size={17} />
            ) : shared.volume < 0.45 ? (
              <SpeakerLow size={17} />
            ) : (
              <SpeakerHigh size={17} />
            )}
          </button>
          <input
            type="range"
            className="vol"
            min={0}
            max={100}
            step={1}
            value={volPct}
            aria-label="Volumen"
            style={{ "--v": `${volPct}%` }}
            onChange={(e) => setSharedVolume(Number(e.target.value) / 100)}
          />
        </div>
        <button
          type="button"
          className="mini__btn mini__btn--reveal"
          onClick={() => onReveal(srcEl)}
          disabled={!srcEl}
          aria-label="Ir a la canción"
          title="Ir a la canción"
        >
          <Crosshair size={18} />
        </button>
        <button
          type="button"
          className="mini__btn"
          onClick={close}
          aria-label="Cerrar reproductor"
          title="Cerrar reproductor"
        >
          <X size={18} />
        </button>
      </div>
      <div className="mini__bar">
        <div
          ref={railRef}
          className={cx("scrub", drag !== null && "is-drag")}
          role="slider"
          tabIndex={0}
          aria-label={`Progreso de ${label}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct * 100)}
          aria-valuetext={`${clock(shownTime)} de ${total}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDrag(null)}
          onKeyDown={onKeyDown}
        >
          <span className="scrub__rail">
            <span className="scrub__fill" style={{ transform: `scaleX(${pct})` }} />
          </span>
          <span className="scrub__knob" style={{ left: `${pct * 100}%` }} />
        </div>
        <span className="mini__time">
          {clock(shownTime)} / {total}
        </span>
      </div>
    </section>
  );
}

/* Etiqueta de estado: contorno fino del tono, icono y texto. Cada tono lleva el
   suyo (bien, solo preview, mal, sin veredicto) para que el estado no dependa
   solo del color. El `key` lo pone quien la usa: al cambiar de estado se
   remonta y repite su entrada. */
const CHIP_ICON = {
  ok: Check,
  warn: Headphones,
  bad: X,
  mute: Question,
};

function StatusChip({ tone, children }) {
  const Icon = CHIP_ICON[tone] || Question;
  return (
    <span className={`st st--${tone}`}>
      <Icon size={13} weight="bold" aria-hidden="true" />
      <span className="st__t">{children}</span>
    </span>
  );
}

/* La portada viene de iTunes y a veces no carga (o no existe). Sin onError el
   navegador pinta su icono roto de imagen. Con esto, si falla, sale el
   placeholder con la nota musical. */
function Artwork({ t }) {
  const [broken, setBroken] = useState(false);
  /* Las miniaturas de YouTube son 16:9: recortarlas a cuadrado se comia
     media imagen (y el texto que suelen llevar). */
  const video = t.source === "ytdlp";
  if (!t.artwork_url || broken) {
    return (
      <div className={cx("card__art card__art--ph", video && "card__art--video")} aria-hidden="true">
        <Waveform size={26} />
      </div>
    );
  }
  return (
    <img
      className={cx("card__art", video && "card__art--video")}
      src={t.artwork_url}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

/* De donde sale la FICHA y de donde sale el ARCHIVO. En modo Música no
   son la misma cosa: iTunes pone los datos y la portada, YouTube pone el
   audio que se descarga. Sin esto, "iTunes | 3:07" se lee como si el archivo
   entero fuera de iTunes, y es falso. */
function provenance(t) {
  const label = SOURCE_LABEL[t.source] || t.source;
  const ficha = label;
  const archivo = t.extra?.webpage_url ? SOURCE_LABEL.ytdlp : label;
  return { ficha, archivo, split: ficha !== archivo };
}

/* Arma la query contra /api/search respetando los comportamientos reales:
   - YouTube solo filtra con mode=ytdlp&source=ytdlp (mode solo no filtra).
   - mode=matched con un source degrada el emparejamiento, asi que la fuente
     ya no es un filtro del usuario: se deriva siempre del modo. */
function buildSearchParams(q, mode) {
  const p = new URLSearchParams();
  p.set("q", q);
  p.set("limit", "40");
  p.set("mode", mode);
  if (mode === "ytdlp") p.set("source", "ytdlp");
  return p;
}

const isTerminal = (j) =>
  j?.status === "done"
  || j?.status === "error"
  || j?.status === "timeout"
  || j?.status === "gone";

/* Sondea el progreso de una descarga yt-dlp hasta que termine.

   Devuelve el estado terminal, o { status: "timeout" } si se venció el tope.
   El tope existe porque el poll no puede colgar el navegador para siempre,
   pero una pista larga (un concierto de 114 min puede tardar 10 min en
   transcodificar) lo revienta sin que el usuario se entere de nada: el toast
   queda girando en "processing" para siempre. Con "timeout" el llamador puede
   al menos avisar que la descarga sigue corriendo en el servidor. */
async function pollJob(jobId, setJobFor, key, title) {
  for (let i = 0; i < 600; i++) {
    let d;
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(`${API}/download/progress/${jobId}`);
      d = await r.json();
    } catch (e) {
      // El server se cae o la red se corta: sin esto el rechazo sube sin
      // catch y el toast queda girando en "Descargando, N%" para siempre.
      // Se marca como fallido para que ProgressBar lo muestre y el aviso
      // se retire solo con el mismo temporizador que un final normal.
      const failed = { status: "error", error: "se perdió la conexión con el servidor" };
      setJobFor(key, { ...failed, title });
      return failed;
    }
    /* "unknown" es lo que devuelve el backend para un job que ya no existe
       (purgado por el TTL). Seguir sondeando 600 veces un job que no va a
       aparecer es trabajo perdido: se corta aca. */
    if (d.status === "unknown") {
      const gone = { status: "gone", error: "el servidor ya no tiene esta descarga" };
      setJobFor(key, { ...gone, title });
      return gone;
    }
    setJobFor(key, { ...d, title });
    if (d.status === "done" || d.status === "error") return d;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 700));
  }
  // El tope se vencio, pero la descarga puede seguir corriendo en el server:
  // NO se marca como error (eso diria "Falló" y seria falso). Se retira igual
  // el toast, asi que el useEffect de JOB_DISMISS_MS tiene que incluirlo.
  setJobFor(key, { status: "timeout", title });
  return { status: "timeout" };
}

/* Verificacion: lee los tags reales del audio y compara con lo buscado. */
function VerifyPanel({ t, query }) {
  const [state, setState] = useState("idle");
  const [data, setData] = useState(null);

  const verify = useCallback(async () => {
    setState("loading");
    try {
      const r = await fetch(
        `${API}/verify?q=${encodeURIComponent(query)}&source=${t.source}&source_id=${encodeURIComponent(
          t.source_id
        )}`
      );
      const d = await r.json();
      if (!r.ok) throw new Error(errMsg(d, "no se pudo verificar"));
      setData(d);
      setState("done");
    } catch (e) {
      setState("error");
      setData({ error: fetchErr(e, e.message) });
    }
  }, [t.source, t.source_id, query]);

  if (state === "idle") {
    return (
      <button className="vf" onClick={verify}>
        <Sparkle size={14} />
        ¿Es esta la canción?
      </button>
    );
  }
  if (state === "loading") {
    return (
      <button className="vf" onClick={verify} disabled aria-live="polite">
        <CircleNotch size={14} className="spin" />
        leyendo las etiquetas del audio
      </button>
    );
  }
  if (state === "error") {
    return (
      <button type="button" className="vf vf--retry" onClick={verify}>
        <WarningCircle size={14} />
        no pude verificar: {data?.error}. Reintentar
      </button>
    );
  }

  const m = data.extra || {};
  const tone = m.match === "match" ? "ok" : m.match === "partial" ? "warn" : m.match === "mismatch" ? "bad" : "mute";
  const norm = (x) => (x || "").trim().toLowerCase();
  /* El titulo del archivo solo se repite si NO es el de la tarjeta: cuando
     coincide, volver a escribirlo era ruido (salia tres veces en la misma
     tarjeta). Cuando no coincide es justo lo que hay que ver. */
  const otherTitle = m.real_title && norm(m.real_title) !== norm(t.title) ? m.real_title : null;
  const otherArtist = m.real_artist && norm(m.real_artist) !== norm(t.artist) ? m.real_artist : null;
  const specs = [m.format, fmtSize(m.size_mb), m.duration_s ? fmtTime(m.duration_s) : null].filter(Boolean);
  return (
    <section className="vfbox" aria-label="Verificación del archivo">
      <div className="vfbox__head">
        <StatusChip tone={tone} key={m.match || "unknown"}>
          {m.match_label || "Sin veredicto"}
        </StatusChip>
        {m.match_score != null && (
          <span className="vfbox__score">{Math.round(m.match_score * 100)}% de coincidencia</span>
        )}
      </div>
      <dl className="vfbox__facts">
        {(otherTitle || !m.real_title) && (
          <>
            <dt>En el archivo</dt>
            <dd className="vfbox__strong">{m.real_title || "sin título"}</dd>
          </>
        )}
        {otherArtist && (
          <>
            <dt>Artista</dt>
            <dd>{otherArtist}</dd>
          </>
        )}
        {m.filename && (
          <>
            <dt>Archivo</dt>
            <dd>
              <code>{m.filename}</code>
            </dd>
          </>
        )}
        {specs.length > 0 && (
          <>
            <dt>Audio</dt>
            <dd>{specs.join(" · ")}</dd>
          </>
        )}
        {m.uploader && (
          <>
            <dt>Subido por</dt>
            <dd>{m.uploader}</dd>
          </>
        )}
      </dl>
      {m.title_source === "item-title" && (
        <p className="vfbox__note">El archivo no trae etiquetas: el título viene de la ficha del item.</p>
      )}
      {m.item_url && (
        <ExtLink className="ext vfbox__link" url={m.item_url}>
          ver en Internet Archive <ArrowUpRight size={12} />
        </ExtLink>
      )}
    </section>
  );
}

const ShowGroup = React.memo(function ShowGroup({ t, query, onDownload, busyIds, downloadedIds }) {
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState(null);
  const [loading, setLoading] = useState(false);
  /* Error aparte de `tracks`: antes un fallo dejaba tracks = [] y al reabrir
     ya no se reintentaba nunca. */
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const ids = (t.extra?.item_ids || [t.source_id]).join(",");
      const r = await fetch(
        `${API}/setlist?source_ids=${encodeURIComponent(ids)}&q=${encodeURIComponent(query)}`
      );
      const d = await r.json();
      if (!r.ok) throw new Error(errMsg(d, "no se pudo leer el setlist"));
      setTracks(d.tracks);
    } catch (e) {
      setTracks(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [t.extra?.item_ids, t.source_id, query]);

  /* El setlist se queda montado una vez abierto: si se desmontara al cerrar no
     habria altura que animar. Antes de la primera apertura no existe. */
  const [everOpened, setEverOpened] = useState(false);

  const toggle = useCallback(() => {
    const n = !open;
    setOpen(n);
    if (n) setEverOpened(true);
    if (n && !tracks) load();
  }, [open, tracks, load]);

  const st = trackState(t);
  const prov = provenance(t);

  return (
    <li className="card card--wide">
      {t.artwork_url ? (
        <Artwork t={t} />
      ) : (
        <div className="card__art card__art--ph">
          <MusicNotes size={52} />
        </div>
      )}
      <div className="card__body">
        <div className="wide__head">
          <div className="wide__titles">
            <h3 className="card__title card__title--lg">{t.title}</h3>
            <p className="card__sub">{[t.artist, t.year].filter(Boolean).join(", ")}</p>
          </div>
          <StatusChip tone={STATE_UI[st].tone} key={st}>
            {STATE_UI[st].label}
          </StatusChip>
        </div>
        <div className="card__facts">
          <span className="meta">
            Concierto en vivo, {t.extra?.track_count || 1} pistas
          </span>
          <span className="src">{prov.archivo}</span>
          <ExtLink className="ext" url={t.extra?.item_url}>
            procedencia <ArrowUpRight size={12} />
          </ExtLink>
        </div>
        <button className="disclosure" onClick={toggle} aria-expanded={open}>
          <CaretRight size={13} className="disclosure__caret" />
          <ListBullets size={13} />
          {open ? "ocultar las canciones" : "ver qué canciones hay"}
        </button>

        {everOpened && (
          <div className="fold" data-open={open ? "" : undefined} inert={open ? undefined : ""}>
            <div className="fold__in">
              <ul className="setlist">
                {loading && <li className="tr tr--dim">leyendo las etiquetas de cada pista</li>}
                {!loading && error && (
                  <li className="tr tr--dim">
                    no pude leer las pistas
                    <button type="button" className="vf vf--retry" onClick={load}>
                      Reintentar
                    </button>
                  </li>
                )}
                {!loading && tracks && tracks.length === 0 && (
                  <li className="tr tr--dim">no pude leer las pistas</li>
                )}
                {tracks?.map((s, n) => {
                  const tone =
                    s.match === "match"
                      ? "ok"
                      : s.match === "partial"
                      ? "warn"
                      : s.match === "mismatch"
                      ? "bad"
                      : "mute";
                  const otherArtist = s.real_artist && s.real_artist !== t.artist;
                  return (
                    <li className="tr" key={s.source_id} style={{ "--i": n }}>
                      <span className="tr__n">{String(n + 1).padStart(2, "0")}</span>
                      <div className="tr__main">
                        <div className="tr__title">{s.real_title || s.filename}</div>
                        {(otherArtist || s.format || fmtSize(s.size_mb)) && (
                          <div className="tr__meta">
                            {otherArtist && <span>{s.real_artist}</span>}
                            {s.format && <span>{s.format}</span>}
                            {fmtSize(s.size_mb) && <span>{fmtSize(s.size_mb)}</span>}
                          </div>
                        )}
                      </div>
                      <div className="tr__info">
                        <StatusChip tone={tone} key={s.match || "unknown"}>
                          {s.match_label || "?"}
                        </StatusChip>
                        <span className="meta">{fmtTime(s.duration_s)}</span>
                      </div>
                      <button
                        className="dl dl--sm"
                        disabled={busyIds.has(rowKey(s))}
                        onClick={() => onDownload(s)}
                        title={
                          downloadedIds.has(rowKey(s))
                            ? "Descargado: pulsa para volver a descargarlo"
                            : "Descargar a la biblioteca"
                        }
                        aria-label={
                          downloadedIds.has(rowKey(s))
                            ? `Descargado: ${s.real_title || s.filename}`
                            : `Descargar ${s.real_title || s.filename}`
                        }
                      >
                        {busyIds.has(rowKey(s)) ? (
                          <span className="swap" key="busy">
                            <CircleNotch size={16} className="spin" />
                          </span>
                        ) : downloadedIds.has(rowKey(s)) ? (
                          <span className="swap" key="done">
                            <Check size={16} weight="bold" />
                          </span>
                        ) : (
                          <span className="swap" key="idle">
                            <DownloadSimple size={16} weight="bold" />
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
      </div>
    </li>
  );
});

/* Un toast por descarga en curso. Con dos a la vez se apilan en columna: el
   primero se apila pegado al borde inferior. Cada uno se retira solo a los 5 s
   de terminar, con su propio temporizador. */
function ProgressStack({ jobs }) {
  const lista = Object.values(jobs || {});
  const varios = lista.length > 1;
  /* Siempre montado: una region viva que aparece junto con su contenido no se
     anuncia de forma fiable. Vacia no pinta nada. */
  return (
    <div className={`progstack ${varios ? "is-multi" : ""}`} aria-live="polite">
      {lista.map((j, i) => (
        <ProgressBar key={j.key || j.title + i} job={j} />
      ))}
    </div>
  );
}

function ProgressBar({ job }) {
  if (!job) return null;
  const pct = Math.round(job.progress || 0);
  const done = job.status === "done";
  const failed = job.status === "error";
  /* El tope de espera se vencio o el job ya no existe: no fallo, pero tampoco
     se puede seguir mirando. No es "descargando" porque ya no lo sabemos. */
  const halted = job.status === "timeout" || job.status === "gone";
  const shown = done ? 100 : Math.max(pct, 2);
  return (
    <div
      className={`prog ${done ? "is-done" : ""} ${failed || halted ? "is-failed" : ""}`}
      style={{ "--dismiss": `${JOB_DISMISS_MS}ms` }}
    >
      <div className="prog__top">
        <span className="prog__ico">
          {failed || halted ? (
            <WarningCircle size={19} weight="fill" />
          ) : done ? (
            <CheckCircle size={19} weight="fill" />
          ) : (
            <CircleNotch size={19} className="spin" />
          )}
        </span>
        <span className="prog__title">{job.title}</span>
        {/* El porcentaje cambia cada ~700 ms: solo se anuncian los estados finales. */}
        <span className="prog__state" aria-hidden={done || failed || halted ? undefined : true}>
          {failed
            ? "Falló la descarga"
            : done
            ? "Listo, está en tu biblioteca"
            : halted
            ? job.status === "gone"
              ? "El servidor ya no tiene esta descarga"
              : "Sigue descargando en el servidor"
            : job.status === "pending"
            ? "En cola"
            : `Descargando, ${pct}%`}
        </span>
      </div>
      <div
        className="prog__bar"
        role="progressbar"
        aria-label="Progreso de la descarga"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={done ? 100 : pct}
      >
        <div className="prog__fill" style={{ transform: `scaleX(${shown / 100})` }} />
      </div>
    </div>
  );
}

const Track = React.memo(function Track({
  t,
  query,
  onDownload,
  busy,
  downloaded,
  index,
}) {
  const st = trackState(t);
  const ui = STATE_UI[st];
  const dur = t.duration_s ? fmtTime(t.duration_s) : null;
  const size = fmtSize(t.extra?.size_mb);
  const web = t.extra?.webpage_url;
  const prov = provenance(t);

  return (
    <li className="card" style={{ "--i": index ?? 0 }}>
      {t.artwork_url ? (
        <Artwork t={t} />
      ) : (
        <div className="card__art card__art--ph">
          <MusicNotes size={44} />
        </div>
      )}
      <div className="card__body">
        <h3 className="card__title">{t.title || "sin título"}</h3>
        <p className="card__sub">
          {t.artist || "artista desconocido"}
          {t.album && t.album !== t.title ? `, ${t.album}` : ""}
          {t.year ? `, ${t.year}` : ""}
        </p>
        <div className="card__prov">
          {prov.split ? (
            <>
              <span className="src">ficha: {prov.ficha}</span>
              <span className="sep" />
              <span className="src">archivo: {prov.archivo}</span>
            </>
          ) : (
            <span className="src">{prov.archivo}</span>
          )}
        </div>
        <div className="card__facts">
          {dur && <span className="meta">{dur}</span>}
          {dur && size && <span className="meta meta--mute">/</span>}
          {size && <span className="meta">{size}</span>}
          {t.extra?.format && <span className="meta">{t.extra.format}</span>}
          <ExtLink className="ext" url={web}>
            vídeo <ArrowUpRight size={12} />
          </ExtLink>
          <ExtLink className="ext" url={t.extra?.item_url}>
            procedencia <ArrowUpRight size={12} />
          </ExtLink>
        </div>
        {t.preview_url && (
          <Player
            variant="compact"
            src={t.preview_url}
            label={`el preview de ${t.title || "este resultado"}`}
            title={t.title || "sin título"}
            meta={`${t.artist || "artista desconocido"} · preview de 30 s`}
            duration={30}
            artwork={t.artwork_url}
          />
        )}
        {t.source === "archive" && <VerifyPanel t={t} query={query} />}
        <div className="card__foot">
          <StatusChip tone={ui.tone} key={st}>
            {ui.label}
          </StatusChip>
          {st === "full" ? (
            <button
              className="dl"
              disabled={busy}
              onClick={() => onDownload(t)}
              title={
                downloaded
                  ? "Descargado: pulsa para volver a descargarlo"
                  : "Descargar a la biblioteca"
              }
              aria-label={
                downloaded
                  ? `Descargado: ${t.title || "este resultado"}`
                  : `Descargar ${t.title || "este resultado"}`
              }
            >
              {busy ? (
                <span className="swap" key="busy">
                  <CircleNotch size={19} className="spin" />
                </span>
              ) : downloaded ? (
                <span className="swap" key="done">
                  <Check size={19} weight="bold" />
                </span>
              ) : (
                <span className="swap" key="idle">
                  <DownloadSimple size={19} weight="bold" />
                </span>
              )}
            </button>
          ) : (
            <>
              {/* Texto visible (tactil y teclado no tienen tooltip). Ya lo lee
                  el lector de pantalla, asi que el icono se oculta para no
                  anunciarlo dos veces. */}
              <span className="nodl" title={NODL_TITLE[st]}>
                {NODL_TITLE[st]}
              </span>
              <span className="dl dl--off" aria-hidden="true">
                <Prohibit size={19} />
              </span>
            </>
          )}
        </div>
      </div>
    </li>
  );
});

/* Esqueleto con la forma real de una tarjeta, nunca un spinner generico. */
function SkeletonRow({ i }) {
  return (
    <li className="card skel skel--pulse" style={{ "--i": i }} aria-hidden="true">
      <div className="skel__art" />
      <div className="skel__body">
        <div className="skel__t" />
        <div className="skel__m" />
        <div className="skel__foot">
          <div className="skel__chip" />
          <div className="skel__btn" />
        </div>
      </div>
    </li>
  );
}

/* Selector de formato. Son tres opciones cortas: un desplegable del sistema
   ocupa media pantalla para mostrar tres palabras, asi que va segmentado y a
   la vista, en la segunda fila del panel de busqueda, junto al modo. Radiogroup
   real, navegable con flechas (roving tabindex) y con el valor actual siempre
   visible. La etiqueta "Formato" es solo visual: el nombre accesible ya lo
   lleva el radiogroup. */
function FmtPicker({ value, onChange }) {
  const refs = useRef([]);
  const segsRef = useRef(null);
  useSlidingPill(segsRef, value);
  const current = Math.max(
    0,
    FORMATS.findIndex((f) => f.value === value)
  );

  const move = (next) => {
    const i = (next + FORMATS.length) % FORMATS.length;
    onChange(FORMATS[i].value);
    refs.current[i]?.focus();
  };

  return (
    <div className="fmts">
      <span className="fmts__lbl" aria-hidden="true">
        Formato
      </span>
      <div
        ref={segsRef}
        className="segs"
        role="radiogroup"
        aria-label="Formato de descarga"
      >
        {FORMATS.map((f, i) => (
          <button
            key={f.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === f.value}
            tabIndex={value === f.value ? 0 : -1}
            title={f.title}
            className={`seg ${value === f.value ? "is-on" : ""}`}
            onClick={() => onChange(f.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(current + 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(current - 1);
              } else if (e.key === "Home") {
                e.preventDefault();
                move(0);
              } else if (e.key === "End") {
                e.preventDefault();
                move(FORMATS.length - 1);
              }
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* El selector de modo es el mismo componente visual que el de formato (.seg) y
   comparte rol, asi que comparte tambien el patron: radiogroup navegable con
   flechas y roving tabindex. Sin esto el patron ARIA prometia flechas que no
   existian, y el teclado necesitaba tres tab stops para recorrer tres modos. */
function ModePicker({ value, onChange, ytDead }) {
  const refs = useRef([]);
  const segsRef = useRef(null);
  useSlidingPill(segsRef, value);
  const current = Math.max(
    0,
    MODES.findIndex((m) => m.id === value)
  );

  const move = (next) => {
    const i = (next + MODES.length) % MODES.length;
    onChange(MODES[i].id);
    refs.current[i]?.focus();
  };

  return (
    <div ref={segsRef} className="segs" role="radiogroup" aria-label="Modo de búsqueda">
      {MODES.map((m, i) => (
        <button
          key={m.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === m.id}
          tabIndex={value === m.id ? 0 : -1}
          className={[
            "seg",
            value === m.id ? "is-on" : "",
            m.id === "ytdlp" && ytDead ? "mode--dead" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => onChange(m.id)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              move(current + 1);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              move(current - 1);
            } else if (e.key === "Home") {
              e.preventDefault();
              move(0);
            } else if (e.key === "End") {
              e.preventDefault();
              move(MODES.length - 1);
            }
          }}
          title={
            m.id === "ytdlp" && ytDead
              ? "YouTube está apagado en este servidor: no devolverá resultados"
              : undefined
          }
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/* Filtro de resultados. Es un componente aparte (y no JSX en App) porque el
   grupo solo existe cuando hay resultados: el hook de la pastilla deslizante
   tiene que montarse con el, no con App. */
function FilterSegs({ filter, onChange, total, full }) {
  const ref = useRef(null);
  useSlidingPill(ref, filter);
  return (
    <div ref={ref} className="segs" role="group" aria-label="Filtrar resultados">
      <button
        type="button"
        className={`seg ${filter === "all" ? "is-on" : ""}`}
        aria-pressed={filter === "all"}
        onClick={() => onChange("all")}
      >
        Todos <span className="seg__n">{total}</span>
      </button>
      <button
        type="button"
        className={`seg ${filter === "full" ? "is-on" : ""}`}
        aria-pressed={filter === "full"}
        onClick={() => onChange("full")}
      >
        Descarga completa <span className="seg__n">{full}</span>
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   DONDE VIVE LA BIBLIOTECA
   Modal de "Conectar servicio": dos tarjetas (este dispositivo / Google Drive)
   y, con Drive activo, la barra de espacio segmentada (Spitifo, otros, libre).
   El backend hace el sign-in: abre el navegador del sistema y espera el
   redirect. Aca solo se arranca, se sondea mientras esta pendiente y se
   muestra el estado. Ver docs/adr/0002-user-owned-storage.md.
   ------------------------------------------------------------------------- */
const IS_ANDROID = /android/i.test(navigator.userAgent);

/* Los mensajes del flujo vienen del backend en ingles y estables: se traducen
   aca para no mostrar texto crudo. */
function connectErrorText(error) {
  if (!error) return null;
  if (/cancel/i.test(error)) return "Cancelaste el inicio de sesión.";
  if (/timed out/i.test(error)) return "El navegador tardó demasiado. Vuelve a intentarlo.";
  return "No se pudo conectar con Google Drive. Vuelve a intentarlo.";
}

/* Por debajo de 1 GB va en MB: una biblioteca recien empezada en "0 GB"
   parece vacia aunque ya tenga temas. */
function fmtGB(bytes) {
  const gb = bytes / 1024 ** 3;
  if (gb < 1) {
    const mb = bytes / 1024 ** 2;
    return `${mb.toLocaleString("es-ES", { maximumFractionDigits: mb < 10 ? 1 : 0 })} MB`;
  }
  return `${gb.toLocaleString("es-ES", { maximumFractionDigits: gb < 100 ? 1 : 0 })} GB`;
}

function QuotaBar({ quota }) {
  if (!quota) return null;
  const { limit, usage, app } = quota;
  const others = Math.max(0, usage - app);
  if (!limit) {
    return (
      <div className="quota">
        <p className="quota__legend">Espacio sin límite · Spitifo ocupa {fmtGB(app)}</p>
      </div>
    );
  }
  const free = Math.max(0, limit - usage);
  const pct = (n) => `${Math.min(100, (n / limit) * 100)}%`;
  return (
    <div className="quota">
      <div
        className="quota__bar"
        role="img"
        aria-label={`Spitifo ${fmtGB(app)}, otros archivos ${fmtGB(others)}, libres ${fmtGB(free)} de ${fmtGB(limit)}`}
      >
        <span className="quota__app" style={{ width: pct(app) }} />
        <span className="quota__other" style={{ width: pct(others) }} />
      </div>
      <ul className="quota__legend" aria-hidden="true">
        <li><span className="quota__key quota__key--app" />Spitifo {fmtGB(app)}</li>
        <li><span className="quota__key quota__key--other" />Otros {fmtGB(others)}</li>
        <li>Libre {fmtGB(free)}</li>
      </ul>
    </div>
  );
}

function StorageDialog({ open, onClose, onChanged }) {
  const ref = useRef(null);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [authUrl, setAuthUrl] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/storage`);
      if (!r.ok) throw new Error(String(r.status));
      setInfo(await r.json());
      setErr(null);
    } catch (e) {
      setErr(fetchErr(e, "No se pudo leer dónde está tu biblioteca."));
    }
  }, []);

  /* <dialog> nativo: showModal da foco atrapado, Escape y fondo inerte. */
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      load();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open, load]);

  /* Mientras el sign-in esta pendiente se sondea; al conectar, la biblioteca
     cambia sola en el backend y la app tiene que recargarla. */
  const pending = info?.connect?.state === "pending";
  const wasPending = useRef(false);
  useEffect(() => {
    if (!open || !pending) return undefined;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [open, pending, load]);
  useEffect(() => {
    if (wasPending.current && !pending) {
      setAuthUrl(null);
      if (info?.connect?.state === "connected") onChanged();
    }
    wasPending.current = pending;
  }, [pending, info, onChanged]);

  const post = useCallback(
    async (path, body) => {
      setBusy(true);
      setErr(null);
      try {
        const r = await fetch(`${API}/storage/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          setErr(
            d.code === "not_configured"
              ? "Google Drive no está disponible en esta versión."
              : "No se pudo completar. Vuelve a intentarlo."
          );
          return null;
        }
        return d;
      } catch (e) {
        setErr(fetchErr(e, "No se pudo completar. Vuelve a intentarlo."));
        return null;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const google = info?.providers?.find((p) => p.id === "google");
  const active = info?.active;
  const locked = Boolean(info?.override);

  const pickLocal = async () => {
    if (active === "local" || locked) return;
    if (await post("use", { provider: "local" })) {
      await load();
      onChanged();
    }
  };

  const pickDrive = async () => {
    if (!google?.configured || locked || pending) return;
    if (google.connected) {
      if (active === "google") return;
      if (await post("use", { provider: "google" })) {
        await load();
        onChanged();
      }
      return;
    }
    const d = await post("connect", { provider: "google" });
    if (d) {
      setAuthUrl(d.auth_url);
      await load();
    }
  };

  const cancel = async () => {
    await post("connect/cancel");
    setAuthUrl(null);
    load();
  };

  const disconnect = async () => {
    if (await post("disconnect", { provider: "google" })) {
      await load();
      onChanged();
    }
  };

  const connectErr = connectErrorText(info?.connect?.error);
  const DeviceIcon = IS_ANDROID ? DeviceMobile : Laptop;

  let driveSub;
  if (!info) driveSub = " ";
  else if (!google?.configured) driveSub = "No disponible en esta versión";
  else if (pending) driveSub = (
    <span className="store__state">
      <CircleNotch size={14} className="spin" aria-hidden="true" />
      Esperando al navegador…
    </span>
  );
  else if (google.connected) driveSub = (
    <span className="store__state">
      <span className="store__dot" aria-hidden="true" />
      Conectada
    </span>
  );
  else driveSub = "Conecta tu cuenta";

  return (
    <dialog
      ref={ref}
      className="store"
      aria-labelledby="store-title"
      onClose={onClose}
      onClick={(e) => {
        /* Click en el fondo (el propio <dialog>, fuera de la tarjeta) cierra. */
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="store__card">
        <div className="store__head">
          <h2 id="store-title" className="store__title">¿Dónde guardas tu música?</h2>
          <button type="button" className="store__x" aria-label="Cerrar" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="store__opts" role="radiogroup" aria-labelledby="store-title">
          <button
            type="button"
            role="radio"
            aria-checked={active === "local"}
            className="store__opt"
            onClick={pickLocal}
            disabled={busy}
          >
            <DeviceIcon size={24} weight="duotone" className="store__icon" aria-hidden="true" />
            <span className="store__name">Este dispositivo</span>
            <span className="store__sub">Sin conexión, solo aquí</span>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked={active === "google"}
            aria-disabled={!google?.configured || undefined}
            className="store__opt"
            onClick={pickDrive}
            disabled={busy}
          >
            <GoogleDriveLogo size={24} weight="duotone" className="store__icon" aria-hidden="true" />
            <span className="store__name">Google Drive</span>
            <span className="store__sub">{driveSub}</span>
          </button>
        </div>

        {pending && (
          <p className="store__note">
            Termina de iniciar sesión en el navegador.{" "}
            {authUrl && (
              <a href={authUrl} target="_blank" rel="noreferrer">
                Abrir de nuevo
              </a>
            )}
            <button type="button" className="store__link" onClick={cancel}>
              Cancelar
            </button>
          </p>
        )}

        {active === "google" && <QuotaBar quota={info?.quota} />}

        {locked && (
          <p className="store__note">Fijado por SPITIFO_STORAGE: se cambia desde el entorno.</p>
        )}
        {(err || connectErr) && (
          <p className="store__err" role="alert">
            {err || connectErr}
          </p>
        )}

        <div className="store__foot">
          {google?.connected && !locked && (
            <button type="button" className="store__link" onClick={disconnect} disabled={busy}>
              Desconectar Google Drive
            </button>
          )}
          <button type="button" className="store__done" onClick={onClose}>
            Listo
          </button>
        </div>
      </div>
    </dialog>
  );
}

function App() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  const [health, setHealth] = useState(null);
  const [fmt, setFmt] = useState("mp3");
  const [filter, setFilter] = useState("all");
  const [libOpen, setLibOpen] = useState(false);
  const drawerRef = useRef(null);
  const libBtnRef = useRef(null);
  /* null = todavia no lo sabemos. Distinguir "vacia" de "sin consultar" importa:
     sin esto el boton arrancaria atenuado y el contador no apareceria hasta
     abrir el panel, que es justo cuando ya no hace falta. */
  const [lib, setLib] = useState(null);
  /* `busyId` era un unico string: con dos descargas en curso la segunda
     escribia su clave encima de la primera, y el setBusyId(null) del finally
     de la una apagaba el spinner de la otra. Ahora es un Set con TODAS las
     claves en curso: cada fila enciende y apaga su spinner sin tocar el de
     las demas. */
  const [busyIds, setBusyIds] = useState(() => new Set());
  /* Claves de lo que ya se bajo en esta sesion: la tarjeta lo marca con un
     check (sigue siendo pulsable para volver a descargar). */
  const [downloadedIds, setDownloadedIds] = useState(() => new Set());
  /* Un solo `job` tambien se pisaba entre descargas simultaneas. Ahora es un
     mapa clave -> job, y ProgressBar dibuja uno por descarga en curso. */
  const [jobs, setJobs] = useState({});
  const [mode, setMode] = useState("matched");
  const [searched, setSearched] = useState(false);
  /* true = /api/library fallo y todavia no hay lista que mostrar. */
  const [libErr, setLibErr] = useState(false);
  /* La lupa orbita mientras busca. Al llegar la respuesta NO se corta: sigue
     hasta cerrar la vuelta en curso (la orbita empieza y acaba en reposo), asi
     que se detiene sin saltar. El timeout es la red de seguridad para
     prefers-reduced-motion, donde no hay animacion ni evento que esperar. */
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    if (loading) {
      setScanning(true);
      return undefined;
    }
    const id = setTimeout(() => setScanning(false), 1500);
    return () => clearTimeout(id);
  }, [loading]);

  const [theme, chooseTheme] = useTheme();
  const dark = theme === "dark";

  const inputRef = useRef();
  const lastSig = useRef("");
  const searchSeq = useRef(0);
  const searchAbort = useRef(null);
  /* Aviso (error o exito) visible en cada momento: se usa para traerlo a
     pantalla si una descarga lejana lo deja fuera de vista. */
  const msgRef = useRef(null);
  /* Foco tras pulsar un ejemplo: el boton se desmonta al buscar y el foco caia
     al <body>. `focusPending` lo marca runExample; `resultsRef` es la cabecera
     de resultados (o el bloque de "sin resultados"). */
  const focusPending = useRef(false);
  const resultsRef = useRef(null);


  const loadHealth = useCallback(() => {
    fetch(`${API}/health`)
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);
  useEffect(loadHealth, [loadHealth]);
  const [storageOpen, setStorageOpen] = useState(false);

  /* Un job terminal (done/error/timeout/gone) se retira solo a los 5 s. Con
     varias descargas en curso cada uno tiene su propio temporizador: el de la
     primera no puede borrar el toast de la segunda, que es justo lo que
     pasaba antes. */
  const dismissTimers = useRef(new Map());
  useEffect(() => {
    /* Un temporizador POR job, creado una sola vez cuando el job pasa a
       terminal. Antes habia uno global que se reiniciaba en cada cambio de
       `jobs`: con otra descarga todavia sondeando (un tick cada 700 ms) el
       toast ya terminado no se retiraba nunca, y el CSS de salida (que cuenta
       los mismos 5 s) lo dejaba invisible pero ocupando su hueco en la pila. */
    Object.entries(jobs).forEach(([k, j]) => {
      if (!isTerminal(j) || dismissTimers.current.has(k)) return;
      dismissTimers.current.set(
        k,
        setTimeout(() => {
          dismissTimers.current.delete(k);
          setJobs((cur) => {
            /* Si la misma cancion se volvio a bajar en estos 5 s, el job ya no
               es terminal y NO se toca: no se le retira una descarga viva. */
            if (!isTerminal(cur[k])) return cur;
            const next = { ...cur };
            delete next[k];
            return next;
          });
        }, JOB_DISMISS_MS)
      );
    });
  }, [jobs]);

  useEffect(() => {
    const timers = dismissTimers.current;
    return () => timers.forEach((id) => clearTimeout(id));
  }, []);

  /* Actualiza UN job sin tocar los demas. El setJob viejo pisaba el estado
     entero en cada tick del polling. */
  const setJobFor = useCallback((key, patch) => {
    setJobs((cur) => ({ ...cur, [key]: { ...cur[key], ...patch, key } }));
  }, []);

  /* La franja de exito/aviso (.msg) NO se retiraba nunca: se quedaba en
     pantalla hasta que otra accion la limpiara, mientras el toast de progreso
     si se va solo a los 5 s. Se usa el mismo temporizador.

     NO se retira el aviso de ERROR ni el de "esto no es lo que buscabas": esos
     son informacion que el usuario necesita leer, y desaparecen al buscar de
     nuevo o al descargar otra cosa (setDone(null) / setErr(null) en
     onDownload). */
  useEffect(() => {
    if (!done || done.warning) return undefined;
    const id = setTimeout(() => setDone(null), JOB_DISMISS_MS);
    return () => clearTimeout(id);
  }, [done]);

  /* Un fallo/exito de descarga desde una tarjeta lejana pintaba el aviso bajo
     el hero, fuera de vista. Solo se hace scroll si de verdad esta fuera. */
  useEffect(() => {
    if (!err && !done) return;
    const el = msgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    /* 72 px: la barra sticky tapa la parte de arriba. */
    if (r.top >= 72 && r.bottom <= window.innerHeight) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [err, done]);

  /* Atajos: Escape cierra la biblioteca; "/" lleva el foco al buscador salvo
     que ya se este escribiendo en algo. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && libOpen) {
        /* El foco se mueve ANTES de cerrar: el cajon cerrado es `inert` y, con
           el foco dentro, se perderia en el <body>. */
        if (drawerRef.current?.contains(document.activeElement)) libBtnRef.current?.focus();
        setLibOpen(false);
        return;
      }
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const a = document.activeElement;
      if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [libOpen]);

  /* Una sola funcion de busqueda, con el texto y el modo que llegan POR
     PARAMETRO. Asi el form, los ejemplos de la pantalla vacia y el resync
     automatico comparten exactamente el mismo camino, y no importa que el
     setState de mode todavia no haya pegado cuando se la llama. */
  const runSearch = useCallback(async (text, m) => {
    const t = text.trim();
    if (!t) return;
    /* Cada busqueda toma un numero. Dos overlapping (o el resync)(devuelven
       en cualquier orden: si la lenta llega despues no puede pisar a la que
       el usuario acaba de pedir, ni la URL, ni disparar una tercera peticion
       con el setQuery de la respuesta vieja. */
    const seq = ++searchSeq.current;
    lastSig.current = `${m}|${t}`;
    setLoading(true);
    setErr(null);
    setDone(null);
    setSearched(true);
    setFilter("all");
    const params = buildSearchParams(t, m);
    /* La busqueda anterior, si sigue en vuelo, se cancela. */
    searchAbort.current?.abort();
    const ac = new AbortController();
    searchAbort.current = ac;
    try {
      const r = await fetch(`${API}/search?${params.toString()}`, { signal: ac.signal });
      const d = await r.json();
      if (!r.ok) throw new Error(errMsg(d, "error de búsqueda"));
      if (seq !== searchSeq.current) return;
      setResults(d.results || []);
      setQuery(t);
    } catch (e) {
      if (e.name === "AbortError" || seq !== searchSeq.current) return;
      setErr(e.message);
      setResults([]);
    } finally {
      if (seq === searchSeq.current) setLoading(false);
    }
  }, []);

  const doSearch = useCallback(
    (e) => {
      e?.preventDefault();
      /* Una busqueda manual no debe heredar un foco pendiente de un ejemplo. */
      focusPending.current = false;
      /* Pegar un enlace en otro modo lleva a "YouTube": es el unico que
         lo entiende. runSearch fija la firma, asi que el efecto de cambio de
         modo no repite la peticion. */
      const m = isYouTubeUrl(q) ? "ytdlp" : mode;
      if (m !== mode) setMode(m);
      runSearch(q, m);
      /* En movil se baja el teclado para ver los resultados. */
      if (window.matchMedia("(pointer: coarse)").matches) inputRef.current?.blur();
    },
    [q, mode, runSearch]
  );

  const runExample = useCallback(
    (text) => {
      setQ(text);
      focusPending.current = true;
      runSearch(text, mode);
    },
    [mode, runSearch]
  );

  /* Se espera a que la busqueda termine: antes no hay nada donde poner el
     foco. Va a la cabecera de resultados (o al aviso de error / sin
     resultados), nunca al input, que abriria el teclado en movil. */
  useEffect(() => {
    if (!focusPending.current || loading || !searched) return;
    focusPending.current = false;
    (resultsRef.current || msgRef.current)?.focus();
  }, [loading, searched, results, err]);

  /* Cambiar de modo tiene que volver a consultar la API, no solo repintar el
     control. La firma evita el loop: si la peticion que corresponde al modo
     actual ya se ejecuto, no se repite. Tambien evita el doble fetch del
     arranque, que setea la misma firma. */
  useEffect(() => {
    if (!searched || !query) return;
    const sig = `${mode}|${query}`;
    if (sig === lastSig.current) return;
    runSearch(query, mode);
  }, [mode, searched, query, runSearch]);

  const onDownload = useCallback(
    async (t) => {
      /* Todo el estado de ESTA descarga queda bajo su clave. Con dos a la vez
         cada una enciende su spinner, tiene su toast y anuncia su resultado
         sin pisar a la otra. `err`/`done` siguen siendo globales a proposito:
         son el ultimo mensaje de la pantalla, no uno por fila. */
      const key = rowKey(t);
      const markDownloaded = () => setDownloadedIds((cur) => new Set(cur).add(key));
      setBusyIds((cur) => new Set(cur).add(key));
      setErr(null);
      setDone(null);
      try {
        let track = { ...t };
        delete track.downloadable;
        // Las pistas del setlist ya vienen resueltas por /api/setlist.
        // En modo "matched" el video de YouTube ya viene en webpage_url:
        // no hay nada que resolver, la descarga va directo a yt-dlp.
        const isMatched = t.source === "itunes" && t.extra?.webpage_url;
        if (
          !track.audio_url &&
          !isMatched &&
          t.source !== "ytdlp" &&
          t.extra?.needs_resolve
        ) {
          const rr = await fetch(
            `${API}/resolve?query=${encodeURIComponent(query)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(track),
            }
          );
          if (!rr.ok) {
            const d = await rr.json();
            throw new Error(errMsg(d, "no se pudo resolver"));
          }
          track = await rr.json();
          delete track.downloadable;
        }
        // /api/setlist devuelve el veredicto en la raiz, /api/resolve en extra
        const vmatch = t.match || track.extra?.match || track.match;
        const vtitle = t.real_title || track.extra?.real_title || track.real_title;
        const rd = await fetch(
          `${API}/download?query=${encodeURIComponent(query)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: track.source, track, fmt }),
          }
        );
        const j = await rd.json();
        if (!rd.ok) throw new Error(errMsg(j, "falló la descarga"));

        // yt-dlp devuelve job_id: la descarga corre en background, hacer polling
        if (j.job_id) {
          setJobFor(key, { status: "pending", progress: 0, title: t.title });
          const finished = await pollJob(j.job_id, setJobFor, key, t.title);
          if (finished?.status === "timeout" || finished?.status === "gone") {
            setErr(
              finished.error
                || "Esta descarga sigue corriendo en el servidor y va a aparecer en tu biblioteca cuando termine."
            );
          } else if (finished) {
            if (finished.status === "error") {
              setErr(finished.error || "la descarga falló");
            } else {
              // El veredicto lo publica el backend DENTRO del job (lo calcula
              // en download contra el titulo real del video). Antes este
              // camino hacia `return` y el `match` nunca llegaba a la UI.
              const d = {
                ...j,
                ...finished,
                filename: finished.filename || finished.key,
                size_mb: finished.size_mb,
                match: finished.match || j.match,
                real_title: finished.real_title || j.real_title,
              };
              setDone(
                mismatchNotice(d, d.match || vmatch, d.real_title || vtitle, query)
              );
              markDownloaded();
              loadLib();
            }
          }
          return;
        }

        setDone(mismatchNotice(j, j.match || vmatch, j.real_title || vtitle, query));
        markDownloaded();
        loadLib();
      } catch (e) {
        setErr(fetchErr(e, e.message));
      } finally {
        /* Solo se saca ESTA clave del Set: antes `setBusyId(null)` apagaba el
           spinner de la descarga que siguiera corriendo. */
        setBusyIds((cur) => {
          const next = new Set(cur);
          next.delete(key);
          return next;
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fmt, query, setQuery, setJobFor]
  );

  /* Si el server no responde, el contador queda en null (consultando) en vez
     de romperse: el panel se abre vacio y el error se ve en la consola. */
  const loadLib = useCallback(async () => {
    try {
      const r = await fetch(`${API}/library`);
      if (!r.ok) {
        setLibErr(true); // un 500 no puede pisar el contador
        return;
      }
      const d = await r.json();
      setLib(d.files || []);
      setLibErr(false);
    } catch (e) {
      setLibErr(true);
      /* ACA NO se toca `lib`. Setearlo a [] convierte "no se pudo consultar"
         en "biblioteca vacia", que es justo lo que `lib === null` servia para
         distinguir. Un 500 con 22 archivos en disco llegaba como "vacia". */
    }
  }, []);

  /* Cambiar donde vive la biblioteca cambia lo que lista /api/library y la
     etiqueta de /api/health: las dos se recargan. */
  const onStorageChanged = useCallback(() => {
    loadHealth();
    loadLib();
  }, [loadHealth, loadLib]);

  const toggleLib = useCallback(() => {
    setLibOpen((n) => !n);
  }, []);

  /* El cajon se monta la primera vez que se abre y ya no se desmonta: sus
     Player siguen vivos al cerrarlo y la musica no se corta. Abrir/cerrar es
     solo `data-state` + una transicion CSS (interrumpible, a diferencia de un
     keyframe).
     - libEver: ya se abrio alguna vez (monta el cajon).
     - libShow: el estado visual. Va un fotograma por detras de libOpen al abrir
       para que el cajon se pinte primero cerrado y la transicion tenga desde
       donde arrancar; al cerrar va a la par.
     - libSettled: la apertura termino. Hasta entonces recorta su contenido,
       despues lo libera para que la sombra del panel no quede cortada. */
  const [libEver, setLibEver] = useState(false);
  const [libShow, setLibShow] = useState(false);
  const [libSettled, setLibSettled] = useState(false);
  /* Layout effect y no requestAnimationFrame: con la pestana en segundo plano
     rAF no se dispara y el cajon se quedaba cerrado para siempre. */
  useLayoutEffect(() => {
    if (!libOpen) {
      setLibShow(false);
      setLibSettled(false);
      return;
    }
    if (!libEver) {
      setLibEver(true);
      return;
    }
    /* Leer una medida fuerza el calculo de estilo del estado cerrado antes de
       pasar a abierto; sin esto el navegador fusiona los dos y no anima. */
    void drawerRef.current?.offsetHeight;
    setLibShow(true);
  }, [libOpen, libEver]);

  /* Saltar a una cancion desde el mini-reproductor. Si vive en la biblioteca
     cerrada hay que abrirla y esperar a que el cajon termine de crecer, o el
     scroll apunta a una posicion que aun no existe. */
  const revealSong = useCallback(
    (el) => {
      if (!el) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const go = () =>
        el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      if (el.closest(".drawer") && !libOpen) {
        setLibOpen(true);
        setTimeout(go, 320);
      } else {
        go();
      }
    },
    [libOpen]
  );

  /* El contador del boton tiene que ser real desde el primer render, asi que
     /api/library se pide al montar y no solo al abrir el panel. Es una lista
     de archivos locales: no toca red. */
  useEffect(() => {
    loadLib();
  }, [loadLib]);

  /* null = la consulta sigue en vuelo. Sin esta distincion el boton
     arrancaria atenuado como si la biblioteca estuviera vacia. */
  const libFiles = lib || [];
  const libReady = lib !== null;
  const libCount = libFiles.length;

  /* AUTO-ADVANCE Y PREFETCH DE LA BIBLIOTECA

     Las filas del cajon son <Player> independientes y el cajon no se desmonta,
     asi que "seguir con la de abajo" necesita hablar con la fila VECINA. El
     mapa indice -> <audio> lo llena cada Player al montarse (`registerAudio`):
     nada de buscar en el DOM por selectores.

     `startLibTrack` adelanta el SIGUIENTE tema con POST /api/prefetch, sin
     esperar respuesta (si falla, no pasa nada: al final se bajara igual). El
     guardia evita repetir la misma clave dos veces seguidas, que es lo que
     pasa al reanudar una pausa. */
  const libAudio = useRef(new Map());
  const prefetched = useRef(null);

  const registerLibAudio = useCallback((n, el) => {
    if (el) libAudio.current.set(n, el);
    else libAudio.current.delete(n);
  }, []);

  const startLibTrack = (n) => {
    const next = libFiles[n + 1];
    if (!next || prefetched.current === next.key) return;
    prefetched.current = next.key;
    fetch(`${API}/prefetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: next.key }),
    }).catch(() => {});
  };

  const endLibTrack = (n) => {
    const next = libAudio.current.get(n + 1);
    /* La ultima fila solo se detiene, como siempre. */
    if (next) next.play().catch(() => {});
  };

  const libTitle = libOpen
    ? "Ocultar la biblioteca"
    : libCount > 0
      ? `Abrir la biblioteca (${libCount} ${libCount === 1 ? "tema" : "temas"})`
      : "Biblioteca vacía: todavía no has descargado nada";
  const libAria = libOpen
    ? "Cerrar la biblioteca"
    : libCount > 0
      ? `Biblioteca, ${libCount} ${libCount === 1 ? "tema" : "temas"}`
      : "Biblioteca, vacía";

  /* El estado vive en la URL: el link se puede compartir y sobrevive al F5. */
  const writeUrl = useCallback((m, text) => {
    const p = new URLSearchParams();
    if (m) p.set("mode", m);
    if (text) p.set("q", text);
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, []);

  useEffect(() => {
    if (!searched) return;
    writeUrl(mode, query);
  }, [mode, query, searched, writeUrl]);

  /* Arranque: si la URL trae consulta, se recupera sola. Usa runSearch para
     que la firma quede seteada y el resync no dispare un segundo fetch.
     Los links viejos con ?src=ytdlp equivalen al modo YouTube; cualquier
     otra fuente ya no se puede filtrar porque los chips se fueron. */
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const p = new URLSearchParams(window.location.search);
    const m = p.get("mode");
    const text = p.get("q");
    const mm = m && MODE_IDS.includes(m) ? m : p.get("src") === "ytdlp" ? "ytdlp" : "matched";
    setMode(mm);
    if (text) {
      setQ(text);
      runSearch(text, mm);
    }
  }, [runSearch]);

  const fullCount = useMemo(
    () => results.filter((t) => trackState(t) === "full").length,
    [results]
  );

  const shown = useMemo(
    () => (filter === "full" ? results.filter((t) => trackState(t) === "full") : results),
    [results, filter]
  );

  const healthByName = useMemo(() => {
    const m = {};
    (health?.sources || []).forEach((s) => {
      m[s.name] = s;
    });
    return m;
  }, [health]);

  /* Con yt-dlp apagado el modo "YouTube" no devuelve nada. No se
     deshabilita (el usuario podria estar reactivandolo desde otra pestana),
     pero se marca para que el 0 de resultados no parezca un fallo. */
  const ytOn = healthByName.ytdlp?.active;
  const ytDead = health !== null && !ytOn;

  /* Con yt-dlp apagado, el modo Música es el que se abre por defecto y
     devuelve "30 resultados, 0 descargables" sin decir por que: iTunes solo
     tiene previews de 30 s y el audio completo sale de YouTube. El aviso
     existia para el modo que se elige a mano (.mode--dead), no para el que
     arranca solo. Sin esto, con el server sin YTDLP_ENABLED=1, la primera
     pantalla parece una app rota. */
  const matchedDead =
    ytDead && mode === "matched" && results.length > 0 && fullCount === 0;

  /* Mensaje para lectores de pantalla: los resultados cambian sin mover el foco. */
  const srMsg = loading
    ? "Buscando…"
    : searched && !err
    ? results.length
      ? `${results.length} ${results.length === 1 ? "resultado" : "resultados"} para «${query}»`
      : "Sin resultados"
    : "";

  return (
    <main className="app">
      <div className="blob blob--coral" aria-hidden="true" />
      <div className="blob blob--sky" aria-hidden="true" />
      <header className="top">
        <div className="brand">
          <Waveform size={24} weight="bold" className="brand__mark" />
          <span className="brand__name">spitifo</span>
        </div>
        <div className="top__actions">
        <button
          type="button"
          role="switch"
          aria-checked={dark}
          className="themesw"
          onClick={() => chooseTheme(dark ? "light" : "dark")}
          aria-label="Modo oscuro"
          title={
            dark
              ? "Modo oscuro: cambiar a modo claro"
              : "Modo claro: cambiar a modo oscuro"
          }
        >
          <span className="themesw__knob">
            <span className="themesw__ico themesw__ico--moon">
              <Moon size={12} weight="fill" />
            </span>
            <span className="themesw__ico themesw__ico--sun">
              <Sun size={12} weight="fill" />
            </span>
          </span>
        </button>
        <button
          ref={libBtnRef}
          className={[
            "libbtn",
            libOpen ? "is-on" : "",
            libReady && libCount === 0 ? "is-empty" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={toggleLib}
          aria-expanded={libOpen}
          aria-label={libAria}
          title={libTitle}
        >
          <span className="swap" key={libOpen ? "x" : "stack"}>
            {libOpen ? <X size={17} /> : <Stack size={17} />}
          </span>
          <span className="libbtn__lbl">{libOpen ? "Cerrar" : "Biblioteca"}</span>
          {!libOpen && libCount > 0 && (
            <span className="count count--bump" key={libCount}>
              {libCount}
            </span>
          )}
        </button>
        </div>
      </header>

      <p className="sr-only" role="status" aria-live="polite">
        {srMsg}
      </p>

      <section className="hero">
        <h1 className="hero__title">Descarga música libremente</h1>

        <div className="finder">
          <form
            onSubmit={doSearch}
            role="search"
            className={cx("search", scanning && "is-scanning")}
            onAnimationIteration={(e) => {
              if (!loading && e.target.classList.contains("search__icon")) setScanning(false);
            }}
          >
            <MagnifyingGlass size={22} className="search__icon" />
            <input
              ref={inputRef}
              type="search"
              name="q"
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={PLACEHOLDER[mode] || PLACEHOLDER.default}
              aria-label="Qué quieres escuchar"
            />
            <button type="submit" className="search__go">
              {loading ? "Buscando" : "Buscar"}
            </button>
          </form>

          <section className="controls" aria-label="Cómo buscar">
            <ModePicker value={mode} onChange={setMode} ytDead={ytDead} />
            <FmtPicker value={fmt} onChange={setFmt} />
          </section>
          {fmt === "original" && (
            <p className="finder__hint" key={mode === "ytdlp" ? "yt" : "any"}>
              {mode === "ytdlp" ? ORIGINAL_HINT_YT : ORIGINAL_HINT}
            </p>
          )}
        </div>
      </section>

      {err && (
        <div className="msg msg--err" role="alert" ref={msgRef} tabIndex={-1}>
          <WarningCircle size={17} weight="fill" />
          <span>{err}</span>
        </div>
      )}
      <ProgressStack jobs={jobs} />
      {matchedDead && (
        <div className="msg msg--warn" role="status">
          <WarningCircle size={17} weight="fill" />
          <span>
            YouTube está apagado en el servidor, y es de ahí de donde sale el
            audio completo. Por eso estos {results.length} resultados no se
            pueden descargar: iTunes solo tiene previews de 30 segundos.
          </span>
        </div>
      )}
      {done && (
        <div
          key={done.filename || done.warning}
          className={`msg ${done.warning ? "msg--warn" : "msg--ok"}`}
          style={{ "--dismiss": `${JOB_DISMISS_MS}ms` }}
          role="status"
          ref={msgRef}
        >
          {done.warning ? (
            <WarningCircle size={17} weight="fill" />
          ) : (
            <CheckCircle size={17} weight="fill" />
          )}
          <span>
            {done.warning
              ? done.warning
              : `${done.filename} está en tu biblioteca${
                  done.size_mb ? ` (${fmtSize(done.size_mb)})` : ""
                }.`}
            {!done.warning && done.real_title && done.match === "match" && (
              <span className="msg__sub">verificado: {done.real_title}</span>
            )}
          </span>
        </div>
      )}

      {libEver && (
        <div
          ref={drawerRef}
          className="drawer"
          data-state={libShow ? "open" : "closed"}
          data-settled={libSettled && libShow ? "" : undefined}
          aria-hidden={libShow ? undefined : true}
          inert={libShow ? undefined : ""}
          onTransitionEnd={(e) => {
            if (
              e.target === e.currentTarget &&
              e.propertyName === "grid-template-rows" &&
              libShow
            ) {
              setLibSettled(true);
            }
          }}
        >
          <div className="drawer__in">
            <section className="panel">
              <div className="panel__head">
                <h2 className="panel__title">
                  <Stack size={17} />
                  Tu biblioteca
                  <span className="count">{libCount}</span>
                </h2>
                {health?.library && (
                  <button
                    type="button"
                    className="panel__store"
                    onClick={() => setStorageOpen(true)}
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
              </div>
              <div className="panel__body">
                {libReady && libCount === 0 && (
                  <p className="panel__empty">Todavía no has descargado nada.</p>
                )}
                {!libReady && libErr && (
                  <p className="panel__empty" role="alert">
                    No se pudo cargar la biblioteca.
                    <br />
                    <button type="button" className="vf" onClick={loadLib}>
                      Reintentar
                    </button>
                  </p>
                )}
                {libFiles.map((f, n) => (
                  <Player
                    key={f.key}
                    src={`${API}/audio?key=${encodeURIComponent(f.key)}`}
                    label={f.filename}
                    title={f.filename}
                    meta={`${f.folder}${f.size_mb != null ? ` · ${fmtSize(f.size_mb)}` : ""}`}
                    duration={f.duration_s}
                    index={n}
                    registerAudio={registerLibAudio}
                    onStart={() => startLibTrack(n)}
                    onEnded={() => endLibTrack(n)}
                  />
                ))}
              </div>
            </section>
          </div>
        </div>
      )}

      {results.length > 0 && (
        <>
          <div
            ref={resultsRef}
            tabIndex={-1}
            className={cx("results__head", loading && "is-stale")}
          >
            <span className="results__count">
              <b>{results.length}</b> resultados para <b>{query}</b>,{" "}
              <b>{fullCount} descargables</b>
            </span>
            <FilterSegs
              filter={filter}
              onChange={setFilter}
              total={results.length}
              full={fullCount}
            />
          </div>
          <ul
            className={cx("rows", loading && "is-stale")}
            aria-busy={loading || undefined}
            inert={loading ? "" : undefined}
          >
            {shown.map((t, i) =>
              t.extra?.is_group && t.extra?.track_count > 1 ? (
                <ShowGroup
                  key={t.source + t.source_id}
                  t={t}
                  query={query}
                  onDownload={onDownload}
                  busyIds={busyIds}
                  downloadedIds={downloadedIds}
                />
              ) : (
                <Track
                  key={t.source + t.source_id}
                  t={t}
                  query={query}
                  busy={busyIds.has(rowKey(t))}
                  downloaded={downloadedIds.has(rowKey(t))}
                  onDownload={onDownload}
                  index={i}
                />
              )
            )}
          </ul>
          {shown.length === 0 && (
            <div className="none">
              <h3 className="none__h">Ningún resultado con descarga completa</h3>
              <p className="none__p">
                Hay {results.length} resultados, pero todos son previews de 30 segundos o
                temas que no coinciden con lo que buscaste. Prueba con Todas las fuentes.
              </p>
            </div>
          )}
        </>
      )}

      {loading && !results.length && (
        <ul className="rows" aria-label="Buscando" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <SkeletonRow key={i} i={i} />
          ))}
        </ul>
      )}

      {!loading && !results.length && !err && !searched && (
        <section className="intro">
          <Sparkle size={26} weight="fill" className="intro__mark" />
          <h2 className="intro__h">Escribe un tema y descárgalo completo</h2>
          <p className="intro__p">
            Spitifo busca a la vez en varias fuentes de música libre y te dice, resultado
            por resultado, si el archivo se descarga completo.
          </p>
          <p className="intro__lbl">Prueba con alguno de estos</p>
          <ul className="examples">
            {EXAMPLES.map((ex, i) => (
              <li key={ex} style={{ "--i": i }}>
                <button type="button" className="example" onClick={() => runExample(ex)}>
                  <Waveform size={13} />
                  {ex}
                </button>
              </li>
            ))}
          </ul>
          <p className="intro__fine">
            Internet Archive y Wikimedia liberan los archivos. iTunes sirve para
            encontrar la ficha y la portada. De YouTube sale el audio completo del tema.
          </p>
        </section>
      )}

      {!loading && !results.length && searched && !err && (
        <div className="none" ref={resultsRef} tabIndex={-1}>
          <h3 className="none__h">No encontré nada para "{query}"</h3>
          <p className="none__p">
            Prueba con menos palabras, con el nombre del artista solo, o cambia a Todas
            las fuentes para buscar en iTunes, Internet Archive, Wikimedia y YouTube.
          </p>
        </div>
      )}
      <MiniPlayer libOpen={libOpen} onReveal={revealSong} />
      <StorageDialog
        open={storageOpen}
        onClose={() => setStorageOpen(false)}
        onChanged={onStorageChanged}
      />
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
