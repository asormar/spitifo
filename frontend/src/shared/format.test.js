import { describe, expect, it } from "vitest";
import { percent, percentLabel } from "./format.js";

describe("percent", () => {
  it("rounds shares and keeps the sub-one-percent case honest", () => {
    expect(percent(0.38)).toBe("38 %");
    expect(percent(0.004)).toBe("<1 %");
    expect(percent(1)).toBe("100 %");
  });
});

describe("percentLabel", () => {
  it("says the share is of your listening, so the column is not ambiguous", () => {
    expect(percentLabel(0.38)).toBe("38 % de tus escuchas");
    expect(percentLabel(0)).toBe("<1 % de tus escuchas");
  });
});
