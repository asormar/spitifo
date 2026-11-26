import { describe, expect, it } from "vitest";
import { npMenuKey, npMenuKind } from "./npMenu.js";
import { npMenuGroups } from "../download/npResultGroups.js";

/* Resultado de Buscar con ficha de album: es lo que lleva un stream suelto
   cuando se abre "Ahora suena" y se toca el ⋯. */
const stream = {
  source: "itunes",
  source_id: "1",
  title: "Creep",
  artist: "Radiohead",
  album: "Pablo Honey",
  extra: {
    webpage_url: "https://youtu.be/abcdefghijk",
    collection_id: 123,
    artist_id: 456,
  },
};

describe("menu ⋯ de Ahora suena: que menu toca", () => {
  const byKey = new Map([["file:creep", { title: "Creep" }]]);

  it("una cancion con fila en la biblioteca usa el menu de Tu biblioteca", () => {
    const menuKey = npMenuKey({ library: true, byKey, record: null, key: "file:creep", sid: null });
    expect(menuKey).toBe("file:creep");
    expect(npMenuKind({ byKey, record: null, result: stream, menuKey })).toBe("menu");
  });

  it("un stream guardado usa la ficha guardada, aunque no tenga fila", () => {
    const record = { file_key: "file:guardada" };
    const menuKey = npMenuKey({ library: false, byKey, record, key: "stream:x", sid: "sid:1" });
    expect(menuKey).toBe("file:guardada");
    expect(npMenuKind({ byKey, record, result: stream, menuKey })).toBe("menu");
  });

  it("un stream suelto cae al menu de resultados", () => {
    const menuKey = npMenuKey({ library: false, byKey, record: null, key: "sid:1", sid: "sid:1" });
    expect(menuKey).toBe("sid:1");
    expect(npMenuKind({ byKey, record: null, result: stream, menuKey })).toBe("npmenu");
  });

  it("sin entrada y sin resultado no hay ⋯ que abrir", () => {
    expect(npMenuKind({ byKey, record: null, result: null, menuKey: "sid:1" })).toBe(null);
  });
});

describe("grupos del menu ⋯ de un stream suelto", () => {
  it("Escuchar, Tu biblioteca con el formato, Ir a, Archivo y Reproductor al final", () => {
    const groups = npMenuGroups(stream, { fmt: "flac" });
    expect(groups.map((g) => g.label)).toEqual([
      "Escuchar", "Tu biblioteca", "Ir a", "Archivo", "Reproductor",
    ]);
    expect(groups[0].items.map((i) => i.kind)).toEqual(["next", "end"]);
    expect(groups[1].items[0]).toEqual({ kind: "download", icon: "DownloadSimple", text: "Descargar", sub: "flac" });
    expect(groups[2].items.map((i) => i.text)).toEqual([
      "Ir al álbum «Pablo Honey»",
      "Ir a Radiohead",
    ]);
    expect(groups[3].items[0].kind).toBe("ficha");
    expect(groups[4].items).toEqual([{ kind: "closePlayer", icon: "X", text: "Cerrar reproductor" }]);
  });

  it("«Ir al álbum» solo sale cuando se puede abrir la ficha del disco", () => {
    const withoutSheet = {
      ...stream,
      extra: { webpage_url: "https://youtu.be/abcdefghijk", artist_id: 456 },
    };
    const groups = npMenuGroups(withoutSheet, { fmt: "m4a" });
    expect(groups[1].label).toBe("Tu biblioteca");
    expect(groups[2].items.map((i) => i.text)).toEqual(["Ir a Radiohead"]);
    expect(groups.at(-1).label).toBe("Reproductor");
  });

  it("sin album ni artista no hay grupo «Ir a», pero si Cerrar reproductor", () => {
    const bare = {
      source: "itunes",
      source_id: "2",
      title: "Tema",
      extra: { webpage_url: "https://youtu.be/xyz12345678" },
    };
    const groups = npMenuGroups(bare, { fmt: "m4a" });
    expect(groups.map((g) => g.label)).toEqual([
      "Escuchar", "Tu biblioteca", "Archivo", "Reproductor",
    ]);
    expect(groups.at(-1).items[0].kind).toBe("closePlayer");
  });
});
