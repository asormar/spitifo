import { describe, expect, it } from "vitest";
import { shelfThumbUrl, thumbUrl } from "./artwork.js";

describe("thumbUrl", () => {
  it("pide 200 px a iTunes", () => {
    expect(thumbUrl("https://is1-ssl.mzstatic.com/image/thumb/Music/a.jpg/300x300bb.jpg")).toBe(
      "https://is1-ssl.mzstatic.com/image/thumb/Music/a.jpg/200x200bb.jpg"
    );
  });

  it("pide mqdefault a YouTube", () => {
    expect(thumbUrl("https://i.ytimg.com/vi/abc123/hqdefault.jpg")).toBe(
      "https://i.ytimg.com/vi/abc123/mqdefault.jpg"
    );
  });

  it("deja igual lo que no reconoce, y lo vacio", () => {
    const other = "https://example.com/cover/300x300.png";
    expect(thumbUrl(other)).toBe(other);
    expect(thumbUrl("https://i.ytimg.com/vi/abc123/maxresdefault.jpg")).toBe(
      "https://i.ytimg.com/vi/abc123/maxresdefault.jpg"
    );
    expect(thumbUrl(null)).toBeNull();
    expect(thumbUrl(undefined)).toBeUndefined();
    expect(thumbUrl("")).toBe("");
  });
});

describe("shelfThumbUrl", () => {
  it("pide la miniatura de 100 px para las ocho portadas del estante", () => {
    expect(shelfThumbUrl("https://is1-ssl.mzstatic.com/image/thumb/Music/a.jpg/300x300bb.jpg")).toBe(
      "https://is1-ssl.mzstatic.com/image/thumb/Music/a.jpg/100x100bb.jpg"
    );
    expect(shelfThumbUrl("https://i.ytimg.com/vi/abc123/hqdefault.jpg")).toBe(
      "https://i.ytimg.com/vi/abc123/mqdefault.jpg"
    );
    expect(shelfThumbUrl(null)).toBeNull();
  });
});
