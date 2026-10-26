import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Icon } from "./icons.jsx";
import { Icon as SettingsIcon } from "../settings/icons.jsx";
import { Icon as ListenIcon } from "../listen/icons.jsx";

describe("Icon", () => {
  it("pinta el peso pedido con los atributos de siempre", () => {
    const html = renderToStaticMarkup(<Icon name="Play" weight="fill" size={16} className="x" />);
    expect(html.startsWith('<svg viewBox="0 0 256 256" width="16" height="16" fill="currentColor" class="x" aria-hidden="true" focusable="false"><path d="')).toBe(true);
    expect(html.match(/<path/g)).toHaveLength(1);
  });

  it("regular y bold del mismo icono son rutas distintas", () => {
    const a = renderToStaticMarkup(<Icon name="X" />);
    const b = renderToStaticMarkup(<ListenIcon name="DotsThree" weight="bold" />);
    expect(a).not.toBe(b);
    expect(renderToStaticMarkup(<Icon name="CircleNotch" weight="bold" />)).toContain("<path");
  });

  it("duotone lleva la capa con opacidad", () => {
    const html = renderToStaticMarkup(<SettingsIcon name="Cookie" weight="duotone" />);
    expect(html).toContain('opacity="0.2"');
    expect(html.match(/<path/g)).toHaveLength(2);
  });

  it("las vistas heredan los iconos del script inicial", () => {
    expect(renderToStaticMarkup(<ListenIcon name="Play" weight="fill" />)).toContain("<path");
  });

  it("un icono sin definir no pinta nada", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(renderToStaticMarkup(<Icon name="Nope" />)).toBe("");
    warn.mockRestore();
  });
});
