import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobsStore } from "./jobsStore.js";

describe("jobsStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("une los cambios de un job sin tocar los demas", () => {
    const s = createJobsStore(5000);
    s.setJobFor("a", { status: "pending", progress: 0, title: "A" });
    s.setJobFor("b", { status: "pending", progress: 0, title: "B" });
    s.setJobFor("a", { progress: 40 });
    expect(s.getJobs().a).toEqual({ status: "pending", progress: 40, title: "A", key: "a" });
    expect(s.getJobs().b.progress).toBe(0);
  });

  it("avisa a los suscriptores y deja de avisar al darse de baja", () => {
    const s = createJobsStore(5000);
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.setJobFor("a", { status: "pending" });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    s.setJobFor("a", { progress: 10 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retira un job terminal a los 5 s y no antes", () => {
    const s = createJobsStore(5000);
    s.setJobFor("a", { status: "done", title: "A" });
    vi.advanceTimersByTime(4999);
    expect(s.getJobs().a).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(s.getJobs().a).toBeUndefined();
  });

  it("cada job tiene su temporizador: el de uno no retira el del otro", () => {
    const s = createJobsStore(5000);
    s.setJobFor("a", { status: "done" });
    vi.advanceTimersByTime(3000);
    s.setJobFor("b", { status: "error" });
    vi.advanceTimersByTime(2000);
    expect(s.getJobs().a).toBeUndefined();
    expect(s.getJobs().b).toBeDefined();
    vi.advanceTimersByTime(3000);
    expect(s.getJobs().b).toBeUndefined();
  });

  it("otra descarga sondeando no reinicia ni bloquea el temporizador del terminado", () => {
    const s = createJobsStore(5000);
    s.setJobFor("a", { status: "done" });
    for (let i = 0; i < 8; i++) {
      s.setJobFor("b", { status: "downloading", progress: i * 10 });
      vi.advanceTimersByTime(700);
    }
    expect(s.getJobs().a).toBeUndefined();
    expect(s.getJobs().b.status).toBe("downloading");
  });

  it("un job terminal que vuelve a actualizarse no reinicia su temporizador", () => {
    const s = createJobsStore(5000);
    s.setJobFor("a", { status: "done" });
    vi.advanceTimersByTime(3000);
    s.setJobFor("a", { progress: 100 });
    vi.advanceTimersByTime(2000);
    expect(s.getJobs().a).toBeUndefined();
  });

  it("volver a bajar la misma cancion antes de los 5 s no le quita la descarga viva", () => {
    const s = createJobsStore(5000);
    s.setJobFor("a", { status: "done" });
    vi.advanceTimersByTime(2000);
    s.setJobFor("a", { status: "pending", progress: 0 });
    vi.advanceTimersByTime(10000);
    expect(s.getJobs().a.status).toBe("pending");
  });

  it("el nuevo final de esa cancion cuenta sus propios 5 s", () => {
    const s = createJobsStore(5000);
    s.setJobFor("a", { status: "done" });
    vi.advanceTimersByTime(2000);
    s.setJobFor("a", { status: "pending" });
    vi.advanceTimersByTime(1000);
    s.setJobFor("a", { status: "done" });
    vi.advanceTimersByTime(4999);
    expect(s.getJobs().a).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(s.getJobs().a).toBeUndefined();
  });

  it("timeout y gone tambien son terminales", () => {
    const s = createJobsStore(5000);
    s.setJobFor("a", { status: "timeout" });
    s.setJobFor("b", { status: "gone" });
    vi.advanceTimersByTime(5000);
    expect(s.getJobs()).toEqual({});
  });
});
