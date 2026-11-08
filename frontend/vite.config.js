import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    /* terser pesa unos 5 KB menos que esbuild; passes 2 gana 421 B mas */
    minify: "terser",
    terserOptions: { compress: { passes: 2 } },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
});
