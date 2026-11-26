import { describe, expect, it } from "vitest";
import {
  formatForQuality, qualityHint, readDownloadFormat, readDownloadMedia,
  readDownloadQuality, readDownloadRoaming, readDownloadWifiOnly,
} from "./downloadPrefs.js";

const stored = (values) => ({ getItem: (key) => (key in values ? values[key] : null) });

describe("preferencias de descarga", () => {
  it("original (sin recodificar) y solo audio por defecto", () => {
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

  it("red: Wi-Fi desactivado y roaming permitido por defecto", () => {
    expect(readDownloadWifiOnly(stored({}))).toBe(false);
    expect(readDownloadRoaming(stored({}))).toBe(true);
    expect(readDownloadWifiOnly(stored({ "spitifo:download-wifi-only": "1" }))).toBe(true);
    expect(readDownloadRoaming(stored({ "spitifo:download-roaming-allowed": "0" }))).toBe(false);
    expect(readDownloadWifiOnly(null)).toBe(false);
  });

  it("calidad con MB estimados por cancion", () => {
    expect(readDownloadQuality(stored({}))).toBe("normal");
    expect(readDownloadQuality(stored({ "spitifo:download-quality": "raro" }))).toBe("normal");
    expect(qualityHint("ahorro")).toBe("Ahorro · unos 3 MB por canción");
    expect(qualityHint("normal")).toContain("4 MB");
    expect(qualityHint("alta", { video: true })).toContain("vídeo");
    expect(formatForQuality("ahorro")).toBe("m4a");
    expect(formatForQuality("normal")).toBe("m4a");
  });
});
