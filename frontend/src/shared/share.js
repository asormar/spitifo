/* ---------------------------------------------------------------------------
   COMPARTIR

   El enlace es híbrido (decisión 2 de la fase 22): el vídeo de YouTube ya
   verificado cuando la canción lo tiene, y una búsqueda en Apple Music/iTunes
   como respaldo. Una playlist no tiene equivalente público: se manda su lista
   de canciones como texto, porque un enlace local que nadie más puede abrir
   sería una mentira. La parte pura se prueba en Node; `share` es el único sitio
   que toca la plataforma: el puente nativo en Android y el portapapeles en PC.
   ------------------------------------------------------------------------- */

const YOUTUBE = /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i;

export function appleMusicUrl(title, artist) {
  const term = [title, artist].filter(Boolean).join(" ");
  return `https://music.apple.com/search?term=${encodeURIComponent(term)}`;
}

/** El vídeo verificado que ya trae el resultado, solo si es de YouTube. */
export function verifiedVideoUrl(result) {
  const url = result?.extra?.webpage_url || result?.webpage_url || null;
  return typeof url === "string" && YOUTUBE.test(url.trim()) ? url.trim() : null;
}

export function shareLink({ title, artist, result = null } = {}) {
  return verifiedVideoUrl(result) || appleMusicUrl(title, artist);
}

/**
 * `target`: { kind: "song"|"album"|"artist"|"list", title, artist, songs,
 * result }. El texto es el mismo en Android (dentro del Intent) y en PC (en el
 * portapapeles).
 */
export function shareText({ kind, title, artist, songs = [], result = null } = {}) {
  if (kind === "list") {
    const total = songs.length;
    const filas = songs.slice(0, 3).map((s, i) => `${i + 1}. ${s.title || "sin título"} — ${s.artist || "artista desconocido"}`);
    const resto = total - filas.length;
    return `Mi lista «${title || "sin título"}» en spitifo (${total} canciones):\n${filas.join("\n")}${resto > 0 ? `\n… y ${resto} más` : ""}`;
  }
  const nombre = title || "sin título";
  const quien = artist ? ` de ${artist}` : "";
  return `«${nombre}»${quien}, en spitifo.\n${shareLink({ title: nombre, artist, result })}`;
}

/** El WebView expone el puente; el navegador de escritorio no. */
export const isAndroid = () =>
  typeof window !== "undefined" && typeof window.SpitifoAndroid?.share === "function";

/**
 * Manda el texto. En Android abre la hoja del sistema (que no dibuja
 * spitifo); en PC copia y avisa con el toast que ya usa la app. `show` llega del
 * proveedor de avisos, así que no hace falta otro sistema de toasts.
 */
export async function share(target, show) {
  const text = shareText(target);
  if (isAndroid()) {
    window.SpitifoAndroid.share(text);
    return { via: "android", text };
  }
  try {
    await navigator.clipboard.writeText(text);
    show?.("Enlace copiado");
    return { via: "clipboard", text };
  } catch {
    show?.("No se pudo copiar el enlace");
    return { via: "failed", text };
  }
}
