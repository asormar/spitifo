import { describe, expect, it } from "vitest";
import { placePop } from "./Sheet.jsx";

const rect = (top, bottom, right) => ({ top, bottom, right });

describe("placePop", () => {
  it("opens below the button, aligned to its right edge", () => {
    const p = placePop({ anchor: rect(100, 140, 900), vw: 1280, vh: 800, natural: 240, width: 300 });
    expect(p).toMatchObject({ top: 146, left: 600, width: 300, up: false });
    expect(p.maxH).toBe(800 - 146 - 8);
  });

  it("flips up when it does not fit below and there is more room above", () => {
    const p = placePop({ anchor: rect(700, 740, 900), vw: 1280, vh: 800, natural: 240, width: 300 });
    expect(p.up).toBe(true);
    expect(p.top).toBe(700 - 6 - 240);
    expect(p.maxH).toBe(700 - 6 - 8);
  });

  it("stays below when neither side fits but below has more room", () => {
    const p = placePop({ anchor: rect(100, 140, 900), vw: 1280, vh: 300, natural: 500, width: 300 });
    expect(p.up).toBe(false);
    expect(p.top).toBe(146);
  });

  it("keeps the box inside the window on the left and on narrow windows", () => {
    expect(placePop({ anchor: rect(10, 50, 120), vw: 1280, vh: 800, natural: 100, width: 272 }).left).toBe(8);
    const narrow = placePop({ anchor: rect(10, 50, 290), vw: 300, vh: 800, natural: 100, width: 300 });
    expect(narrow.width).toBe(284);
    expect(narrow.left).toBe(8);
  });

  it("never gives less than 140 px of height", () => {
    const p = placePop({ anchor: rect(40, 80, 900), vw: 1280, vh: 120, natural: 400, width: 300 });
    expect(p.maxH).toBe(140);
  });
});
