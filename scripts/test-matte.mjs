import fs from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { makeAlpha } from "../src/lib/alpha.js";
import { cropToContent } from "../src/lib/image.js";

const srcPath =
  process.argv[2] ||
  "/home/ubuntu/.cursor/projects/workspace/uploads/source-original_649f.jpg";
const raw = jpeg.decode(fs.readFileSync(srcPath), {
  useTArray: true,
  formatAsRGBA: true,
  maxMemoryUsageInMB: 512,
});
console.log("decoded", raw.width, raw.height);
const t0 = Date.now();
const matted = await makeAlpha(raw.data, raw.width, raw.height);
console.log("matte", matted.mode, "needsModel", !!matted.needsModel, "ms", Date.now() - t0);
let opaque = 0;
for (let i = 3; i < matted.rgba.length; i += 4) if (matted.rgba[i] > 16) opaque++;
console.log("opaque fraction", (opaque / (raw.width * raw.height)).toFixed(3));
const cropped = cropToContent(matted.rgba, matted.w, matted.h, 0);
console.log("cropped", cropped.w, cropped.h);

const png = new PNG({ width: cropped.w, height: cropped.h });
png.data.set(cropped.rgba);
fs.mkdirSync("/tmp/matte", { recursive: true });
fs.writeFileSync("/tmp/matte/cropped.png", PNG.sync.write(png));

// Composite on black at half res for a quick look
const scale = 0.5;
const dw = Math.round(cropped.w * scale);
const dh = Math.round(cropped.h * scale);
const prev = new PNG({ width: dw, height: dh });
for (let y = 0; y < dh; y++) {
  for (let x = 0; x < dw; x++) {
    const sx = Math.min(cropped.w - 1, Math.round(x / scale));
    const sy = Math.min(cropped.h - 1, Math.round(y / scale));
    const si = (sy * cropped.w + sx) * 4;
    const a = cropped.rgba[si + 3] / 255;
    const di = (y * dw + x) * 4;
    prev.data[di] = Math.round(cropped.rgba[si] * a);
    prev.data[di + 1] = Math.round(cropped.rgba[si + 1] * a);
    prev.data[di + 2] = Math.round(cropped.rgba[si + 2] * a);
    prev.data[di + 3] = 255;
  }
}
fs.writeFileSync("/tmp/matte/on-black.png", PNG.sync.write(prev));
console.log("wrote /tmp/matte/on-black.png");
