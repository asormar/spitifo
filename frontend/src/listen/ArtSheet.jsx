import { useEffect, useRef, useState } from "react";
import Sheet from "../shared/Sheet.jsx";
import Ico from "../shared/ico.jsx";
import { API, errMsg } from "../shared/api.js";
import { art, useArtRecord } from "./art.js";
import {
  BIG_PX,
  SMALL_PX,
  MAX_IMAGE_BYTES,
  MAX_SMALL_BYTES,
  SOURCE_LABEL,
  base64Bytes,
  buildCandidates,
  cropRect,
  dataUrlBase64,
  pickQuality,
} from "./artLogic.js";
import "./art.css";

/* ---------------------------------------------------------------------------
   HOJA "Foto de <nombre>"

   Vive en el chunk de overlays/paginas, nunca en la entrada principal. Sube una
   imagen recortada en el navegador (no hay libreria de imagenes en Android) o
   elige una de la busqueda. El almacen hace el cambio optimista y deshace si el
   servidor lo rechaza.
   ------------------------------------------------------------------------- */

async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      /* Algunos WebView no decodifican todos los tipos: prueba con <img>. */
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("img"));
    };
    img.src = url;
  });
}

/* Un lienzo por tamano, recorte central y la primera calidad que cabe en el
   limite del backend.Devuelve base64 sin el prefijo data:. */
function exportPair(source) {
  const r = cropRect(source.width, source.height);
  const draw = (size) => {
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    c.getContext("2d").drawImage(source, r.sx, r.sy, r.s, r.s, 0, 0, size, size);
    return c;
  };
  const pack = (canvas, limit) => {
    const quality = pickQuality(
      (q) => base64Bytes(dataUrlBase64(canvas.toDataURL("image/jpeg", q))),
      limit
    );
    const full = canvas.toDataURL("image/jpeg", quality);
    return { data: dataUrlBase64(full), url: full };
  };
  const big = pack(draw(BIG_PX), MAX_IMAGE_BYTES);
  const small = pack(draw(SMALL_PX), MAX_SMALL_BYTES);
  return {
    image: big.data,
    small: small.data,
    urls: { url: big.url, smallUrl: small.url },
  };
}

async function candidatesFor(kind, query) {
  const get = async (path) => {
    const r = await fetch(`${API}${path}`);
    if (!r.ok) throw new Error("http");
    return r.json().catch(() => ({}));
  };
  if (kind === "song") return buildCandidates(kind, await get(`/search?q=${encodeURIComponent(query)}&limit=12`));
  if (kind === "album") return buildCandidates(kind, await get(`/albums/search?q=${encodeURIComponent(query)}&limit=12`));
  const found = await get(`/artists/search?q=${encodeURIComponent(query)}&limit=3`);
  const details = await Promise.all(
    (found.results || []).map((a) => get(`/artist/${encodeURIComponent(a.id)}`).catch(() => null))
  );
  return buildCandidates(kind, details.filter(Boolean));
}

export default function ArtSheet({ target, name, query, kind, anchor, onClose }) {
  const record = useArtRecord(target);
  const fileRef = useRef(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [candidates, setCandidates] = useState([]);

  useEffect(() => {
    let live = true;
    candidatesFor(kind, query || name)
      .then((list) => live && setCandidates(list))
      .catch(() => live && setCandidates([]));
    return () => {
      live = false;
    };
  }, [kind, query, name]);

  const result = (ok) => {
    setBusy("");
    setNotice(ok ? "Foto cambiada" : "No se pudo cambiar la foto");
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy("upload");
    setNotice("");
    try {
      const source = await decode(file);
      const { image, small, urls } = exportPair(source);
      result(await art.upload(target, image, small, urls));
    } catch {
      result(false);
    }
  };

  const pick = async (c) => {
    setBusy(c.url);
    setNotice("");
    result(await art.fromUrl(target, c.url, c.source));
  };

  const reset = async () => {
    setBusy("reset");
    setNotice("");
    result(await art.reset(target));
  };

  const title = `Foto de «${name}»`;
  return (
    <Sheet title={title} onClose={onClose} anchor={anchor} sm>
      <div className="sh__bar">
        <h2 className="sh__bt">{title}</h2>
        <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar" onClick={onClose}>
          <Ico n="x" size={18} />
        </button>
      </div>
      <div className="artsh">
        <input ref={fileRef} type="file" accept="image/*" className="sr-only" onChange={onFile} />
        <button
          type="button"
          className="btn btn--pink artsh__up"
          data-autofocus
          disabled={Boolean(busy)}
          aria-busy={busy === "upload" || undefined}
          onClick={() => fileRef.current?.click()}
        >
          <Ico n="upload" size={18} />
          {busy === "upload" ? "Subiendo…" : "Subir una imagen"}
        </button>
        {notice && (
          <p className="artsh__note" role="status">
            {notice}
          </p>
        )}
        {candidates.length > 0 && (
          <>
            <p className="artsh__hint">O elige una</p>
            <div className="artsh__grid">
              {candidates.map((c) => {
                const current = record?.url === c.url;
                return (
                  <button
                    key={c.url}
                    type="button"
                    className="artsh__pick"
                    aria-label={`Usar foto de ${SOURCE_LABEL[c.source]}${c.label ? `, ${c.label}` : ""}`}
                    onClick={() => pick(c)}
                  >
                    <img src={c.url} alt="" loading="lazy" decoding="async" />
                    <small>{current ? "Actual" : SOURCE_LABEL[c.source]}</small>
                  </button>
                );
              })}
            </div>
          </>
        )}
        {record && (
          <button type="button" className="btn btn--ghost" disabled={Boolean(busy)} onClick={reset}>
            Volver a la original
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Volver
        </button>
      </div>
    </Sheet>
  );
}
