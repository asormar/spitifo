import { describe, expect, it } from "vitest";
import { PANEL_MIN_MAP, PANEL_ROOM, PEEK, startingObstacle, startsCollapsed } from "./frame.js";

describe("startsCollapsed", () => {
  it("only collapses the side panel on a narrow, non-phone map", () => {
    expect(startsCollapsed(PANEL_MIN_MAP - 1, false)).toBe(true);
    expect(startsCollapsed(PANEL_MIN_MAP, false)).toBe(false);
    expect(startsCollapsed(1400, false)).toBe(false);
    /* El telefono usa la hoja, no la pestana. */
    expect(startsCollapsed(400, true)).toBe(false);
  });
});

describe("startingObstacle", () => {
  it("is the peek bar plus its margin on a phone", () => {
    expect(startingObstacle({ w: 390, narrow: true })).toEqual({ bottom: PEEK + 8 });
  });

  it("is the panel's room on a wide map and nothing when it starts collapsed", () => {
    expect(startingObstacle({ w: 1200, narrow: false })).toEqual({ right: PANEL_ROOM });
    expect(startingObstacle({ w: 700, narrow: false })).toEqual({ right: 0 });
  });
});
