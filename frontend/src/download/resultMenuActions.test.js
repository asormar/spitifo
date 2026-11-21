import { afterEach, describe, expect, it, vi } from "vitest";
import { pickResultAction } from "./resultMenuActions.js";
import { trackSpec } from "./albumText.js";
import { rowKey } from "../shared/api.js";
import { queueStore } from "./queueStore.js";
import { engine } from "../player/engine.js";

afterEach(() => vi.restoreAllMocks());

/* Un resultado completo con ficha de album: lo que sale en el ⋯ de un stream. */
const t = {
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

const nav = () => ({
  back: vi.fn(),
  open: vi.fn(),
  goTo: vi.fn(),
});

describe("pickResultAction: acciones del ⋯ con callbacks inyectados", () => {
  it("download encola con el formato que pide el menu y cierra la hoja", async () => {
    const n = nav();
    const fmt = "flac";
    const enqueue = vi.spyOn(queueStore, "enqueue").mockImplementation(() => {});
    const show = vi.fn();
    const anchor = { tagName: "BUTTON" };
    await pickResultAction("download", {
      t,
      nav: n,
      show,
      anchor,
      onDownload: (one) => enqueue({ items: [{ ...trackSpec(one, ""), fmt }] }),
    });
    expect(n.back).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith({ items: [{ ...trackSpec(t, ""), fmt: "flac" }] });
    expect(n.open).not.toHaveBeenCalled();
  });

  it("next y end ponen la pista del resultado en la cola", async () => {
    const next = vi.spyOn(engine, "playNext").mockImplementation(() => true);
    const end = vi.spyOn(engine, "enqueue").mockImplementation(() => true);
    const n = nav();
    await pickResultAction("next", { t, nav: n, show: vi.fn() });
    await pickResultAction("end", { t, nav: n, show: vi.fn() });
    expect(n.back).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ key: "stream:https://youtu.be/abcdefghijk" }));
    expect(end).toHaveBeenCalledWith(expect.objectContaining({ key: "stream:https://youtu.be/abcdefghijk" }));
  });

  it("«Ir al álbum» del menu de Ahora suena cierra la vista antes de abrir la pagina", async () => {
    const order = [];
    const n = nav();
    const leaveNp = (then) => {
      order.push("leaveNp");
      then?.();
      return true;
    };
    const goTo = (v) => order.push(`goTo:${v.type}`);
    await pickResultAction("album", {
      t,
      nav: n,
      closeMenu: false,
      show: vi.fn(),
      onAlbum: (one) => {
        expect(one).toBe(t);
        if (leaveNp(() => goTo({ type: "albumsheet", id: "123" }))) return;
        goTo({ type: "albumsheet", id: "123" });
      },
    });
    /* Sin back suelto: el menu y la vista salen juntos del unwind. */
    expect(n.back).not.toHaveBeenCalled();
    expect(n.open).not.toHaveBeenCalled();
    expect(order).toEqual(["leaveNp", "goTo:albumsheet"]);
  });

  it("«Ir al artista» cierra la vista antes de abrir la pagina del artista", async () => {
    const order = [];
    const n = nav();
    const goTo = (v) => order.push(`goTo:${v.type}`);
    await pickResultAction("artist", {
      t,
      nav: n,
      closeMenu: false,
      show: vi.fn(),
      onArtist: (one) => {
        expect(one).toBe(t);
        order.push("leaveNp");
        goTo({ type: "itunesartist", id: 456 });
      },
    });
    expect(n.back).not.toHaveBeenCalled();
    expect(n.goTo).not.toHaveBeenCalled();
    expect(order).toEqual(["leaveNp", "goTo:itunesartist"]);
  });

  it("«Ver ficha» en Buscar cierra el menu y abre la hoja", async () => {
    const n = nav();
    await pickResultAction("ficha", { t, nav: n, show: vi.fn(), anchor: "ancla" });
    expect(n.back).toHaveBeenCalledOnce();
    expect(n.open).toHaveBeenCalledWith({ type: "ficha", key: expect.any(String), t, anchor: "ancla" });
    expect(n.goTo).not.toHaveBeenCalled();
  });

  it("«Ver ficha» del menu de Ahora suena abre la hoja encima sin cerrar la vista", async () => {
    const n = nav();
    const replace = vi.fn();
    await pickResultAction("ficha", {
      t,
      nav: n,
      show: vi.fn(),
      anchor: "ancla",
      closeMenu: false,
      onFicha: (one, anchor) => replace({ type: "ficha", key: rowKey(one), t: one, anchor }),
    });
    expect(n.back).not.toHaveBeenCalled();
    expect(n.open).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith({ type: "ficha", key: rowKey(t), t, anchor: "ancla" });
  });
});
