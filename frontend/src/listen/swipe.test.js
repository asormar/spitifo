import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindSwipe, swipeOutcome } from "./swipe.js";

describe("swipeOutcome", () => {
  it("quita el aviso pasado un tercio del ancho, aunque sea despacio", () => {
    expect(swipeOutcome(100, 2000, 300)).toBe("dismiss");
    expect(swipeOutcome(-100, 2000, 300)).toBe("dismiss");
    expect(swipeOutcome(90, 2000, 300)).toBe("back");
  });

  it("un golpe rapido lo quita aunque sea corto", () => {
    expect(swipeOutcome(40, 100, 300)).toBe("dismiss");
    expect(swipeOutcome(-40, 100, 300)).toBe("dismiss");
  });

  it("un temblor rapido de pocos pixeles no lo quita", () => {
    expect(swipeOutcome(10, 20, 300)).toBe("back");
  });
});

/* Un nodo minimo: eventos de verdad, estilo y clases como en el DOM. */
function fakeToast(width = 300) {
  const el = new EventTarget();
  el.style = {};
  el.offsetWidth = width;
  const classes = new Set();
  el.classList = { add: (c) => classes.add(c), has: (c) => classes.has(c) };
  el.setPointerCapture = vi.fn();
  return el;
}

function pointer(el, type, x, y, t, id = 1) {
  const e = new Event(type);
  Object.assign(e, { pointerId: id, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, "timeStamp", { value: t });
  el.dispatchEvent(e);
}

describe("bindSwipe", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("arrastrar lejos lo quita al terminar la salida", () => {
    const el = fakeToast();
    const dismiss = vi.fn();
    bindSwipe(el, dismiss);
    pointer(el, "pointerdown", 100, 50, 0);
    pointer(el, "pointermove", 150, 52, 300);
    pointer(el, "pointermove", 220, 52, 600);
    expect(el.style.transform).toBe("translateX(120px)");
    expect(el.classList.has("is-drag")).toBe(true);
    expect(el.setPointerCapture).toHaveBeenCalledWith(1);
    pointer(el, "pointerup", 220, 52, 900);
    expect(dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(180);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("soltar cerca lo devuelve a su sitio", () => {
    const el = fakeToast();
    const dismiss = vi.fn();
    bindSwipe(el, dismiss);
    pointer(el, "pointerdown", 100, 50, 0);
    pointer(el, "pointermove", 140, 50, 800);
    pointer(el, "pointerup", 140, 50, 1600);
    vi.advanceTimersByTime(1000);
    expect(dismiss).not.toHaveBeenCalled();
    expect(el.style.transform).toBe("");
    expect(el.style.opacity).toBe("");
  });

  it("al agarrarlo otra vez va pegado al dedo, sin la transicion de la vuelta", () => {
    const el = fakeToast();
    bindSwipe(el, vi.fn());
    pointer(el, "pointerdown", 100, 50, 0);
    pointer(el, "pointermove", 140, 50, 800);
    pointer(el, "pointerup", 140, 50, 1600);
    expect(el.style.transition).toContain("transform");
    pointer(el, "pointerdown", 100, 50, 2000);
    pointer(el, "pointermove", 120, 50, 2100);
    expect(el.style.transition).toBe("");
    expect(el.style.transform).toBe("translateX(20px)");
  });

  it("un gesto vertical es scroll: el aviso no se mueve", () => {
    const el = fakeToast();
    const dismiss = vi.fn();
    bindSwipe(el, dismiss);
    pointer(el, "pointerdown", 100, 50, 0);
    pointer(el, "pointermove", 104, 90, 100);
    pointer(el, "pointermove", 200, 90, 200);
    pointer(el, "pointerup", 200, 90, 300);
    vi.advanceTimersByTime(1000);
    expect(el.style.transform).toBeUndefined();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("un pointercancel lo devuelve aunque se haya arrastrado lejos", () => {
    const el = fakeToast();
    const dismiss = vi.fn();
    bindSwipe(el, dismiss);
    pointer(el, "pointerdown", 100, 50, 0);
    pointer(el, "pointermove", 280, 50, 100);
    pointer(el, "pointercancel", 280, 50, 150);
    vi.advanceTimersByTime(1000);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("un segundo dedo no toma el gesto", () => {
    const el = fakeToast();
    bindSwipe(el, vi.fn());
    pointer(el, "pointerdown", 100, 50, 0, 1);
    pointer(el, "pointerdown", 10, 50, 10, 2);
    pointer(el, "pointermove", 200, 50, 50, 2);
    expect(el.style.transform).toBeUndefined();
    pointer(el, "pointermove", 130, 50, 60, 1);
    expect(el.style.transform).toBe("translateX(30px)");
  });

  it("la limpieza suelta los eventos", () => {
    const el = fakeToast();
    const off = bindSwipe(el, vi.fn());
    off();
    pointer(el, "pointerdown", 100, 50, 0);
    pointer(el, "pointermove", 200, 50, 50);
    expect(el.style.transform).toBeUndefined();
  });
});
