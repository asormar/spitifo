import { describe, expect, it, vi } from "vitest";
import { backLabel, backToLabel, crossGo, crossTarget, destinationLabel } from "./crossMode.js";

describe("saltos de entidad sin perder el camino de vuelta", () => {
  const origin = { tab: "library", label: "Motomami" };

  it("el contenido local se abre en la pila actual", () => {
    const nav = { open: vi.fn(), goTo: vi.fn() };
    const view = { type: "artist", id: "r1" };
    expect(crossTarget(view, origin)).toEqual({ kind: "open", view });
    expect(crossGo(nav, view, origin)).toBe(true);
    expect(nav.open).toHaveBeenCalledWith(view);
    expect(nav.goTo).not.toHaveBeenCalled();
  });

  it("el catalogo salta a Buscar con el origen pegado a la pagina", () => {
    const nav = { open: vi.fn(), goTo: vi.fn() };
    const view = { type: "itunesartist", id: "77", name: "ROSALÍA" };
    expect(crossGo(nav, view, origin)).toBe(true);
    expect(nav.open).not.toHaveBeenCalled();
    expect(nav.goTo).toHaveBeenCalledWith("search", { ...view, origin });
  });

  it("desde Buscar el catalogo se apila sin sustituir la pila", () => {
    const nav = { tab: "search", open: vi.fn(), goTo: vi.fn() };
    const view = { type: "itunesartist", id: "77" };
    expect(crossGo(nav, view, origin)).toBe(true);
    expect(nav.open).toHaveBeenCalledWith({ ...view, origin });
    expect(nav.goTo).not.toHaveBeenCalled();
  });

  it("una vista sin tipo no navega", () => {
    const nav = { open: vi.fn(), goTo: vi.fn() };
    expect(crossGo(nav, null, origin)).toBe(false);
    expect(nav.open).not.toHaveBeenCalled();
    expect(nav.goTo).not.toHaveBeenCalled();
  });

  it("la migaja nombra el destino", () => {
    expect(backLabel("Mezcla del viernes")).toBe("Volver a Mezcla del viernes");
    expect(backLabel("")).toBe("Volver");
  });
});

describe("los botones de Volver dicen adonde van", () => {
  it("Ajustes vuelve a la pestana que estaba debajo", () => {
    expect(destinationLabel({ tab: "discover", stack: [{ type: "settings" }] })).toBe("Descubrir");
  });

  it("una pagina «Ver todo» nombra su seccion", () => {
    expect(backToLabel({ tab: "library", stack: [{ type: "all", what: "lists" }] })).toBe("Volver a Tus listas");
  });

  it("una entidad usa su nombre si lo trae y su tipo si no", () => {
    expect(backToLabel({ tab: "home", stack: [{ type: "list", name: "Mezcla del viernes" }] })).toBe("Volver a Mezcla del viernes");
    expect(backToLabel({ tab: "home", stack: [{ type: "album", id: "168" }] })).toBe("Volver a Álbum");
  });

  it("una hoja encima no cambia el destino de la pagina", () => {
    expect(destinationLabel({ tab: "home", stack: [{ type: "album", id: "1" }, { type: "menu", key: "k" }] })).toBe("Álbum");
  });

  it("en la raiz no hay destino que nombrar", () => {
    expect(destinationLabel({ tab: "home", stack: [] })).toBeNull();
    expect(backToLabel({ tab: "home", stack: [] })).toBe("Volver");
  });
});
