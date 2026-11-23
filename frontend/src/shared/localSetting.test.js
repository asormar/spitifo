import { afterEach, describe, expect, it, vi } from "vitest";
import { localSetting } from "./localSetting.js";

const fakeStorage = (values = {}) => ({
  getItem: (k) => (k in values ? values[k] : null),
  setItem: (k, v) => { values[k] = v; },
});

describe("localSetting", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("guarda, lee y avisa a los suscriptores; ignora un valor igual o invalido", () => {
    const saved = {};
    vi.stubGlobal("localStorage", fakeStorage(saved));
    const store = localSetting("clave", "a", {
      read: () => "a",
      write: (v) => v,
      valid: (v) => ["a", "b"].includes(v),
    });
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);

    expect(store.get()).toBe("a");
    store.set("b");
    expect(store.get()).toBe("b");
    expect(saved.clave).toBe("b");
    expect(notify).toHaveBeenCalledTimes(1);
    store.set("b");
    store.set("x");
    expect(store.get()).toBe("b");
    expect(notify).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.set("a");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("usa el default si la lectura falla y aplica el cambio sin almacen", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("bloqueado"); },
      setItem: () => { throw new Error("bloqueado"); },
    });
    const store = localSetting("clave", "a", {
      read: () => { throw new Error("bloqueado"); },
      write: (v) => v,
    });
    expect(store.get()).toBe("a");
    store.set("b");
    expect(store.get()).toBe("b");
  });
});
