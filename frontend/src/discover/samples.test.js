import { describe, expect, it } from "vitest";
import { fetchSamples, pickSamples } from "./samples.js";

const hit = (title, artist, preview = `https://p/${title}.m4a`) => ({
  title,
  artist,
  preview_url: preview,
  artwork_url: `https://a/${title}.jpg`,
});

describe("pickSamples", () => {
  it("turns results into preview tracks the engine can play", () => {
    const [t] = pickSamples([hit("Uno", "A")], "bebop");
    expect(t).toEqual({
      key: "preview:https://p/Uno.m4a",
      src: "https://p/Uno.m4a",
      title: "Uno",
      label: "el preview de Uno",
      meta: "A · muestra de bebop",
      duration: 30,
      artwork: "https://a/Uno.jpg",
      kind: "preview",
    });
  });

  it("skips results without a preview and repeated previews", () => {
    const out = pickSamples(
      [hit("Uno", "A"), { title: "Sin", artist: "B" }, hit("Otra", "C", "https://p/Uno.m4a")],
      "g"
    );
    expect(out.map((t) => t.title)).toEqual(["Uno"]);
  });

  it("puts one song per artist first, then the rest in order", () => {
    const out = pickSamples(
      [hit("A1", "A"), hit("A2", "a "), hit("B1", "B"), hit("A3", "A"), hit("C1", "C")],
      "g"
    );
    expect(out.map((t) => t.title)).toEqual(["A1", "B1", "C1", "A2", "A3"]);
  });

  it("caps the list and tolerates odd input", () => {
    const many = Array.from({ length: 30 }, (_, i) => hit(`T${i}`, `X${i}`));
    expect(pickSamples(many, "g")).toHaveLength(10);
    expect(pickSamples(many, "g", 3)).toHaveLength(3);
    expect(pickSamples(null, "g")).toEqual([]);
    expect(pickSamples([null, 4, "x"], "g")).toEqual([]);
  });
});

describe("fetchSamples", () => {
  const ok = (results) => async () => ({ ok: true, json: async () => ({ results }) });

  it("asks iTunes only, once per genre", async () => {
    const urls = [];
    const fetchFn = async (url) => {
      urls.push(url);
      return ok([hit("Uno", "A")])();
    };
    const a = await fetchSamples("genero unico", { fetchFn });
    const b = await fetchSamples("genero unico", { fetchFn });
    expect(a).toEqual(b);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("source=itunes");
    expect(urls[0]).toContain("q=genero+unico");
  });

  it("forgets a failure so the next try goes to the network", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 502, json: async () => ({}) };
      return ok([hit("Uno", "A")])();
    };
    await expect(fetchSamples("genero que falla", { fetchFn })).rejects.toThrow("502");
    await expect(fetchSamples("genero que falla", { fetchFn })).resolves.toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("returns nothing for an empty name", async () => {
    await expect(fetchSamples("  ")).resolves.toEqual([]);
  });
});
