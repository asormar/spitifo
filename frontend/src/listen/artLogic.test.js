import { describe, expect, it } from "vitest";
import {
  artSrc,
  base64Bytes,
  buildCandidates,
  coverSrc,
  cropRect,
  dataUrlBase64,
  pickQuality,
  songTarget,
  sourceOfUrl,
  youtubeThumb,
} from "./artLogic.js";

const keyUrl = (k) => `/api/audio?key=${k}`;

describe("target ids", () => {
  it("usa el id guardado antes que la clave del archivo", () => {
    expect(songTarget({ sid: "yt:abc", key: "Artista/Tema.mp3" })).toBe("song:yt:abc");
  });
  it("cae a la clave del archivo sin guardada", () => {
    expect(songTarget({ key: "Ar/Ti.mp3" })).toBe("song:Ar/Ti.mp3");
  });
  it("sin id no devuelve target", () => {
    expect(songTarget({})).toBeNull();
    expect(songTarget(null)).toBeNull();
  });
});

describe("fuente por host", () => {
  it("reconoce los tres host de la lista", () => {
    expect(sourceOfUrl("https://a.mzstatic.com/image/600x600bb.jpg")).toBe("itunes");
    expect(sourceOfUrl("https://is1-ssl.mzstatic.com/image/300x300bb.jpg")).toBe("itunes");
    expect(sourceOfUrl("https://i.ytimg.com/vi/abc/hqdefault.jpg")).toBe("youtube");
    expect(sourceOfUrl("https://archive.org/download/x/cover.jpg")).toBe("archive");
  });
  it("rechaza otros host, esquemas y basura", () => {
    expect(sourceOfUrl("https://i.ytimg.com.evil.com/x.jpg")).toBeNull();
    expect(sourceOfUrl("http://i.ytimg.com/x.jpg")).toBeNull();
    expect(sourceOfUrl("ftp://mzstatic.com/x.jpg")).toBeNull();
    expect(sourceOfUrl("no-es-url")).toBeNull();
  });
  it("saca la miniatura del video matcheado", () => {
    expect(youtubeThumb("https://www.youtube.com/watch?v=abc12345678&t=4")).toBe(
      "https://i.ytimg.com/vi/abc12345678/hqdefault.jpg"
    );
    expect(youtubeThumb("https://youtu.be/abc12345678")).toBe(
      "https://i.ytimg.com/vi/abc12345678/hqdefault.jpg"
    );
    expect(youtubeThumb(null)).toBeNull();
  });
});

describe("recorte y calidad", () => {
  it("recorta el cuadrado centrado", () => {
    expect(cropRect(400, 200)).toEqual({ sx: 100, sy: 0, s: 200 });
    expect(cropRect(200, 400)).toEqual({ sx: 0, sy: 100, s: 200 });
    expect(cropRect(300, 301)).toEqual({ sx: 0, sy: 0, s: 300 });
    expect(cropRect(0, 0)).toEqual({ sx: 0, sy: 0, s: 1 });
  });
  it("cuenta bytes decodificados con padding", () => {
    expect(base64Bytes("")).toBe(0);
    expect(base64Bytes("QQ==")).toBe(1);
    expect(base64Bytes("QUJD")).toBe(3);
    expect(base64Bytes("QUJDRA==")).toBe(4);
  });
  it("quita el prefijo data", () => {
    expect(dataUrlBase64("data:image/jpeg;base64,QUJD")).toBe("QUJD");
    expect(dataUrlBase64("QUJD")).toBe("QUJD");
  });
  it("elige la primera calidad que cabe y la mas baja si ninguna cabe", () => {
    const sizes = [400, 300, 200, 150, 100];
    expect(pickQuality((q) => sizes[[0.85, 0.72, 0.6, 0.5, 0.4].indexOf(q)], 320)).toBe(0.72);
    expect(pickQuality(() => 9999, 320)).toBe(0.4);
    expect(pickQuality(() => 10, 320)).toBe(0.85);
  });
});

describe("precedencia de portada", () => {
  const fixed = { key: ".art/aa.jpg", small_key: ".art/aa.s.jpg", source: "upload" };
  it("sin registro devuelve la portada de siempre", () => {
    expect(artSrc(null, keyUrl)).toBeNull();
    expect(coverSrc("orig.jpg", "album:x", new Map(), keyUrl)).toBe("orig.jpg");
    expect(coverSrc("orig.jpg", null, new Map([["album:x", fixed]]), keyUrl)).toBe("orig.jpg");
  });
  it("la foto propia gana y la chica usa small_key", () => {
    const byTarget = new Map([["album:x", fixed]]);
    expect(coverSrc("orig.jpg", "album:x", byTarget, keyUrl)).toBe(keyUrl(".art/aa.jpg"));
    expect(coverSrc("orig.jpg", "album:x", byTarget, keyUrl, true)).toBe(keyUrl(".art/aa.s.jpg"));
  });
  it("un registro optimista usa su URL directa", () => {
    const pending = { pending: true, url: "https://i.ytimg.com/vi/x/hqdefault.jpg", smallUrl: "small.jpg" };
    expect(artSrc(pending, keyUrl)).toBe(pending.url);
    expect(artSrc(pending, keyUrl, true)).toBe("small.jpg");
  });
});

describe("candidatos", () => {
  it("canciones: arte de iTunes y miniaturas de YouTube, sin duplicados", () => {
    const data = {
      results: [
        {
          title: "Tema",
          artwork_url: "https://a.mzstatic.com/image/300x300bb.jpg",
          extra: { webpage_url: "https://www.youtube.com/watch?v=abc12345678" },
        },
        {
          title: "Otro",
          artwork_url: "https://a.mzstatic.com/image/300x300bb.jpg",
          extra: {},
        },
        { title: "Malo", artwork_url: "https://evil.com/x.jpg", extra: {} },
      ],
    };
    const list = buildCandidates("song", data);
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.source)).toEqual(["itunes", "youtube"]);
    expect(list[0].url).toContain("mzstatic");
    expect(list[1].url).toContain("i.ytimg.com");
  });
  it("albumes: arte de /api/albums/search", () => {
    const list = buildCandidates("album", {
      albums: [{ title: "Disco", artwork_url: "https://is1.mzstatic.com/image/300x300bb.jpg" }],
    });
    expect(list).toEqual([{
      url: "https://is1.mzstatic.com/image/300x300bb.jpg",
      source: "itunes",
      label: "Disco",
    }]);
  });
  it("artistas: retrato y discos, con tope de seis", () => {
    const albums = Array.from({ length: 8 }, (_, i) => ({
      title: `Disco ${i}`,
      artwork_url: `https://a${i}.mzstatic.com/image/300x300bb.jpg`,
    }));
    const list = buildCandidates("artist", [{ name: "Banda", artwork_url: null, albums }]);
    expect(list).toHaveLength(6);
    expect(list[0].label).toBe("Disco 0");
  });
  it("sin datos no hay candidatos", () => {
    expect(buildCandidates("song", null)).toEqual([]);
    expect(buildCandidates("otro", { results: [] })).toEqual([]);
  });
});
