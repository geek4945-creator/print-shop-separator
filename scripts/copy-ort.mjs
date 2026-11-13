import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("onnxruntime-web"));
const out = new URL("../public/ort/", import.meta.url);
mkdirSync(out, { recursive: true });
const files = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
];
for (const name of files) {
  copyFileSync(join(dist, name), new URL(name, out));
}
console.log("copied ONNX Runtime wasm into public/ort");
