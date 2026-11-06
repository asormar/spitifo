import { describe, expect, it } from "vitest";
import { dockVisible } from "./dock.js";

const base = { track: { key: "a" }, npOpen: false, vhostMode: "closed", dismissed: false };

describe("dockVisible", () => {
  it("shows with a track and nothing covering it", () => {
    expect(dockVisible(base)).toBe(true);
  });

  it("hides without a track", () => {
    expect(dockVisible({ ...base, track: null })).toBe(false);
    expect(dockVisible({ ...base, track: undefined })).toBe(false);
  });

  it("hides while Ahora suena is open", () => {
    expect(dockVisible({ ...base, npOpen: true })).toBe(false);
  });

  it("hides while the video is open in any mode", () => {
    expect(dockVisible({ ...base, vhostMode: "modal" })).toBe(false);
    expect(dockVisible({ ...base, vhostMode: "mini" })).toBe(false);
  });

  it("hides once the user dismissed it", () => {
    expect(dockVisible({ ...base, dismissed: true })).toBe(false);
  });
});
