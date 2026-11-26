import { describe, expect, it, vi } from "vitest";
import { NEW_LIST_VIEW, openNewList } from "./newList.js";

describe("una sola accion para nueva lista", () => {
  it("desde el riel o una pagina sin ctx salta a la pagina de listas", () => {
    const nav = { goTo: vi.fn() };
    openNewList(nav, null);
    expect(nav.goTo).toHaveBeenCalledWith("library", NEW_LIST_VIEW);
  });

  it("desde una pantalla con ctx reutiliza la pagina abierta", () => {
    const nav = { goTo: vi.fn() };
    const ctx = { goTo: vi.fn() };
    openNewList(nav, ctx);
    expect(ctx.goTo).toHaveBeenCalledWith(NEW_LIST_VIEW);
    expect(nav.goTo).not.toHaveBeenCalled();
  });

  it("el destino es siempre el mismo", () => {
    expect(NEW_LIST_VIEW).toEqual({ type: "all", what: "lists", naming: true });
  });
});
