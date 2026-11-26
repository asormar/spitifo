import { describe, expect, it } from "vitest";
import {
  PLAYLIST_FILTERS,
  ariaSortOf,
  cycleSort,
  duplicateKeys,
  filterRows,
  foldersOf,
  looseOf,
  membersOf,
  mosaicSources,
  parseViewMap,
  sortRows,
  viewOf,
  withView,
} from "./libraryView.js";

const songs = [
  { key: "A/a.mp3", title: "Zeta", artist: "ROSALÍA", album: "Motomami", duration: 193, added: 3, downloaded: true, verdict: "match" },
  { key: "A/b.mp3", title: "Ámbar", artist: "Bad Bunny", album: "Un Verano", duration: 166, added: 2, downloaded: false, verdict: "unv" },
  { key: "A/c.mp3", title: "zeta", artist: "ROSALÍA", album: "Motomami", duration: 100, added: 1, downloaded: false },
];

describe("vista lista/cuadrícula por pestaña", () => {
  it("guarda una vista distinta para cada pestaña", () => {
    let map = {};
    map = withView(map, "listen", "list");
    map = withView(map, "search", "grid");
    expect(viewOf(map, "listen")).toBe("list");
    expect(viewOf(map, "search")).toBe("grid");
    expect(viewOf(map, "home")).toBe("grid");
  });

  it("ignora lo que no es una vista y rechaza basura guardada", () => {
    expect(withView({ listen: "list" }, "listen", "rara")).toEqual({ listen: "list" });
    expect(parseViewMap("no es json")).toEqual({});
    expect(parseViewMap('{"listen":"list","search":"rara","home":3}')).toEqual({ listen: "list" });
    expect(parseViewMap("[]")).toEqual({});
  });
});

describe("columnas que ordenan de verdad", () => {
  it("cicla ascendente, descendente, original", () => {
    const a = cycleSort(null, "title");
    expect(a).toEqual({ key: "title", dir: 1 });
    expect(cycleSort(a, "title")).toEqual({ key: "title", dir: -1 });
    expect(cycleSort(cycleSort(a, "title"), "title")).toEqual({ key: null, dir: 0 });
    expect(cycleSort(cycleSort(a, "title"), "artist")).toEqual({ key: "artist", dir: 1 });
  });

  it("aria-sort dice el estado y el original no ordena", () => {
    expect(ariaSortOf({ key: "title", dir: 1 }, "title")).toBe("ascending");
    expect(ariaSortOf({ key: "title", dir: -1 }, "title")).toBe("descending");
    expect(ariaSortOf({ key: "title", dir: 0 }, "title")).toBe("none");
    expect(ariaSortOf({ key: "title", dir: 1 }, "artist")).toBe("none");
    expect(sortRows(songs, { key: "title", dir: 0 })).toEqual(songs);
  });

  it("ordena texto insensible a acentos y mayusculas, y numeros", () => {
    expect(sortRows(songs, { key: "title", dir: 1 }).map((s) => s.key)).toEqual(["b", "a", "c"].map((x) => `A/${x}.mp3`));
    expect(sortRows(songs, { key: "duration", dir: -1 }).map((s) => s.key)).toEqual(["A/a.mp3", "A/b.mp3", "A/c.mp3"]);
    expect(sortRows(songs, { key: "artist", dir: 1 })[0].key).toBe("A/b.mp3");
  });
});

describe("buscar y filtrar dentro de una lista", () => {
  it("detecta duplicados por titulo y artista", () => {
    expect([...duplicateKeys(songs)]).toEqual(["A/a.mp3", "A/c.mp3"]);
  });

  it("busca en titulo, artista y album", () => {
    expect(filterRows(songs, { query: "verano" }).map((s) => s.key)).toEqual(["A/b.mp3"]);
    expect(filterRows(songs, { query: "rosalia moto" }).map((s) => s.key)).toEqual(["A/a.mp3", "A/c.mp3"]);
  });

  it("combina filtros con AND", () => {
    expect(filterRows(songs, { filters: ["downloaded"] }).map((s) => s.key)).toEqual(["A/a.mp3"]);
    expect(filterRows(songs, { filters: ["unverified"] }).map((s) => s.key)).toEqual(["A/b.mp3", "A/c.mp3"]);
    expect(filterRows(songs, { filters: ["duplicates"] }).map((s) => s.key)).toEqual(["A/a.mp3", "A/c.mp3"]);
    expect(filterRows(songs, { filters: ["downloaded", "duplicates"] }).map((s) => s.key)).toEqual(["A/a.mp3"]);
    expect(PLAYLIST_FILTERS).toHaveLength(3);
  });
});

describe("carpetas y portadas", () => {
  const lists = [
    { id: "c1", name: "Viajes", is_folder: true, keys: ["l1", "l2"] },
    { id: "l1", name: "Tren", keys: ["A/a.mp3"] },
    { id: "l2", name: "Avión", keys: [] },
  ];

  it("separa carpetas de listas y saca sus miembros", () => {
    expect(foldersOf(lists).map((p) => p.id)).toEqual(["c1"]);
    expect(looseOf(lists).map((p) => p.id)).toEqual(["l1", "l2"]);
    expect(membersOf(lists, lists[0]).map((p) => p.id)).toEqual(["l1", "l2"]);
  });

  it("las portadas salen de las primeras canciones con imagen", () => {
    const byKey = new Map([
      ["A/a.mp3", { thumbKey: "A/a.jpg" }],
      ["A/b.mp3", { artworkUrl: "https://x/b.jpg" }],
    ]);
    const url = (key) => `/api/audio/${key}`;
    expect(mosaicSources(["A/a.mp3", "A/b.mp3", "A/x.mp3"], byKey, new Map(), url))
      .toEqual(["/api/audio/A/a.jpg", "https://x/b.jpg"]);
    expect(mosaicSources([], byKey, new Map(), url)).toEqual([]);
  });
});
