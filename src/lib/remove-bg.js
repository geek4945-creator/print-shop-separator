import { encodeRGBA } from "./png.js";

/** In-browser background model. Callers fall back to the flood-fill matte. */
export async function removeWithModel(rgba, w, h) {
  const png = encodeRGBA(rgba, w, h, 72);
  const blob = new Blob([png], { type: "image/png" });
  const mod = await import(
    /* @vite-ignore */ "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.6.0/+esm"
  );
  const remove = mod.removeBackground || mod.default;
  if (typeof remove !== "function") throw new Error("background-removal module did not load");
  const outBlob = await remove(blob, {
    model: "small",
    device: "cpu",
    output: { format: "image/png", quality: 0.9 },
  });
  const bmp = await createImageBitmap(outBlob);
  const w2 = bmp.width;
  const h2 = bmp.height;
  const canvas = new OffscreenCanvas(w2, h2);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return { rgba: new Uint8ClampedArray(ctx.getImageData(0, 0, w2, h2).data), w: w2, h: h2 };
}
