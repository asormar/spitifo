import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

/* El codigo usa la API de React y se empaqueta con Preact (preact/compat):
   react-dom pesaba ~130 KB del JavaScript que el telefono lee al arrancar.
   Los tests usan los mismos alias, asi que prueban lo que se publica. */
export default defineConfig({
  /* Los alias de React los pone esta config (abajo), no el preset. */
  plugins: [preact({ reactAliasesEnabled: false })],
  resolve: {
    alias: [
      { find: /^react$/, replacement: "preact/compat" },
      { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
      { find: /^react\/jsx-dev-runtime$/, replacement: "preact/jsx-dev-runtime" },
      { find: /^react-dom\/client$/, replacement: "preact/compat/client" },
      { find: /^react-dom\/server$/, replacement: "preact-render-to-string" },
      { find: /^react-dom$/, replacement: "preact/compat" },
    ],
  },
  build: {
    /* terser pesa unos 5 KB menos que esbuild; passes 2 gana 421 B mas */
    minify: "terser",
    terserOptions: { compress: { passes: 2 } },
    /* El piso es Chrome 111 (color-mix): sin cssTarget Vite baja `inset` y otras
       a 4 propiedades (Safari 14) y lightningcss no lo vuelve a juntar. */
    cssTarget: "chrome111",
    cssMinify: "lightningcss",
  },
  css: {
    lightningcss: { targets: { chrome: 111 << 16 } },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
});
