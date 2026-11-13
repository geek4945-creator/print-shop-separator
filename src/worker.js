import opentype from "opentype.js";
import fontUrl from "./assets/KaushanScript-Regular.ttf?url";
import { buildPackage } from "./lib/build.js";
import { removeWithModel } from "./lib/remove-bg.js";

let fontPromise;

function loadFont() {
  if (!fontPromise) {
    fontPromise = fetch(fontUrl)
      .then((res) => {
        if (!res.ok) throw new Error("Could not load the script font");
        return res.arrayBuffer();
      })
      .then((buf) => opentype.parse(buf));
  }
  return fontPromise;
}

async function decodeImage(buffer) {
  const blob = new Blob([buffer]);
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    bitmap = await createImageBitmap(blob);
  }
  let w = bitmap.width;
  let h = bitmap.height;
  const maxEdge = 2200;
  if (Math.max(w, h) > maxEdge) {
    const scale = maxEdge / Math.max(w, h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return { rgba: ctx.getImageData(0, 0, w, h).data, w, h };
}

async function removeComplex(rgba, w, h) {
  return removeWithModel(rgba, w, h);
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type !== "generate") return;
  const report = (pct, detail) => self.postMessage({ type: "progress", pct, detail });
  try {
    await report(2, "Opening the image");
    const image = await decodeImage(msg.buffer);
    await report(4, "Loading the script font");
    const font = await loadFont();
    const result = await buildPackage(font, image.rgba, image.w, image.h, {
      ...msg.settings,
      removeComplex,
    }, report);
    const previews = result.previews.map((p) => ({
      id: p.id,
      group: p.group,
      title: p.title,
      bytes: p.bytes,
    }));
    const transfer = [result.zipBytes.buffer, ...previews.map((p) => p.bytes.buffer)];
    self.postMessage(
      {
        type: "done",
        zipBytes: result.zipBytes,
        zipName: result.zipName,
        previews,
        summary: result.summary,
      },
      transfer,
    );
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? String(err.stack) : "",
    });
  }
};
