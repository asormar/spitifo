import { describe, expect, it } from "vitest";
import { readDownloadFormat, readDownloadMedia } from "./downloadPrefs.js";

const stored = (values) => ({ getItem: (key) => (key in values ? values[key] : null) });

describe("preferencias de descarga", () => {
  it("m4a y solo audio por defecto", () => {
    expect(readDownloadFormat(stored({}))).toBe("m4a");
    expect(readDownloadMedia(stored({}))).toBe("audio");
  });

  it("lee lo que el usuario eligio en Ajustes", () => {
    expect(readDownloadFormat(stored({ "spitifo:download-format": "mp3" }))).toBe("mp3");
    expect(readDownloadMedia(stored({ "spitifo:download-media": "both" }))).toBe("both");
  });

  it("ignora valores desconocidos y un almacen bloqueado", () => {
    expect(readDownloadFormat(stored({ "spitifo:download-format": "wav" }))).toBe("m4a");
    expect(readDownloadMedia(stored({ "spitifo:download-media": "x" }))).toBe("audio");
    expect(readDownloadFormat(null)).toBe("m4a");
    expect(readDownloadMedia(null)).toBe("audio");
  });
});
