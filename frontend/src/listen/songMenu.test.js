import { describe, expect, it } from "vitest";
import { menuKinds } from "./songMenu.js";

const base = {
  key: "A/a.mp3", title: "Tema", artist: "Artista", album: "Disco", downloaded: true,
};

describe("menuKinds", () => {
  it("keeps the common options first and removal last for a file", () => {
    expect(menuKinds(base)).toEqual([
      "next", "end", "list", "album", "artist", "file", "remove",
    ]);
  });

  it("offers download for a saved stream, without file options", () => {
    const entry = {
      ...base, key: "yt:dQw4w9WgXcQ", sid: "yt:dQw4w9WgXcQ", downloaded: false,
      song: { id: "yt:dQw4w9WgXcQ" },
    };
    expect(menuKinds(entry)).toEqual([
      "next", "end", "list", "album", "artist", "download", "remove",
    ]);
  });

  it("offers undownload and the file sheet for a saved song with a file", () => {
    const entry = {
      ...base, sid: "yt:dQw4w9WgXcQ", downloaded: true,
      song: { id: "yt:dQw4w9WgXcQ" },
    };
    expect(menuKinds(entry)).toEqual([
      "next", "end", "list", "album", "artist", "undownload", "file", "remove",
    ]);
  });

  it("skips the navigation items when there is no album or artist", () => {
    expect(menuKinds({ key: "s", sid: "s", song: { id: "s" } })).toEqual([
      "next", "end", "list", "remove",
    ]);
  });

  it("does not offer download without a streamable source", () => {
    const entry = { ...base, sid: "x:otra", downloaded: false, song: { id: "x:otra" } };
    expect(menuKinds(entry)).not.toContain("download");
  });
});
