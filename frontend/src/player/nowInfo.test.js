import { describe, expect, it } from "vitest";
import { queueNote, sourceCaption, splitMeta } from "./nowInfo.js";

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
