import { describe, expect, it } from "vitest";
import { resultMenuGroups } from "./resultMenu.js";

const labels = (groups) => groups.map((g) => g.label);

describe("resultMenuGroups", () => {
  const full = {
    source: "itunes",
    source_id: "1",
    title: "Creep",
    artist: "Radiohead",
    album: "Pablo Honey",
    extra: { webpage_url: "https://youtu.be/abcdefghijk", collection_id: 123 },
  };

  it("pinta los cuatro grupos en orden con la descarga y el formato", () => {
    const groups = resultMenuGroups(full, { fmt: "m4a" });
    expect(labels(groups)).toEqual(["Escuchar", "Tu biblioteca", "Ir a", "Archivo"]);
    expect(groups[1].items[0]).toEqual({ kind: "download", icon: "DownloadSimple", text: "Descargar", sub: "m4a" });
    expect(groups[2].items.map((i) => i.text)).toEqual([
      "Ir al álbum «Pablo Honey»",
      "Ir a Radiohead",
    ]);
  });

  it("no ofrece descargar un resultado que solo tiene 30 s", () => {
    const preview = { source: "itunes", source_id: "2", preview_url: "https://x/preview.m4a", extra: {} };
    expect(labels(resultMenuGroups(preview))).toEqual(["Escuchar", "Archivo"]);
  });

  it("sí ofrece descargar un resultado pendiente de resolver", () => {
    const pending = { source: "itunes", source_id: "3", extra: { needs_resolve: true } };
    expect(labels(resultMenuGroups(pending))).toContain("Tu biblioteca");
  });

  it("la descarga ya hecha sale deshabilitada", () => {
    const groups = resultMenuGroups(full, { downloaded: true });
    expect(groups[1].items[0]).toEqual({ kind: "downloaded", icon: "Check", text: "Descargada", disabled: true });
  });

  it("no ofrece «Ir al álbum» cuando no hay ficha que abrir", () => {
    const noSheet = { ...full, extra: { webpage_url: "https://youtu.be/abcdefghijk" } };
    const groups = resultMenuGroups(noSheet);
    expect(groups[2].items.map((i) => i.text)).toEqual(["Ir a Radiohead"]);
  });

  it("omite «Ir a» sin album ni artista", () => {
    const bare = { source: "itunes", source_id: "4", extra: { webpage_url: "https://youtu.be/abcdefghijk" } };
    expect(labels(resultMenuGroups(bare))).toEqual(["Escuchar", "Tu biblioteca", "Archivo"]);
  });
});
