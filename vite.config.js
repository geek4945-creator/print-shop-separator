import { defineConfig } from "vite";

// GitHub Pages project site: https://geek4945-creator.github.io/print-shop-separator/
export default defineConfig({
  base: "/print-shop-separator/",
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  worker: {
    format: "es",
  },
});
