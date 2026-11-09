import { describe, expect, it } from "vitest";
import { fileFacts, queueNote, readReco, relatedTo, sourceCaption, splitMeta } from "./nowInfo.js";

const track = { kind: "library", meta: "Nick Cave · Skeleton Tree" };
const head = "Sonando desde";

describe("splitMeta", () => {
  it("splits artist and album", () => {
    expect(splitMeta("A · B")).toEqual({ artist: "A", album: "B" });
  });

  it("keeps a dot inside the album", () => {
    expect(splitMeta("A · B · C")).toEqual({ artist: "A", album: "B · C" });
  });

  it("handles no album and no meta", () => {
    expect(splitMeta("A")).toEqual({ artist: "A", album: "" });
    expect(splitMeta()).toEqual({ artist: "", album: "" });
  });
});

describe("sourceCaption", () => {
  it("names an album, an artist or a list", () => {
    expect(sourceCaption("album:Skeleton Tree", track)).toEqual({ head, name: "Skeleton Tree" });
    expect(sourceCaption("artist:Nick Cave", track)).toEqual({ head, name: "Nick Cave" });
    expect(sourceCaption("list:Para correr", track)).toEqual({ head, name: "Para correr" });
  });

  it("keeps colons inside the name", () => {
    expect(sourceCaption("album:Vol. 2: Live", track).name).toBe("Vol. 2: Live");
  });

  it("names a mix", () => {
    expect(sourceCaption("mix:all", track)).toEqual({ head, name: "Mezcla · Toda tu biblioteca" });
    expect(sourceCaption("mix:top", track).name).toBe("Mezcla · Lo que más escuchas");
  });

  it("says Tu biblioteca without a label and the label with one", () => {
    expect(sourceCaption("library:", track)).toEqual({ head, name: "Tu biblioteca" });
    expect(sourceCaption("library:Añadido hace poco", track).name).toBe("Añadido hace poco");
    expect(sourceCaption("library:Descargado hace poco", track).name).toBe("Descargado hace poco");
  });

  it("quotes a search", () => {
    expect(sourceCaption("search:nick", track).name).toBe("Resultados de «nick»");
  });

  it("falls back to the album, else the artist, without a source", () => {
    expect(sourceCaption(null, track).name).toBe("Skeleton Tree");
    expect(sourceCaption(undefined, { kind: "library", meta: "Nick Cave" }).name).toBe("Nick Cave");
  });

  it("falls back when the name is empty or the kind unknown", () => {
    expect(sourceCaption("album:", track).name).toBe("Skeleton Tree");
    expect(sourceCaption("search:  ", track).name).toBe("Skeleton Tree");
    expect(sourceCaption("radio:fm", track).name).toBe("Skeleton Tree");
    expect(sourceCaption("sin-dos-puntos", track).name).toBe("Skeleton Tree");
  });

  it("has its own head for a 30 s preview", () => {
    const preview = { kind: "preview", meta: "Nick Cave" };
    expect(sourceCaption(null, preview)).toEqual({ head: "Avance de 30 s", name: "Nick Cave" });
    expect(sourceCaption("album:X", preview).head).toBe("Avance de 30 s");
  });

  it("does not break without a track", () => {
    expect(sourceCaption("album:X", null)).toEqual({ head, name: "X" });
    expect(sourceCaption(null, null)).toEqual({ head, name: "" });
  });
});

describe("queueNote", () => {
  it("says there is nothing more", () => {
    expect(queueNote({ repeat: "off", endless: false })).toBe("No hay nada más en la cola.");
  });

  it("says it starts over with repeat all or an endless queue", () => {
    expect(queueNote({ repeat: "all", endless: false })).toBe("Al terminar vuelve a empezar.");
    expect(queueNote({ repeat: "off", endless: true })).toBe("Al terminar vuelve a empezar.");
  });
});

describe("fileFacts", () => {
  const entry = {
    filename: "Nick Cave - Red Right Hand.m4a",
    sizeMb: 5.9,
    duration: 370,
    added: Date.UTC(2026, 9, 2, 12) / 1000,
  };
  const now = new Date(Date.UTC(2026, 10, 7, 12));
  const get = (rows, k) => rows.find((r) => r.k === k)?.v;

  it("joins format, size and duration", () => {
    expect(get(fileFacts(entry, { now }), "Audio")).toBe("m4a · 5.9 MB · 6:10");
  });

  it("lowers the extension and keeps only the last dot", () => {
    expect(get(fileFacts({ filename: "Tema (live).MP3", duration: 65 }), "Audio")).toBe("mp3 · 1:05");
  });

  it("drops the parts it does not know", () => {
    expect(get(fileFacts({ filename: "a.flac", sizeMb: null, duration: null }), "Audio")).toBe("flac");
    expect(get(fileFacts({ filename: "sin-extension", sizeMb: 12, duration: 0 }), "Audio")).toBe("12 MB");
    expect(fileFacts({ filename: "x", sizeMb: null, duration: null })).toEqual([]);
  });

  it("capitalises where it is stored", () => {
    expect(get(fileFacts(entry, { storage: "este dispositivo" }), "Guardado en")).toBe("Este dispositivo");
    expect(get(fileFacts(entry, { storage: "Google Drive" }), "Guardado en")).toBe("Google Drive");
    expect(get(fileFacts(entry, {}), "Guardado en")).toBeUndefined();
  });

  it("counts plays and hides zero", () => {
    expect(get(fileFacts(entry, { plays: 23 }), "Escuchada")).toBe("23 reproducciones");
    expect(get(fileFacts(entry, { plays: 1 }), "Escuchada")).toBe("1 reproducción");
    expect(get(fileFacts(entry, { plays: 0 }), "Escuchada")).toBeUndefined();
  });

  it("adds name and date only on the full card", () => {
    const short = fileFacts(entry, { now });
    expect(get(short, "Nombre")).toBeUndefined();
    expect(get(short, "Descargado")).toBeUndefined();
    const full = fileFacts(entry, { now, full: true });
    expect(full.find((r) => r.k === "Nombre")).toEqual({
      k: "Nombre",
      v: "Nick Cave - Red Right Hand.m4a",
      mono: true,
    });
    expect(get(full, "Descargado")).toBe("el 2 de octubre");
  });

  it("shows the year when it is not the current one", () => {
    const later = new Date(Date.UTC(2027, 0, 5, 12));
    expect(get(fileFacts(entry, { now: later, full: true }), "Descargado")).toBe("el 2 de octubre de 2026");
  });

  it("hides the date when unknown", () => {
    expect(get(fileFacts({ ...entry, added: 0 }, { now, full: true }), "Descargado")).toBeUndefined();
  });

  it("is empty without an entry", () => {
    expect(fileFacts(null)).toEqual([]);
  });
});

describe("relatedTo", () => {
  const reco = {
    artists: [
      { name: "PJ Harvey", because: ["Nick Cave & The Bad Seeds"] },
      { name: "Leonard Cohen", because: ["Nick Cave & The Bad Seeds", "Jorge Drexler"] },
      { name: "Nick Cave", because: ["Nick Cave & The Bad Seeds"] },
      { name: "[unknown]", because: ["Nick Cave & The Bad Seeds"] },
      { name: "C. Tangana", because: ["Rosalía"] },
      { name: "Tom Waits", because: ["Nick Cave"] },
      { name: "Iggy Pop", because: ["Nick Cave & The Bad Seeds"] },
    ],
  };

  it("finds the candidates whose reason names the artist", () => {
    expect(relatedTo("Nick Cave & The Bad Seeds", reco).map((r) => r.name)).toEqual([
      "PJ Harvey",
      "Leonard Cohen",
      "Tom Waits",
    ]);
  });

  it("finds a credit inside a longer one", () => {
    const names = relatedTo("Nick Cave", reco).map((r) => r.name);
    expect(names).toContain("PJ Harvey");
    expect(names).not.toContain("Nick Cave");
  });

  it("builds the reason from the first two names", () => {
    const [, second] = relatedTo("Nick Cave", reco);
    expect(second.reason).toBe("Porque escuchas Nick Cave & The Bad Seeds y Jorge Drexler");
    expect(relatedTo("Rosalía", reco)[0].reason).toBe("Porque escuchas Rosalía");
  });

  it("matches whole words only", () => {
    const r = { artists: [{ name: "X", because: ["Ecos"] }] };
    expect(relatedTo("Eco", r)).toEqual([]);
    expect(relatedTo("Ecos", r)).toHaveLength(1);
  });

  it("ignores case and accents", () => {
    expect(relatedTo("rosalia", reco)).toHaveLength(1);
  });

  it("drops the same artist under another spelling and [unknown]", () => {
    const names = relatedTo("Nick Cave & The Bad Seeds", reco).map((r) => r.name);
    expect(names).not.toContain("Nick Cave");
    expect(names).not.toContain("[unknown]");
  });

  it("stops at the limit", () => {
    expect(relatedTo("Nick Cave & The Bad Seeds", reco, 2)).toHaveLength(2);
    expect(relatedTo("Nick Cave & The Bad Seeds", reco)).toHaveLength(3);
  });

  it("is empty without data", () => {
    expect(relatedTo("Nick Cave", null)).toEqual([]);
    expect(relatedTo("Nick Cave", {})).toEqual([]);
    expect(relatedTo("Nick Cave", { artists: [{ name: "A" }, null, { because: "x" }] })).toEqual([]);
    expect(relatedTo("", reco)).toEqual([]);
  });
});

describe("readReco", () => {
  const store = (value) => ({ getItem: () => value });

  it("reads a valid snapshot", () => {
    expect(readReco(store('{"artists":[{"name":"A"}]}'))).toEqual({ artists: [{ name: "A" }] });
  });

  it("is null when the key is missing or the JSON is bad", () => {
    expect(readReco(store(null))).toBeNull();
    expect(readReco(store("{no"))).toBeNull();
    expect(readReco(store("5"))).toBeNull();
  });

  it("is null when the storage throws or does not exist", () => {
    expect(
      readReco({
        getItem: () => {
          throw new Error("bloqueado");
        },
      })
    ).toBeNull();
    expect(readReco(null)).toBeNull();
  });
});
