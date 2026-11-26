import { describe, expect, it } from "vitest";
import { menuAnchorFor } from "./longPress.js";

describe("menuAnchorFor", () => {
  it("finds the more button of the row that owns the cover", () => {
    const more = { name: "more" };
    const row = {
      closest: () => row,
      querySelector: (selector) => (selector.includes("aria-haspopup") ? more : null),
    };
    const img = { closest: () => row };
    expect(menuAnchorFor(img)).toBe(more);
  });

  it("does nothing for an image outside a menu-bearing row", () => {
    expect(menuAnchorFor(null)).toBeNull();
    expect(menuAnchorFor({ closest: () => null })).toBeNull();
    const row = { closest: () => row, querySelector: () => null };
    expect(menuAnchorFor({ closest: () => row })).toBeNull();
  });
});
