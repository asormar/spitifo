import { describe, expect, it } from "vitest";
import {
  albumSaveButton,
  albumSaveSelection,
  fichaText,
  heartState,
  ownedEntryFor,
  saveNotice,
  shouldEnqueue,
} from "./saveLogic.js";
import { readAutoDownload } from "../settings/autoDownload.js";

const ytResult = (over = {}) => ({
  source: "ytdlp",
  source_id: "dQw4w9WgXcQ",
  title: "Tema",
  artist: "Artista",
  extra: { webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
  ...over,
});

const albumTrack = (n, over = {}) => ({
  source: "ytdlp",
  source_id: `dQw4w9WgXc${n}`,
  title: `Tema ${n}`,
  artist: "Artista",
  extra: {
    webpage_url: `https://www.youtube.com/watch?v=dQw4w9WgXc${n}`,
    has_full: true,
    disc_number: 1,
    track_number: n,
    collection_id: 42,
  },
  ...over,
});

describe("heartState", () => {
  it("is filled for a saved result", () => {
    expect(heartState({ kind: "stream", full: true, saved: true })).toEqual({ show: true, filled: true });
  });

  it("is filled for a result already in the library (a file counts as saved)", () => {
    expect(heartState({ full: true, owned: true })).toEqual({ show: true, filled: true });
  });

  it("is empty for an unsaved full result", () => {
    expect(heartState({ kind: "stream", full: true })).toEqual({ show: true, filled: false });
  });

  it("has no heart for a 30 s preview or a result without a full version", () => {
    expect(heartState({ kind: "preview", full: true, saved: true })).toEqual({ show: false, filled: false });
    expect(heartState({ kind: "stream", full: false })).toEqual({ show: false, filled: false });
  });
});

describe("ownedEntryFor", () => {
  it("finds the saved record by song id", () => {
    const t = ytResult();
    const entry = { key: "yt:dQw4w9WgXcQ", sid: "yt:dQw4w9WgXcQ", title: "Tema", artist: "Artista" };
    expect(ownedEntryFor(t, [entry], new Map())).toBe(entry);
  });

  it("matches an album slot already in the library", () => {
    const entry = { key: "file", album_id: "42", disc_no: 1, track_no: 2, title: "Otro", artist: "Otro" };
    expect(ownedEntryFor(albumTrack(2), [entry], new Map())).toBe(entry);
  });
});

describe("albumSaveSelection", () => {
  it("drops full tracks that are already saved or owned, and previews", () => {
    const tracks = [albumTrack(1), albumTrack(2), albumTrack(3, { extra: { has_full: false } })];
    const savedIds = new Set(["yt:dQw4w9WgXc2"]);
    const owned = new Set(["1-1"]);
    expect(albumSaveSelection(tracks, { savedIds, owned })).toEqual([]);
  });

  it("selects only the full, not saved, not owned tracks", () => {
    const keep = albumTrack(3);
    const tracks = [albumTrack(1), albumTrack(2), keep];
    const savedIds = new Set(["yt:dQw4w9WgXc2"]);
    const owned = new Set(["1-1"]);
    expect(albumSaveSelection(tracks, { savedIds, owned })).toEqual([keep]);
  });

  it("needs a song id: an unresolved track is left for the album match", () => {
    const unresolved = {
      source: "itunes",
      title: "Tema",
      artist: "Artista",
      extra: { has_full: true, needs_resolve: true },
    };
    expect(albumSaveSelection([unresolved])).toEqual([]);
  });
});

describe("albumSaveButton", () => {
  it("offers to save when there is something left and reads Guardado when not", () => {
    expect(albumSaveButton(3)).toEqual({ text: "Guardar álbum", disabled: false });
    expect(albumSaveButton(0)).toEqual({ text: "Guardado", disabled: true });
  });
});

describe("fichaText", () => {
  it("keeps the 30 s note only for a preview", () => {
    expect(fichaText({ kind: "preview" }).note).toBe(
      "Este audio es un avance de 30 s: no está en tu biblioteca."
    );
  });

  it("names the source of a stream", () => {
    expect(fichaText({ kind: "stream", sid: "yt:dQw4w9WgXcQ", saved: true }).where).toBe(
      "Suena en streaming desde YouTube"
    );
    expect(fichaText({ kind: "stream", source: "archive", sid: "ia:item/01.mp3" }).where).toBe(
      "Suena en streaming desde Internet Archive"
    );
  });

  it("says if the stream is saved and only links when it is", () => {
    expect(fichaText({ kind: "stream", sid: "yt:x", saved: true })).toMatchObject({
      saved: "Guardada en tu biblioteca",
      link: true,
    });
    expect(fichaText({ kind: "stream", sid: null, saved: false })).toMatchObject({
      saved: "No está en tu biblioteca",
      link: false,
    });
  });

  it("leaves library tracks to the file card", () => {
    expect(fichaText({ kind: "library" })).toBeNull();
  });
});

describe("auto-download setting", () => {
  it("is off unless the stored flag is set", () => {
    expect(readAutoDownload({ getItem: () => "1" })).toBe(true);
    expect(readAutoDownload({ getItem: () => null })).toBe(false);
    expect(readAutoDownload({ getItem: () => { throw new Error("bloqueado"); } })).toBe(false);
  });

  it("enqueues only when enabled and not already downloaded", () => {
    expect(shouldEnqueue({ enabled: true, downloaded: false })).toBe(true);
    expect(shouldEnqueue({ enabled: true, downloaded: true })).toBe(false);
    expect(shouldEnqueue({ enabled: false, downloaded: false })).toBe(false);
  });
});

describe("save notices", () => {
  it("says whether a downloaded file was removed too", () => {
    expect(saveNotice.removed("Tema", true)).toBe("Se quitó «Tema» y se borró su archivo");
    expect(saveNotice.removed("Tema", false)).toBe("Se quitó «Tema»");
    expect(saveNotice.album(2, "Disco")).toBe("Se guardaron 2 canciones de «Disco»");
  });
});
