import { describe, expect, it } from "vitest";
import {
  FLING,
  PEEK,
  listDrag,
  lockAxis,
  panelDecision,
  pickSnap,
  resist,
  sheetGeometry,
  snapName,
  swipeDecision,
  swipeOffset,
  swipeProgress,
  tabDecision,
} from "./gestures.js";

describe("sheetGeometry", () => {
  it("puts peek at 56 px, half near 45 % and full near 85 % of the map", () => {
    const g = sheetGeometry(600);
    expect(g.heights.peek).toBe(PEEK);
    expect(g.heights.half).toBe(270);
    expect(g.heights.full).toBe(510);
    expect(g.offsets).toEqual({ full: 0, half: 240, peek: 454 });
  });

  it("keeps the three points apart and ordered on tiny maps", () => {
    const g = sheetGeometry(200);
    expect(g.heights.peek).toBeLessThan(g.heights.half);
    expect(g.heights.half).toBeLessThan(g.heights.full);
    expect(g.offsets.full).toBeLessThan(g.offsets.half);
    expect(g.offsets.half).toBeLessThan(g.offsets.peek);
  });
});

describe("resist", () => {
  it("is the identity inside the range and slows down beyond it", () => {
    expect(resist(100, 0, 400)).toBe(100);
    expect(resist(-100, 0, 400)).toBeCloseTo(-30);
    expect(resist(500, 0, 400)).toBeCloseTo(430);
  });
});

describe("pickSnap", () => {
  const points = [0, 240, 454];

  it("goes to the nearest point when released slowly", () => {
    expect(pickSnap(100, 0, points)).toBe(0);
    expect(pickSnap(150, 0, points)).toBe(240);
    expect(pickSnap(400, 0, points)).toBe(454);
  });

  it("projects a gentle motion a little ahead", () => {
    /* 130 está más cerca de 0, pero un empujón suave hacia abajo lo lleva a 240. */
    expect(pickSnap(130, 400, points)).toBe(240);
    expect(pickSnap(130, -400, points)).toBe(0);
  });

  it("flings to the next point in that direction", () => {
    /* Parte de la mitad, apenas se movió, y lanza hacia arriba: abre del todo. */
    expect(pickSnap(236, -FLING - 100, points)).toBe(0);
    /* Lanza hacia abajo desde la mitad: se recoge. */
    expect(pickSnap(244, FLING + 100, points)).toBe(454);
    /* Lanza hacia arriba desde recogida: va a la mitad, no salta a la completa. */
    expect(pickSnap(450, -FLING - 100, points)).toBe(240);
  });

  it("clamps a fling at the ends", () => {
    expect(pickSnap(2, -2000, points)).toBe(0);
    expect(pickSnap(452, 2000, points)).toBe(454);
  });

  it("does not need sorted points", () => {
    expect(pickSnap(300, 0, [454, 0, 240])).toBe(240);
  });
});

describe("snapName", () => {
  it("names the closest point", () => {
    const offsets = { full: 0, half: 240, peek: 454 };
    expect(snapName(0, offsets)).toBe("full");
    expect(snapName(250, offsets)).toBe("half");
    expect(snapName(500, offsets)).toBe("peek");
  });
});

describe("listDrag", () => {
  it("lets the list scroll when the sheet is full", () => {
    expect(listDrag({ scrollTop: 120, dy: 30, atFull: true })).toBe("scroll");
    expect(listDrag({ scrollTop: 0, dy: -30, atFull: true })).toBe("scroll");
  });

  it("drags the sheet when the list is at the top and the user pulls down", () => {
    expect(listDrag({ scrollTop: 0, dy: 30, atFull: true })).toBe("sheet");
  });

  it("drags the sheet in any direction while it is not full", () => {
    expect(listDrag({ scrollTop: 0, dy: -30, atFull: false })).toBe("sheet");
    expect(listDrag({ scrollTop: 90, dy: 30, atFull: false })).toBe("sheet");
  });
});

describe("lockAxis", () => {
  it("waits until the finger has moved past the slop", () => {
    expect(lockAxis(2, 3, "y")).toBeNull();
  });

  it("starts when the motion follows the wanted axis", () => {
    expect(lockAxis(-12, 3, "x")).toBe("start");
    expect(lockAxis(2, 14, "y")).toBe("start");
  });

  it("cancels when the other axis wins, so the browser can scroll", () => {
    expect(lockAxis(3, 14, "x")).toBe("cancel");
    expect(lockAxis(14, 3, "y")).toBe("cancel");
  });
});

describe("swipe of a row", () => {
  it("only moves to the left, with a little give to the right", () => {
    expect(swipeOffset(-80, 300)).toBe(-80);
    expect(swipeOffset(-900, 300)).toBe(-300);
    expect(swipeOffset(100, 300)).toBeLessThanOrEqual(24);
    expect(swipeOffset(100, 300)).toBeGreaterThan(0);
  });

  it("dismisses past 35 % of the row and snaps back below it", () => {
    expect(swipeDecision(-106, 300)).toBe("dismiss");
    expect(swipeDecision(-104, 300)).toBe("snap");
    expect(swipeDecision(-40, 300)).toBe("snap");
    expect(swipeDecision(80, 300)).toBe("snap");
  });

  it("dismisses a quick flick to the left that did not go far", () => {
    expect(swipeDecision(-60, 300, -900)).toBe("dismiss");
    /* Un lanzamiento minúsculo no cuenta. */
    expect(swipeDecision(-10, 300, -900)).toBe("snap");
    /* Hacia la derecha nunca descarta. */
    expect(swipeDecision(-60, 300, 900)).toBe("snap");
  });

  it("never dismisses a row with no width", () => {
    expect(swipeDecision(-50, 0)).toBe("snap");
  });

  it("reports how close the row is to being dismissed", () => {
    expect(swipeProgress(0, 300)).toBe(0);
    expect(swipeProgress(-52.5, 300)).toBeCloseTo(0.5);
    expect(swipeProgress(-300, 300)).toBe(1);
    expect(swipeProgress(40, 300)).toBe(0);
  });
});

describe("side panel", () => {
  it("collapses after a quarter of its width to the right or a fling", () => {
    expect(panelDecision(90, 360)).toBe("collapse");
    expect(panelDecision(89, 360)).toBe("stay");
    expect(panelDecision(40, 360, 800)).toBe("collapse");
    expect(panelDecision(-60, 360, 800)).toBe("stay");
  });

  it("brings the tab back after a drag to the left", () => {
    expect(tabDecision(-30)).toBe("expand");
    expect(tabDecision(-5)).toBe("stay");
    expect(tabDecision(-15, -700)).toBe("expand");
    expect(tabDecision(30)).toBe("stay");
  });
});
