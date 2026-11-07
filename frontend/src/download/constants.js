/* Cuanto tarda en desaparecer el aviso de descarga una vez terminada. */
export const JOB_DISMISS_MS = 5000;
export const SOURCE_LABEL = {
  itunes: "iTunes",
  archive: "Internet Archive",
  jamendo: "Jamendo",
  wikimedia: "Wikimedia",
  ytdlp: "YouTube",
};
/* La etiqueta corta del telefono (el nombre entero va en el title). */
export const SOURCE_CODE = { itunes: "iT", archive: "IA", jamendo: "J", wikimedia: "W", ytdlp: "YT" };

/* De donde sale la FICHA y de donde sale el ARCHIVO. En modo Musica no son la
   misma cosa: iTunes pone los datos y la portada, YouTube el audio que se
   descarga. Sin esto, "iTunes | 3:07" se lee como si el archivo entero fuera de
   iTunes, y es falso. */
export function provenance(t) {
  const ficha = SOURCE_LABEL[t.source] || t.source;
  const archivo = t.extra?.webpage_url ? SOURCE_LABEL.ytdlp : ficha;
  return { ficha, archivo, split: ficha !== archivo };
}

/* Los tres modos que ve el usuario. Los nombres internos (matched, sources,
   ytdlp) no salen nunca a la pantalla. La explicacion que vivia debajo del
   selector (y el aviso legal antes que ella) ya no esta en la UI: se
   eliminaron por decision del usuario, no por descuido. */
export const MODES = [
  { id: "matched", label: "Música" },
  { id: "sources", label: "Todas las fuentes" },
  { id: "ytdlp", label: "YouTube" },
];

export const MODE_IDS = MODES.map((m) => m.id);

/* Formatos que acepta el backend. El valor que viaja en el POST de descarga es
   exactamente este string, sin traducirlo. */
export const FORMATS = [
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

/* Que partes de la descarga se piden en modo YouTube: solo el audio (como
   siempre), solo el video o las dos cosas. En el resto de los modos el archivo
   siempre es audio y este selector ni se pinta. El valor que viaja en el POST
   es el `id`, sin traducir. */
export const MEDIA_OPTIONS = [
  { id: "audio", label: "Solo audio" },
  { id: "video", label: "Solo vídeo" },
  { id: "both", label: "Audio y vídeo" },
];

/* Aviso bajo los controles cuando se elige "original". El title de FORMATS no
   se ve en tactil, asi que la misma informacion sale como linea visible. */
/* Un enlace de YouTube solo tiene sentido en "YouTube" (iTunes no sabe
   que hacer con una URL). Misma regla de hosts que parse_youtube_url del
   backend; el ID lo valida el. */
export const YT_URL = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\/\S+$/i;
export const isYouTubeUrl = (text) => YT_URL.test(text.trim());

export const PLACEHOLDER = {
  ytdlp: "Busca el título o pega la URL",
  default: "Busca una canción, un artista, un género",
};

export const ORIGINAL_HINT = "Original: el archivo tal cual. Lo que venga de YouTube conserva su audio, sin recomprimir (normalmente Opus o AAC).";
export const ORIGINAL_HINT_YT = "Original: el audio tal como viene de YouTube, sin recomprimir (normalmente Opus o AAC).";

export const EXAMPLES = [
  "Nick Cave Into My Arms",
  "Chopin Nocturne",
  "Radiohead Creep",
  "Miles Davis So What",
];
/* El estado que domina la fila: se baja entero / solo preview / nada.

   OJO con el campo `downloadable` en modo Música: el backend lo deja en
   False aunque el archivo exista, porque la descarga sale de webpage_url. Por
   eso NO se lee ese campo solo: se mira tambien webpage_url y needs_resolve. */
export function trackState(t) {
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

/* Por que no hay descarga: texto visible en la fila (el tactil no tiene
   tooltip) y nombre accesible del circulo tachado. */
export const NODL_TITLE = {
  preview: "Solo hay 30 s de esta fuente",
  none: "No hay versión completa",
};
