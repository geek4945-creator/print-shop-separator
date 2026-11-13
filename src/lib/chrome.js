import {
  clamp,
  cropToContent,
  distanceEuclidean,
  distanceOutside,
  gaussianBlur,
  resizeRGBA,
  yieldThread,
} from "./image.js";

const STOPS = [
  [0.0, 18, 18, 20],
  [0.12, 48, 48, 52],
  [0.28, 150, 150, 158],
  [0.4, 236, 236, 242],
  [0.5, 118, 118, 126],
  [0.62, 36, 36, 40],
  [0.78, 168, 168, 176],
  [0.9, 230, 230, 236],
  [1, 250, 250, 252],
];

function chromeColor(shade) {
  let i = 1;
  while (i < STOPS.length - 1 && shade > STOPS[i][0]) i++;
  const a = STOPS[i - 1];
  const b = STOPS[i];
  const t = (shade - a[0]) / Math.max(1e-6, b[0] - a[0]);
  return [
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    a[3] + (b[3] - a[3]) * t,
  ];
}

function over(dst, color, alpha, n) {
  const perPixel = color.length > 4;
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    if (a <= 0) continue;
    const o = i * 4;
    const da = dst[o + 3];
    const outA = a + da * (1 - a);
    if (outA <= 1e-5) continue;
    const cr = perPixel ? color[i * 3] : color[0];
    const cg = perPixel ? color[i * 3 + 1] : color[1];
    const cb = perPixel ? color[i * 3 + 2] : color[2];
    dst[o] = (cr * a + dst[o] * da * (1 - a)) / outA;
    dst[o + 1] = (cg * a + dst[o + 1] * da * (1 - a)) / outA;
    dst[o + 2] = (cb * a + dst[o + 2] * da * (1 - a)) / outA;
    dst[o + 3] = outA;
  }
}

/**
 * Chrome script raster of `text`, transparent, `targetWidth` pixels wide.
 * The bevel follows the desktop generator: extrusion, dark outline, height-mapped metal.
 */
export async function renderChrome(font, text, targetWidth) {
  const trial = font.getPath(text, 0, 0, 100);
  const tbb = trial.getBoundingBox();
  const est = Math.max(20, tbb.x2 - tbb.x1);
  let fontSize = clamp((1700 * 100) / est, 160, 1000);

  let path;
  let bb;
  let W;
  let H;
  let extrX;
  let extrY;
  let outline;
  let pad;
  for (let attempt = 0; attempt < 4; attempt++) {
    path = font.getPath(text, 0, 0, fontSize);
    bb = path.getBoundingBox();
    extrX = (fontSize * 10) / 420;
    extrY = (fontSize * 16) / 420;
    outline = Math.max(2, (fontSize * 7) / 420);
    pad = outline + extrY + (fontSize * 16) / 420;
    const tw = Math.max(1, bb.x2 - bb.x1);
    const th = Math.max(1, bb.y2 - bb.y1);
    W = Math.ceil(tw + pad * 2 + extrX);
    H = Math.ceil(th + pad * 2 + extrY);
    if (W <= 3800 && H <= 2200 && W * H <= 4_200_000) break;
    fontSize *= 0.72;
  }

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.translate(pad - bb.x1, pad - bb.y1);
  ctx.fill(new Path2D(path.toPathData(1)));
  const img = ctx.getImageData(0, 0, W, H);
  const n = W * H;
  const soft = new Float32Array(n);
  for (let i = 0; i < n; i++) soft[i] = img.data[i * 4 + 3] / 255;

  const rad = Math.max(1, Math.round((fontSize * 2.2) / 420));
  const hard0 = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (soft[i] > 0.4) hard0[i] = 1;
  const grownDist = distanceOutside(hard0, W, H);
  const grown = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = grownDist[i];
    grown[i] = hard0[i] ? 1 : d <= rad ? 1 - d / (rad + 0.01) : 0;
  }
  const blurred = gaussianBlur(grown, W, H, 0.7);
  const body = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (blurred[i] > 0.5) body[i] = 1;
  await yieldThread();

  const extr = new Uint8Array(n);
  const steps = Math.max(1, Math.round(extrY));
  for (let s = 1; s <= steps; s++) {
    const dx = Math.round((extrX * s) / steps);
    const dy = Math.round((extrY * s) / steps);
    for (let y = 0; y < H - dy; y++) {
      const src = y * W;
      const dst = (y + dy) * W + dx;
      for (let x = 0; x < W - dx; x++) if (body[src + x]) extr[dst + x] = 1;
    }
  }
  for (let i = 0; i < n; i++) if (body[i]) extr[i] = 0;
  await yieldThread();

  const sil = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (body[i] || extr[i]) sil[i] = 1;
  const outside = distanceOutside(sil, W, H);
  const outlineA = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!sil[i] && outside[i] <= outline) outlineA[i] = clamp(1 - (outside[i] - (outline - 1)) / 1.4, 0, 1);
  }

  const height = distanceEuclidean(body, W, H);
  let hmax = 1;
  for (let i = 0; i < n; i++) if (height[i] > hmax) hmax = height[i];
  for (let i = 0; i < n; i++) height[i] /= hmax;
  const smoothH = gaussianBlur(height, W, H, Math.max(0.8, (2.2 * fontSize) / 1680));
  await yieldThread();

  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      gx[i] =
        -smoothH[i - W - 1] +
        smoothH[i - W + 1] +
        -2 * smoothH[i - 1] +
        2 * smoothH[i + 1] +
        -smoothH[i + W - 1] +
        smoothH[i + W + 1];
      gy[i] =
        -smoothH[i - W - 1] -
        2 * smoothH[i - W] -
        smoothH[i - W + 1] +
        smoothH[i + W - 1] +
        2 * smoothH[i + W] +
        smoothH[i + W + 1];
    }
  }

  const L = [-0.4, -0.72, 0.56];
  const llen = Math.hypot(L[0], L[1], L[2]);
  L[0] /= llen;
  L[1] /= llen;
  L[2] /= llen;
  const nz0 = 0.55;
  const shade = new Float32Array(n);
  const faceA = blurred;
  for (let y = 0; y < H; y++) {
    const yy = H <= 1 ? 0 : y / (H - 1);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const boost = 7;
      const nlen = Math.hypot(gx[i] * boost, gy[i] * boost, nz0) || 1;
      const nx = (gx[i] * boost) / nlen;
      const ny = (gy[i] * boost) / nlen;
      const nz = nz0 / nlen;
      const diff = clamp(nx * L[0] + ny * L[1] + nz * L[2], 0, 1);
      const rz = 2 * diff * nz - L[2];
      const spec = rz > 0 ? rz ** 40 : 0;
      let s = diff * 0.82 + (1 - yy) * 0.08 + 0.02 + spec * 0.55;
      if (body[i]) {
        const band = clamp(-ny * 0.55, 0, 1);
        s += band * band * 0.18;
      }
      shade[i] = clamp(s, 0, 1);
    }
  }
  await yieldThread();

  const chrome = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (faceA[i] <= 0.01) continue;
    const c = chromeColor(shade[i]);
    chrome[i * 3] = c[0] / 255;
    chrome[i * 3 + 1] = c[1] / 255;
    chrome[i * 3 + 2] = c[2] / 255;
  }

  const extrA = new Float32Array(n);
  for (let i = 0; i < n; i++) extrA[i] = extr[i] ? 1 : 0;
  const extrCol = new Float32Array(n * 3);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!extr[i] && !extr[i - 1] && !extr[i + 1] && !extr[i - W] && !extr[i + W]) continue;
      const egx = extrA[i + 1] - extrA[i - 1];
      const egy = extrA[i + W] - extrA[i - W];
      const elight = clamp(-0.3 * egx - 0.8 * egy, 0, 1);
      extrCol[i * 3] = 42 / 255 + elight * (90 / 255);
      extrCol[i * 3 + 1] = 42 / 255 + elight * (90 / 255);
      extrCol[i * 3 + 2] = 46 / 255 + elight * (96 / 255);
    }
  }

  const dst = new Float32Array(n * 4);
  over(dst, [16 / 255, 16 / 255, 18 / 255], outlineA, n);
  over(dst, extrCol, extrA, n);
  over(dst, chrome, faceA, n);

  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = dst[o + 3];
    if (a <= 0.01) continue;
    rgba[o] = clamp(Math.round(dst[o] * 255), 0, 255);
    rgba[o + 1] = clamp(Math.round(dst[o + 1] * 255), 0, 255);
    rgba[o + 2] = clamp(Math.round(dst[o + 2] * 255), 0, 255);
    rgba[o + 3] = clamp(Math.round(a * 255), 0, 255);
  }
  const cropped = cropToContent(rgba, W, H, Math.max(2, Math.round(fontSize * 0.01)));
  const dh = Math.max(1, Math.round(cropped.h * (targetWidth / cropped.w)));
  const fitted = resizeRGBA(cropped.rgba, cropped.w, cropped.h, targetWidth, dh);
  return { rgba: fitted, w: targetWidth, h: dh };
}
