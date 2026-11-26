import { describe, expect, it } from "vitest";
import { dlState, dlText, dlWaiting } from "./dlState.js";

describe("estado de una fila", () => {
  it("espera Wi-Fi / roaming con texto propio", () => {
    expect(dlState({ job: { status: "queued", phase: "waiting_wifi" } }).id).toBe("waitwifi");
    expect(dlText(dlState({ job: { status: "queued", phase: "waiting_wifi" } }))).toBe("Esperando Wi-Fi");
    expect(dlText(dlState({ job: { status: "queued", phase: "waiting_roaming" } }))).toBe("Esperando sin roaming");
    expect(dlWaiting(dlState({ job: { status: "queued", phase: "waiting_wifi" } }))).toBe(true);
  });

  it("la subida tiene su propio porcentaje", () => {
    const st = dlState({ job: { status: "processing", phase: "uploading", progress: 42 } });
    expect(st).toEqual({ id: "upload", pct: 42 });
    expect(dlText(st)).toBe("Subiendo, 42 %");
    expect(dlWaiting(st)).toBe(true);
  });

  it("guardar sigue siendo 100 %", () => {
    expect(dlState({ job: { status: "processing", phase: "saving" } }))
      .toEqual({ id: "save", pct: 100 });
  });
});
