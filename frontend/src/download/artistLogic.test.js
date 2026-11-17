import { describe, expect, it } from "vitest";
import {
  albumOwnership,
  artistHero,
  artistIdFromEntries,
  bestArtwork,
  bestMatch,
  buildChecklist,
  checklistTotals,
  downloadButton,
  enqueueBatches,
  exactArtist,
  initialSelections,
  isArtistNameMatch,
  ownedSongsByArtist,
  runDiscography,
} from "./artistLogic.js";

const release = (id, extra = {}) => ({
  id,
  title: `Disco ${id}`,
  artist: "Soda Stereo",
  year: "1990",
  track_count: 10,
  artwork_url: `http://x/${id}.jpg`,
  ...extra,
});

const track = (n, extra = {}) => ({
  source: "itunes",
  source_id: `t${n}`,
  title: `Cancion ${n}`,
  extra: { disc_number: 1, track_number: n, has_full: true, ...extra },
});

const lib = (album_id, track_no, artist = "Soda Stereo") => ({
  album_id: String(album_id),
  disc_no: 1,
  track_no,
  artist,
});

describe("Mejor resultado", () => {
  it("acepta el nombre exacto sin importar tildes ni mayusculas", () => {
    expect(isArtistNameMatch("Soda Stereo", "Soda Stereo")).toBe(true);
    expect(isArtistNameMatch("soda stereo", "Soda Stereo")).toBe(true);
    expect(isArtistNameMatch("Ñandú", "nandu")).toBe(true);
  });

  it("acepta solo la diferencia de articulo inicial", () => {
    expect(isArtistNameMatch("the beatles", "Beatles")).toBe(true);
    expect(isArtistNameMatch("Beatles", "The Beatles")).toBe(true);
    expect(isArtistNameMatch("los fabulosos", "Fabulosos")).toBe(true);
    expect(isArtistNameMatch("las vocales", "Vocales")).toBe(true);
  });

  it("rechaza texto que no nombra al artista", () => {
    expect(isArtistNameMatch("beatles en vivo", "The Beatles")).toBe(false);
    expect(isArtistNameMatch("rock", "Soda Stereo")).toBe(false);
    expect(isArtistNameMatch("", "Soda Stereo")).toBe(false);
  });

  it("mira solo el primer resultado y no muestra nada si no hay coincidencia", () => {
    const results = [{ id: 1, name: "The Beatles", genre: "Rock" }, { id: 2, name: "Soda Stereo" }];
    expect(bestMatch("beatles", results)).toBe(results[0]);
    expect(bestMatch("rock", results)).toBe(null);
    expect(bestMatch("beatles", [])).toBe(null);
    expect(bestMatch("", results)).toBe(null);
  });

  it("usa la portada del disco mas nuevo del mismo artista", () => {
    const albums = [
      { artist_id: 7, year: "1988", artwork_url: "vieja.jpg" },
      { artist_id: 7, year: "1995", artwork_url: "nueva.jpg" },
      { artist_id: 9, year: "2001", artwork_url: "otra.jpg" },
    ];
    expect(bestArtwork({ id: 7 }, albums)).toBe("nueva.jpg");
    expect(bestArtwork({ id: 42 }, albums)).toBe(null);
  });

  it("el enlace de Escuchar exige nombre exacto, sin articulo", () => {
    const results = [{ id: 1, name: "The Doors" }, { id: 2, name: "Doors" }];
    expect(exactArtist("the doors", results)).toBe(results[0]);
    expect(exactArtist("Doors", results)).toBe(results[1]);
    expect(exactArtist("the doors", [results[1]])).toBe(null);
  });

  it("toma el id de iTunes de cualquier cancion guardada del artista", () => {
    const entries = [lib(1, 1, "Otro"), { artist: "Soda Stereo", artist_id: "77" }];
    expect(artistIdFromEntries(entries, "soda stereo")).toBe("77");
    expect(artistIdFromEntries(entries, "Nadie")).toBe(null);
    expect(artistIdFromEntries([{ artist: "Soda Stereo", artist_id: null }], "Soda Stereo")).toBe(null);
  });
});

describe("cuentas de lo que ya tienes", () => {
  it("cuenta los huecos del disco por id de iTunes", () => {
    const entries = [lib(10, 1), lib(10, 3), lib(11, 2)];
    expect(albumOwnership(release(10), entries)).toMatchObject({ have: 2, total: 10, missing: 8, full: false, label: "2 de 10" });
  });

  it("dice «La tienes» cuando estan todos", () => {
    const entries = Array.from({ length: 3 }, (_, i) => lib(10, i + 1));
    expect(albumOwnership(release(10, { track_count: 3 }), entries)).toMatchObject({ have: 3, full: true, missing: 0, label: "La tienes" });
  });

  it("no confunde un disco sin pistas con uno entero", () => {
    expect(albumOwnership(release(10, { track_count: 0 }), [lib(10, 1)]).full).toBe(false);
  });

  it("cuenta las canciones de la biblioteca por nombre de artista", () => {
    expect(ownedSongsByArtist([lib(1, 1), lib(2, 1, "Soda Stereo"), lib(3, 1, "Otro")], "soda stereo")).toBe(2);
  });

  it("la linea del hero solo dice lo que no es cero", () => {
    const sections = { albums: [release(1)], live: [release(2), release(3)], compilations: [], singles: [] };
    expect(artistHero(sections, "Soda Stereo", [lib(1, 1)])).toBe("1 álbum · 2 en vivo · tienes 1 canción");
    expect(artistHero({ albums: [], live: [], compilations: [], singles: [] }, "Nadie", [])).toBe("");
  });
});

describe("lista de descarga", () => {
  const sections = () => ({
    albums: [release(1), release(2, { track_count: 2 })],
    live: [release(3)],
    compilations: [],
    singles: [release(4, { track_count: 1 })],
  });

  it("solo Estudio empieza marcado y se saltan los grupos vacios", () => {
    const groups = buildChecklist(sections(), []);
    expect(groups.map((g) => g.id)).toEqual(["albums", "live", "singles"]);
    expect(groups[0].rows.every((r) => r.checked)).toBe(true);
    expect(groups[1].rows.every((r) => !r.checked)).toBe(true);
    expect(groups[2].rows.every((r) => !r.checked)).toBe(true);
  });

  it("un disco entero tuyo queda desmarcado y deshabilitado", () => {
    const own = [lib(2, 1), lib(2, 2)];
    const groups = buildChecklist(sections(), own);
    const row = groups[0].rows.find((r) => r.release.id === 2);
    expect(row).toMatchObject({ checked: false, disabled: true, full: true, sub: "ya la tienes entera" });
    expect(initialSelections(groups)[2]).toBe(false);
  });

  it("el subline dice cuantas faltan cuando tienes parte", () => {
    const row = buildChecklist(sections(), [lib(1, 1)])[0].rows[0];
    expect(row.sub).toBe("te faltan 9 de 10");
    expect(buildChecklist(sections(), [])[0].rows[0].sub).toBe("1990 · 10 canciones");
  });

  it("el total cuenta solo lo que falta de los discos elegidos", () => {
    const groups = buildChecklist(sections(), [lib(1, 1), lib(2, 1), lib(2, 2)]);
    const sel = initialSelections(groups);
    // Solo el disco 1 de Estudio empieza marcado, y te falta 1 de sus 10.
    expect(checklistTotals(groups, sel)).toEqual({ songs: 9, mb: Math.round(9 * 4.1) });
    // El disco 2 esta entero (deshabilitado): marcarlo no suma nada.
    const all = { ...sel, 2: true, 3: true, 4: true };
    expect(checklistTotals(groups, all)).toEqual({ songs: 9 + 10 + 1, mb: Math.round(20 * 4.1) });
    expect(checklistTotals(groups, {})).toEqual({ songs: 0, mb: 0 });
    expect(downloadButton(checklistTotals(groups, {}))).toEqual({ text: "Elige al menos un álbum", disabled: true });
    expect(downloadButton({ songs: 1, mb: 4 })).toEqual({ text: "Descargar 1 canción", disabled: false });
  });
});

describe("orden de encolado", () => {
  const match = (n) => ({
    tracks: [track(n), track(n + 100, { has_full: false }), track(n + 200, { has_full: true })],
  });

  it("salta pistas ya tuyas y sin version completa", () => {
    const batches = enqueueBatches(
      [release(1)],
      { 1: match(1) },
      { 1: new Set(["1-1"]) },
      () => "Soda Stereo Disco 1"
    );
    expect(batches).toHaveLength(1);
    expect(batches[0].group.id).toBe("album:1");
    // Solo la pista 201: la 1 es tuya y la 101 es solo preview.
    expect(batches[0].items.map((i) => i.track.extra.track_number)).toEqual([201]);
    expect(batches[0].items[0]).toMatchObject({ fmt: "m4a", media: "audio", query: "Soda Stereo Disco 1" });
  });

  it("no encola un disco que no dejo ninguna pista", () => {
    expect(enqueueBatches([release(1)], {}, {})).toEqual([]);
  });

  it("runDiscography empareja y encola un disco por vuelta, en orden", async () => {
    const events = [];
    const selected = [release(1), release(2), release(3)];
    const matches = { 1: match(1), 2: match(2), 3: match(3) };
    // La primera pista del disco 2 ya es tuya.
    const owned = { 2: new Set(["1-2"]) };
    const ids = await runDiscography({
      selected,
      fetchMatch: async (id) => {
        events.push(`match:${id}`);
        return matches[id];
      },
      enqueue: async (b) => {
        events.push(`enqueue:${b.group.id}`);
      },
      owned,
      queryFor: () => "q",
    });
    expect(ids).toEqual(["album:1", "album:2", "album:3"]);
    expect(events).toEqual([
      "match:1", "enqueue:album:1",
      "match:2", "enqueue:album:2",
      "match:3", "enqueue:album:3",
    ]);
  });

  it("si un match falla avisa y sigue con el siguiente", async () => {
    const failed = [];
    const ids = await runDiscography({
      selected: [release(1), release(2)],
      fetchMatch: async (id) => {
        if (id === 1) throw new Error("yt caido");
        return match(2);
      },
      enqueue: async () => {},
      onFail: (r) => failed.push(r.id),
    });
    expect(failed).toEqual([1]);
    expect(ids).toEqual(["album:2"]);
  });

  it("si falla el POST de un disco avisa y no detiene los demas", async () => {
    const failed = [];
    const ids = await runDiscography({
      selected: [release(1), release(2)],
      fetchMatch: async (id) => match(id),
      enqueue: async (b) => {
        if (b.group.id === "album:1") throw new Error("sin red");
      },
      onFail: (r) => failed.push(r.id),
    });
    expect(failed).toEqual([1]);
    expect(ids).toEqual(["album:2"]);
  });
});
