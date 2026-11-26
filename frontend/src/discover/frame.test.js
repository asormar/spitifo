import { describe, expect, it } from "vitest";
import {
  initialSnap,
  PANEL_MIN_MAP,
  PANEL_ROOM,
  PEEK,
  rememberSnap,
  startingObstacle,
  startsCollapsed,
} from "./frame.js";

describe("startsCollapsed", () => {
  it("only collapses the side panel on a narrow, non-phone map", () => {
    expect(startsCollapsed(PANEL_MIN_MAP - 1, false)).toBe(true);
    expect(startsCollapsed(PANEL_MIN_MAP, false)).toBe(false);
    expect(startsCollapsed(1400, false)).toBe(false);
    /* El telefono usa la hoja, no la pestana. */
    expect(startsCollapsed(400, true)).toBe(false);
  });
});

describe("initialSnap", () => {
  it("opens at half on the first visit and remembers the last snap", () => {
    rememberSnap(null);
    expect(initialSnap()).toBe("half");
    rememberSnap("full");
    expect(initialSnap()).toBe("full");
    rememberSnap(null);
  });
});

describe("startingObstacle", () => {
  it("leaves room for the half sheet on the first phone visit", () => {
    rememberSnap(null);
    const { bottom } = startingObstacle({ w: 390, h: 600, narrow: true });
    expect(bottom).toBeGreaterThan(PEEK + 8);
    expect(bottom).toBeLessThan(600);
  });

  it("uses the remembered snap on later visits", () => {
    rememberSnap("peek");
    expect(startingObstacle({ w: 390, h: 600, narrow: true })).toEqual({ bottom: PEEK + 8 });
    rememberSnap(null);
  });

  it("is the panel's room on a wide map and nothing when it starts collapsed", () => {
    expect(startingObstacle({ w: 1200, h: 600, narrow: false })).toEqual({ right: PANEL_ROOM });
    expect(startingObstacle({ w: 700, h: 600, narrow: false })).toEqual({ right: 0 });
  });
});
