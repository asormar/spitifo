import { describe, expect, it } from "vitest";
import { songMenuGroups } from "./songMenu.js";

const base = {
  key: "A/a.mp3", title: "Tema", artist: "Artista", album: "Disco", downloaded: true,
};

const labels = (groups) => groups.map((g) => g.label);
const kinds = (groups) => groups.map((g) => g.items.map((i) => i.kind));
const flat = (groups) => groups.flatMap((g) => g.items);
const item = (groups, kind) => flat(groups).find((i) => i.kind === kind);

describe("songMenuGroups", () => {
  it("groups a downloaded file in reading order, with removal last", () => {
    const groups = songMenuGroups(base);
    expect(labels(groups)).toEqual(["Escuchar", "Tu biblioteca", "Ir a", "Archivo", "Quitar"]);
    expect(kinds(groups)).toEqual([
      ["next", "end"],
      ["list"],
      ["album", "artist"],
      ["photo", "file"],
      ["remove"],
    ]);
    expect(flat(groups).map((i) => i.text)).toEqual([
      "Reproducir a continuación", "Añadir al final de la cola",
      "Añadir a una lista…",
      "Ir al álbum", "Ir al artista",
      "Cambiar foto", "Ficha del archivo",
      "Quitar de tu biblioteca",
    ]);
  });

  it("marks only removal as dangerous", () => {
    const groups = songMenuGroups(base);
    expect(item(groups, "remove").danger).toBe(true);
    expect(flat(groups).filter((i) => i.danger).map((i) => i.kind)).toEqual(["remove"]);
  });

  it("offers download for a saved stream, with the format as secondary label", () => {
    const entry = {
      ...base, key: "yt:dQw4w9WgXcQ", sid: "yt:dQw4w9WgXcQ", downloaded: false,
      song: { id: "yt:dQw4w9WgXcQ" },
    };
    const groups = songMenuGroups(entry, { fmt: "mp4" });
    expect(item(groups, "download")).toEqual({ kind: "download", icon: "dl", text: "Descargar", sub: "mp4" });
    expect(kinds(groups)[1]).toEqual(["list", "download"]);
    expect(flat(groups).map((i) => i.kind)).not.toContain("undownload");
    expect(flat(groups).map((i) => i.kind)).not.toContain("file");
  });

  it("defaults the download format to m4a", () => {
    const entry = { ...base, sid: "yt:dQw4w9WgXcQ", downloaded: false, song: { id: "yt:dQw4w9WgXcQ" } };
    expect(item(songMenuGroups(entry), "download").sub).toBe("m4a");
  });

  it("offers undownload and the file sheet for a saved song with a file", () => {
    const entry = {
      ...base, sid: "yt:dQw4w9WgXcQ", downloaded: true,
      song: { id: "yt:dQw4w9WgXcQ" },
    };
    const groups = songMenuGroups(entry, { pc: true });
    expect(kinds(groups)[1]).toEqual(["list", "undownload"]);
    expect(kinds(groups)[3]).toEqual(["photo", "file"]);
    expect(item(groups, "undownload").text).toBe("Quitar descarga");
    expect(item(groups, "file").text).toBe("Ver la ficha del archivo");
  });

  it("omits «Ir a» when there is no album or artist", () => {
    const groups = songMenuGroups({ key: "s", sid: "s", song: { id: "s" } });
    expect(labels(groups)).toEqual(["Escuchar", "Tu biblioteca", "Archivo", "Quitar"]);
    expect(kinds(groups)[2]).toEqual(["photo"]);
  });

  it("keeps «Ir a» with just one of album or artist", () => {
    expect(kinds(songMenuGroups({ ...base, artist: "" }))[2]).toEqual(["album"]);
    expect(kinds(songMenuGroups({ ...base, album: "" }))[2]).toEqual(["artist"]);
  });

  it("does not offer download without a streamable source", () => {
    const entry = { ...base, sid: "x:otra", downloaded: false, song: { id: "x:otra" } };
    expect(flat(songMenuGroups(entry)).map((i) => i.kind)).not.toContain("download");
  });

  it("puts «Cerrar reproductor» in its own last group when opened from Ahora suena", () => {
    const groups = songMenuGroups(base, { closePlayer: true });
    expect(labels(groups)).toEqual(["Escuchar", "Tu biblioteca", "Ir a", "Archivo", "Quitar", "Reproductor"]);
    expect(kinds(groups).at(-1)).toEqual(["closePlayer"]);
    expect(item(groups, "closePlayer")).toEqual({ kind: "closePlayer", icon: "x", text: "Cerrar reproductor" });
  });

  it("never paints an empty group", () => {
    expect(songMenuGroups({ key: "s" }).every((g) => g.items.length > 0)).toBe(true);
  });
});
