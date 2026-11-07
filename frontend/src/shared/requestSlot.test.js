import { describe, expect, it, vi } from "vitest";
import { createRequestSlot } from "./requestSlot.js";

describe("requestSlot", () => {
  it("entrega el pedido una sola vez", () => {
    const s = createRequestSlot();
    s.request("chopin");
    expect(s.take()).toBe("chopin");
    expect(s.take()).toBeNull();
  });

  it("recorta el texto y se queda con el ultimo pedido", () => {
    const s = createRequestSlot();
    s.request("  jazz ");
    s.request("rock");
    expect(s.take()).toBe("rock");
  });

  it("ignora un pedido vacio o solo de espacios", () => {
    const s = createRequestSlot();
    const fn = vi.fn();
    s.subscribe(fn);
    s.request("");
    s.request("   ");
    s.request(null);
    expect(fn).not.toHaveBeenCalled();
    expect(s.take()).toBeNull();
  });

  it("avisa a los suscriptores y deja de avisar al darse de baja", () => {
    const s = createRequestSlot();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.request("a");
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    s.request("b");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("dos slots no se pisan", () => {
    const a = createRequestSlot();
    const b = createRequestSlot();
    a.request("x");
    expect(b.take()).toBeNull();
    expect(a.take()).toBe("x");
  });
});
