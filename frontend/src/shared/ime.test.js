import { describe, expect, it } from "vitest";
import { isComposing } from "./ime.js";

describe("isComposing", () => {
  it("detecta la composicion en el evento nativo", () => {
    expect(isComposing({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(isComposing({ nativeEvent: { isComposing: false } })).toBe(false);
  });

  it("acepta el keyCode 229 de algunos WebViews", () => {
    expect(isComposing({ nativeEvent: { keyCode: 229 } })).toBe(true);
    expect(isComposing({ keyCode: 229 })).toBe(true);
  });

  it("un Enter normal no compone", () => {
    expect(isComposing({ nativeEvent: { keyCode: 13, isComposing: false } })).toBe(false);
    expect(isComposing({})).toBe(false);
    expect(isComposing(undefined)).toBe(false);
  });
});
