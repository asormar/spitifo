import { describe, expect, it } from "vitest";
import { candidateMeta, finderReducer, initialFinder, previewUrl } from "./coverFinder.js";

const items = [{ key: "A/uno.mp3" }, { key: "A/dos.mp3" }];
const ready = finderReducer(initialFinder, { type: "loaded", items });

describe("finderReducer", () => {
  it("arranca listo con la cola, o vacio si no hay temas", () => {
    expect(ready).toMatchObject({ status: "ready", idx: 0, items });
    expect(finderReducer(initialFinder, { type: "loaded", items: [] }).status).toBe("empty");
    expect(finderReducer(initialFinder, { type: "loaded" }).status).toBe("empty");
  });

  it("cuenta guardadas, saltadas y las que ya tenian portada", () => {
    let s = finderReducer(ready, { type: "saved" });
    expect(s).toMatchObject({ idx: 1, saved: 1, status: "ready" });
    s = finderReducer(s, { type: "taken" });
    expect(s).toMatchObject({ idx: 2, taken: 1, status: "done" });
  });

  it("saltar avanza sin guardar nada", () => {
    const s = finderReducer(ready, { type: "skip" });
    expect(s).toMatchObject({ idx: 1, skipped: 1, saved: 0 });
  });

  it("ignora avances fuera de la cola lista", () => {
    const done = finderReducer(ready, { type: "finish" });
    expect(done.status).toBe("done");
    expect(finderReducer(done, { type: "saved" })).toBe(done);
    expect(finderReducer(initialFinder, { type: "skip" })).toBe(initialFinder);
  });

  it("guarda el error de la carga", () => {
    const s = finderReducer(initialFinder, { type: "failed", error: "sin red" });
    expect(s).toMatchObject({ status: "error", error: "sin red" });
  });
});

describe("ayudas de la vista", () => {
  it("pide la variante de 200 px para mostrar", () => {
    expect(previewUrl("https://a.mzstatic.com/x/300x300bb.jpg")).toBe(
      "https://a.mzstatic.com/x/200x200bb.jpg",
    );
    expect(previewUrl(null)).toBeNull();
  });

  it("arma la linea de datos sin huecos", () => {
    expect(candidateMeta({ artist: "Cerati", album: "", year: "1999" })).toBe("Cerati · 1999");
    expect(candidateMeta({})).toBe("");
  });
});
