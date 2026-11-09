import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
