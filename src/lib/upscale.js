import { clamp, resizeRGBA, yieldThread } from "./image.js";

const MODEL_SCALE = 4;

function tileStarts(length, tile, overlap) {
  if (length <= tile) return [0];
  const step = Math.max(1, tile - overlap);
  const starts = [];
  for (let x = 0; x < length; x += step) {
    const origin = Math.min(x, length - tile);
    if (starts.length && starts[starts.length - 1] === origin) break;
    starts.push(origin);
    if (origin === length - tile) break;
  }
  return starts;
}

function samplePlanar(data, ow, oh, x, y) {
  const x0 = clamp(Math.floor(x), 0, ow - 1);
  const y0 = clamp(Math.floor(y), 0, oh - 1);
  const x1 = clamp(x0 + 1, 0, ow - 1);
  const y1 = clamp(y0 + 1, 0, oh - 1);
  const tx = clamp(x - x0, 0, 1);
  const ty = clamp(y - y0, 0, 1);
  const plane = ow * oh;
  const at = (yy, xx, c) => data[c * plane + yy * ow + xx];
  const mix = (c) => {
    const a = at(y0, x0, c) * (1 - tx) + at(y0, x1, c) * tx;
    const b = at(y1, x0, c) * (1 - tx) + at(y1, x1, c) * tx;
    return a * (1 - ty) + b * ty;
  };
  return [mix(0), mix(1), mix(2)];
}

let sessionPromise;

async function defaultSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const preferGpu = typeof navigator !== "undefined" && !!navigator.gpu;
      let ort;
      try {
        ort = preferGpu ? await import("onnxruntime-web/webgpu") : await import("onnxruntime-web/wasm");
      } catch {
        ort = await import("onnxruntime-web/wasm");
      }
      if (ort.env?.wasm) {
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.simd = true;
        ort.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
      }
      const modelUrl = `${import.meta.env.BASE_URL}models/realesr-general-x4v3.onnx`;
      const providers = preferGpu ? ["webgpu", "wasm"] : ["wasm"];
      try {
        const session = await ort.InferenceSession.create(modelUrl, { executionProviders: providers });
        return { session, Tensor: ort.Tensor };
      } catch (err) {
        if (!preferGpu) throw err;
        const cpu = await import("onnxruntime-web/wasm");
        cpu.env.wasm.numThreads = 1;
        cpu.env.wasm.simd = true;
        cpu.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
        const session = await cpu.InferenceSession.create(modelUrl, { executionProviders: ["wasm"] });
        return { session, Tensor: cpu.Tensor };
      }
    })().catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

/**
 * 4× Real-ESRGAN (realesr-general-x4v3), tiled, then sampled to `targetLong`.
 * Falls back to Lanczos if the model cannot run.
 */
export async function upscaleRgba(rgba, width, height, options = {}) {
  const long = Math.max(width, height);
  const targetLong = Math.max(long, Math.round(options.targetLong || long));
  const wanted = Math.min(MODEL_SCALE, targetLong / long);
  if (wanted <= 1.02) return { rgba, w: width, h: height, mode: "none" };
  const outW = Math.max(1, Math.round(width * wanted));
  const outH = Math.max(1, Math.round(height * wanted));
  try {
    const runtime = options.session ? options.session : await defaultSession();
    const tiled = await runTiles(rgba, width, height, outW, outH, runtime, options);
    return { ...tiled, mode: "realesrgan" };
  } catch (err) {
    const fallback = resizeRGBA(rgba, width, height, outW, outH);
    return {
      rgba: fallback,
      w: outW,
      h: outH,
      mode: "lanczos",
      warning: `Real-ESRGAN did not run (${err.message || err}). Used Lanczos instead.`,
    };
  }
}

async function runTiles(rgba, width, height, outW, outH, runtime, options) {
  const tile = Math.max(32, options.tile || 128);
  const overlap = Math.min(options.overlap ?? 16, Math.floor(tile / 5));
  const { session, Tensor } = runtime;
  const acc = new Float32Array(outW * outH * 3);
  const weight = new Float32Array(outW * outH);
  const ys = tileStarts(height, tile, overlap);
  const xs = tileStarts(width, tile, overlap);
  const total = xs.length * ys.length;
  let done = 0;
  const mapX = (width * MODEL_SCALE) / outW;
  const mapY = (height * MODEL_SCALE) / outH;

  for (const y0 of ys) {
    for (const x0 of xs) {
      const tw = Math.min(tile, width - x0);
      const th = Math.min(tile, height - y0);
      const input = new Float32Array(3 * th * tw);
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const si = ((y0 + y) * width + (x0 + x)) * 4;
          const i = y * tw + x;
          input[i] = rgba[si] / 255;
          input[th * tw + i] = rgba[si + 1] / 255;
          input[2 * th * tw + i] = rgba[si + 2] / 255;
        }
      }
      const tensor = new Tensor("float32", input, [1, 3, th, tw]);
      const result = await session.run({ input: tensor });
      const outKey = session.outputNames?.[0] || Object.keys(result)[0];
      const data = result[outKey].data;
      const ow = tw * MODEL_SCALE;
      const oh = th * MODEL_SCALE;
      const destX0 = clamp(Math.floor((x0 * MODEL_SCALE) / mapX), 0, outW - 1);
      const destX1 = clamp(Math.ceil(((x0 + tw) * MODEL_SCALE) / mapX), destX0 + 1, outW);
      const destY0 = clamp(Math.floor((y0 * MODEL_SCALE) / mapY), 0, outH - 1);
      const destY1 = clamp(Math.ceil(((y0 + th) * MODEL_SCALE) / mapY), destY0 + 1, outH);
      for (let dy = destY0; dy < destY1; dy++) {
        const gy = (dy + 0.5) * mapY - 0.5;
        const my = gy - y0 * MODEL_SCALE;
        const yEdge = y0 > 0 ? clamp(my / (overlap * MODEL_SCALE), 0, 1) : 1;
        const yEdgeB = y0 + th < height ? clamp((oh - 1 - my) / (overlap * MODEL_SCALE), 0, 1) : 1;
        const wy = Math.min(yEdge, yEdgeB);
        for (let dx = destX0; dx < destX1; dx++) {
          const gx = (dx + 0.5) * mapX - 0.5;
          const mx = gx - x0 * MODEL_SCALE;
          if (mx < -0.5 || my < -0.5 || mx > ow - 0.5 || my > oh - 0.5) continue;
          const xEdge = x0 > 0 ? clamp(mx / (overlap * MODEL_SCALE), 0, 1) : 1;
          const xEdgeR = x0 + tw < width ? clamp((ow - 1 - mx) / (overlap * MODEL_SCALE), 0, 1) : 1;
          const wgt = wy * Math.min(xEdge, xEdgeR);
          if (wgt <= 0) continue;
          const rgb = samplePlanar(data, ow, oh, mx, my);
          const di = dy * outW + dx;
          acc[di * 3] += rgb[0] * wgt;
          acc[di * 3 + 1] += rgb[1] * wgt;
          acc[di * 3 + 2] += rgb[2] * wgt;
          weight[di] += wgt;
        }
      }
      done += 1;
      if (options.onProgress) await options.onProgress(done / total);
      else if (done % 2 === 0) await yieldThread();
    }
  }

  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let i = 0; i < outW * outH; i++) {
    const w = weight[i];
    const sx = clamp(Math.round((i % outW) * ((width - 1) / Math.max(1, outW - 1))), 0, width - 1);
    const sy = clamp(Math.round(Math.floor(i / outW) * ((height - 1) / Math.max(1, outH - 1))), 0, height - 1);
    const alpha = rgba[(sy * width + sx) * 4 + 3];
    if (w < 1e-5) {
      const si = (sy * width + sx) * 4;
      out[i * 4] = rgba[si];
      out[i * 4 + 1] = rgba[si + 1];
      out[i * 4 + 2] = rgba[si + 2];
    } else {
      out[i * 4] = clamp(Math.round((acc[i * 3] / w) * 255), 0, 255);
      out[i * 4 + 1] = clamp(Math.round((acc[i * 3 + 1] / w) * 255), 0, 255);
      out[i * 4 + 2] = clamp(Math.round((acc[i * 3 + 2] / w) * 255), 0, 255);
    }
    out[i * 4 + 3] = alpha;
  }
  return { rgba: out, w: outW, h: outH };
}

export function upscaleProfileFromWindow() {
  const desktop = typeof window !== "undefined" ? window.desktopPrintShop : null;
  const capacitor = typeof window !== "undefined" ? window.Capacitor : null;
  const native = !!(desktop || capacitor?.isNativePlatform?.());
  return {
    native,
    tile: desktop?.tile || (native ? 192 : 128),
    longEdge: desktop?.longEdge || (native ? 4096 : 3000),
  };
}
