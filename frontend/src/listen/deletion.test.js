import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "./deferred.js";
import { albumDeleteCopy, failedNotice, isDrive } from "./deletion.js";

describe("albumDeleteCopy", () => {
  it("dice 'de este dispositivo' en la biblioteca local", () => {
    const copy = albumDeleteCopy({
      name: "Abbey Road", storage: "este dispositivo", count: 12, sizeMb: 94.5,
    });
    expect(copy.title).toBe("¿Borrar «Abbey Road» de este dispositivo?");
    expect(copy.body).toBe(
      "Las canciones también salen de las listas donde estén. Puedes descargarlas otra vez desde Buscar."
    );
    expect(copy.facts).toEqual([
      { label: "Canciones", value: "12" },
      { label: "Espacio que se libera", value: "95 MB" },
    ]);
    expect(copy.confirm).toBe("Borrar 12 canciones");
  });

  it("dice 'de tu Drive' cuando la biblioteca esta en la nube", () => {
    const copy = albumDeleteCopy({
      name: "Rumours", storage: "Google Drive · 12 GB", count: 11, sizeMb: 88,
    });
    expect(copy.title).toBe("¿Borrar «Rumours» de tu Drive?");
    expect(copy.facts.at(-1)).toEqual({ label: "Espacio que se libera", value: "88 MB" });
  });

  it("omite la linea de espacio cuando las filas no traen tamano", () => {
    const copy = albumDeleteCopy({
      name: "Sin datos", storage: "este dispositivo", count: 3, sizeMb: null,
    });
    expect(copy.facts).toEqual([{ label: "Canciones", value: "3" }]);
  });

  it("un album de una sola cancion habla en singular", () => {
    const copy = albumDeleteCopy({ name: "Rumours", storage: "este dispositivo", count: 1, sizeMb: 3.9 });
    expect(copy.confirm).toBe("Borrar 1 canción");
    expect(copy.body).toBe("La canción también sale de las listas donde esté. Puedes descargarla otra vez desde Buscar.");
  });

  it("reconoce Drive", () => {
    expect(isDrive("Google Drive · 5 GB")).toBe(true);
    expect(isDrive("este dispositivo")).toBe(false);
    expect(isDrive()).toBe(false);
  });

  it("el texto del fallo lleva el mismo nombre entre comillas", () => {
    expect(failedNotice("Abbey Road")).toBe("No se pudo borrar «Abbey Road»");
  });
});

describe("createDeferred (borrado diferido)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("el commit corre solo al terminar la ventana", () => {
    const run = vi.fn();
    const d = createDeferred(run);
    d.start(5000);
    expect(d.pending).toBe(true);
    vi.advanceTimersByTime(4999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(d.pending).toBe(false);
  });

  it("deshacer cancela el commit para siempre", () => {
    const run = vi.fn();
    const d = createDeferred(run);
    d.start(5000);
    d.cancel();
    vi.advanceTimersByTime(10000);
    expect(run).not.toHaveBeenCalled();
    expect(d.pending).toBe(false);
  });

  it("un segundo aviso adelanta el commit del anterior en vez de perderlo", () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = createDeferred(first);
    a.start(5000);
    vi.advanceTimersByTime(1000);
    // show() de un aviso nuevo llama a flush() sobre el pendiente.
    a.flush();
    expect(first).toHaveBeenCalledTimes(1);
    const b = createDeferred(second);
    b.start(5000);
    vi.advanceTimersByTime(5000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("flush despues de deshacer o de vencer no repite nada", () => {
    const run = vi.fn();
    const undone = createDeferred(run);
    undone.start(5000);
    undone.cancel();
    undone.flush();
    expect(run).not.toHaveBeenCalled();

    const expired = createDeferred(run);
    expired.start(5000);
    vi.advanceTimersByTime(5000);
    expired.flush();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
