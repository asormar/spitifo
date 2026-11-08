import { beforeEach, describe, expect, it } from "vitest";
import { panel, panelMode } from "./panel.js";

const reset = () => {
  panel.close();
  panel.show(0, "");
  panel.close();
};

describe("panel store", () => {
  beforeEach(reset);

  it("starts closed on the first tab", () => {
    expect(panel.get()).toMatchObject({ open: false, tab: 0, wide: false });
  });

  it("show opens on the asked tab and remembers where", () => {
    panel.show(1, "home");
    expect(panel.get()).toEqual({ open: true, tab: 1, wide: false, at: "home" });
  });

  it("show defaults to the first tab and keeps the last place", () => {
    panel.show(2, "library");
    panel.show();
    expect(panel.get()).toMatchObject({ open: true, tab: 0, at: "library" });
  });

  it("expand forces the first tab and sets the place", () => {
    panel.show(2, "home");
    panel.expand("search");
    expect(panel.get()).toEqual({ open: true, tab: 0, wide: true, at: "search" });
  });

  it("show on tab 1 or 2 clears wide", () => {
    panel.expand("home");
    panel.show(1, "home");
    expect(panel.get().wide).toBe(false);
    panel.expand("home");
    panel.show(2, "home");
    expect(panel.get().wide).toBe(false);
  });

  it("show on tab 0 keeps wide while open", () => {
    panel.expand("home");
    panel.show(0, "home");
    expect(panel.get().wide).toBe(true);
  });

  it("collapse only drops wide", () => {
    panel.expand("home");
    panel.collapse();
    expect(panel.get()).toEqual({ open: true, tab: 0, wide: false, at: "home" });
  });

  it("close clears open and wide", () => {
    panel.expand("home");
    panel.close();
    expect(panel.get()).toMatchObject({ open: false, wide: false });
  });

  it("a closed panel does not come back wide", () => {
    panel.expand("home");
    panel.close();
    panel.show(0, "home");
    expect(panel.get().wide).toBe(false);
  });

  it("notifies on change and stays quiet on a repeat", () => {
    let n = 0;
    const off = panel.subscribe(() => n++);
    panel.show(1, "home");
    panel.show(1, "home");
    panel.close();
    off();
    panel.show(0, "home");
    expect(n).toBe(2);
  });
});

describe("panelMode", () => {
  const track = { key: "a" };
  const open = { open: true, tab: 0, wide: false, at: "home" };
  const ctx = { key: "home", discover: false, pc: true, track };

  it("is off without a track or when closed", () => {
    expect(panelMode(open, { ...ctx, track: null })).toBe("off");
    expect(panelMode({ ...open, open: false }, ctx)).toBe("off");
  });

  it("is full below 960 whatever the state", () => {
    const phone = { ...ctx, pc: false };
    expect(panelMode(open, phone)).toBe("full");
    expect(panelMode({ ...open, tab: 2, wide: true }, phone)).toBe("full");
    expect(panelMode(open, { ...phone, discover: true })).toBe("full");
  });

  it("docks on a desktop page", () => {
    expect(panelMode(open, ctx)).toBe("docked");
    expect(panelMode({ ...open, tab: 1 }, ctx)).toBe("docked");
  });

  it("is wide only on tab 0 in the view that expanded it", () => {
    const wide = { ...open, wide: true };
    expect(panelMode(wide, ctx)).toBe("wide");
    expect(panelMode({ ...wide, tab: 1 }, ctx)).toBe("docked");
  });

  it("loses wide when the view changes", () => {
    expect(panelMode({ ...open, wide: true }, { ...ctx, key: "library" })).toBe("docked");
  });

  it("floats over Descubrir only when opened there", () => {
    const d = { ...ctx, key: "discover", discover: true };
    expect(panelMode({ ...open, at: "discover" }, d)).toBe("over");
    expect(panelMode(open, d)).toBe("off");
  });

  it("is never over off Descubrir", () => {
    expect(panelMode({ ...open, at: "discover" }, ctx)).toBe("docked");
  });
});
