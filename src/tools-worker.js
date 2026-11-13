import { makeAlpha } from "./lib/alpha.js";
import { cropToContent, resizeRGBA, unsharpRGB } from "./lib/image.js";
import { adjustImage, featherEdges, floodTransparent, posterize, rotate90, rotateRGBA, flipRGBA } from "./lib/pixels.js";
import { removeWithModel } from "./lib/remove-bg.js";
import ImageTracer from "imagetracerjs";

function pack(rgba, w, h, extra = {}) {
  const pixels = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
  return { pixels, w, h, extra };
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    const { id, op, w, h, params = {} } = msg;
    const src = new Uint8ClampedArray(msg.pixels);
    let result;
    if (op === "matte") {
      let matted = await makeAlpha(src, w, h, {
        tolerance: params.tolerance,
        force: !!params.force,
      });
      if (params.tryModel && matted.needsModel) {
        try {
          const model = await removeWithModel(src, w, h);
          matted = { rgba: model.rgba, w: model.w, h: model.h, mode: "model" };
        } catch (err) {
          if (matted.mode === "complex") {
            matted = await makeAlpha(src, w, h, { tolerance: params.tolerance, force: true });
          }
          matted.warning = err.message || String(err);
        }
      }
      result = pack(matted.rgba, matted.w, matted.h, {
        mode: matted.mode,
        warning: matted.warning || "",
      });
    } else if (op === "flood") {
      const rgba = floodTransparent(src, w, h, params.x, params.y, params.tolerance || 32);
      result = pack(rgba, w, h);
    } else if (op === "feather") {
      result = pack(featherEdges(src, w, h, params.amount || 0), w, h);
    } else if (op === "adjust") {
      let rgba = adjustImage(src, w, h, params);
      if (params.sharpen > 0) rgba = unsharpRGB(rgba, w, h, params.sharpen / 80, 0.8);
      result = pack(rgba, w, h);
    } else if (op === "posterize") {
      const done = posterize(src, w, h, params.colors || 6);
      result = pack(done.rgba, w, h, { palette: done.palette });
    } else if (op === "resize") {
      const rgba = resizeRGBA(src, w, h, params.dw, params.dh);
      result = pack(rgba, params.dw, params.dh);
    } else if (op === "trim") {
      const cropped = cropToContent(src, w, h, 0, 8);
      result = pack(cropped.rgba, cropped.w, cropped.h);
    } else if (op === "rotate") {
      const turned = Math.abs(params.degrees) === 90
        ? rotate90(src, w, h)
        : rotateRGBA(src, w, h, params.degrees || 0);
      result = pack(turned.rgba, turned.w, turned.h);
    } else if (op === "flip") {
      result = pack(flipRGBA(src, w, h, params.horizontal !== false), w, h);
    } else if (op === "trace") {
      const imageData = { width: w, height: h, data: src };
      const svg = ImageTracer.imagedataToSVG(imageData, {
        numberofcolors: params.colors || 8,
        ltres: 1,
        qtres: 1,
        pathomit: 8,
        rightangleenhance: true,
        scale: 1,
        viewbox: true,
        desc: false,
      });
      self.postMessage({ id, ok: true, svg });
      return;
    } else {
      throw new Error(`Unknown tool op ${op}`);
    }
    self.postMessage({ id, ok: true, pixels: result.pixels, w: result.w, h: result.h, extra: result.extra }, [
      result.pixels.buffer,
    ]);
  } catch (err) {
    self.postMessage({ id: event.data && event.data.id, ok: false, message: err.message || String(err) });
  }
};
