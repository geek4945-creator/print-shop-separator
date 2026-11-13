import { defineConfig } from "vite";

// GitHub Pages uses the project base. Native shells (Android, Windows) load from the app root.
const native = process.env.NATIVE_BUILD === "1";
export default defineConfig({
  base: native ? "./" : "/print-shop-separator/",
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  worker: {
    format: "es",
  },
});
