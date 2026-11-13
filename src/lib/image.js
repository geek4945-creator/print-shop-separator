/** Image helpers shared by the matte, upscaler, and halftone pipeline. */

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function yieldThread() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function lanczos3(x) {
  const ax = Math.abs(x);
  if (ax >= 3) return 0;
  if (ax < 1e-8) return 1;
  const pix = Math.PI * x;
  const piAx = Math.PI * ax;
  return (Math.sin(pix) * Math.sin(piAx / 3)) / (pix * (piAx / 3));
}

function resizeFilters(srcSize, destSize) {
  const scale = destSize / srcSize;
  const kernelScale = Math.min(scale, 1);
  const support = 3 / kernelScale;
  const filters = new Array(destSize);
  for (let i = 0; i < destSize; i++) {
    const center = (i + 0.5) / scale - 0.5;
    const start = Math.floor(center - support + 1e-6);
    const end = Math.ceil(center + support - 1e-6);
    const indices = [];
    const weights = [];
    let sum = 0;
    for (let j = start; j <= end; j++) {
      if (j < 0 || j >= srcSize) continue;
      const w = lanczos3((center - j) * kernelScale);
      if (w === 0) continue;
      indices.push(j);
      weights.push(w);
      sum += w;
    }
    if (!indices.length || Math.abs(sum) < 1e-8) {
      const j = clamp(Math.round(center), 0, srcSize - 1);
      filters[i] = { indices: [j], weights: [1] };
    } else {
      for (let k = 0; k < weights.length; k++) weights[k] /= sum;
      filters[i] = { indices, weights };
    }
  }
  return filters;
}

/**
 * Premultiplied Lanczos-3 resize. `src` is straight RGBA.
 * Returns a new Uint8ClampedArray of size dw*dh*4.
 */
export function resizeRGBA(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return new Uint8ClampedArray(src);
  const xFilters = resizeFilters(sw, dw);
  const yFilters = resizeFilters(sh, dh);
  const stripW = 160;
  const out = new Uint8ClampedArray(dw * dh * 4);

  for (let x0 = 0; x0 < dw; x0 += stripW) {
    const x1 = Math.min(dw, x0 + stripW);
    const cols = x1 - x0;
    const horiz = new Float32Array(cols * sh * 4);
    for (let y = 0; y < sh; y++) {
      const srcRow = y * sw;
      const dstRow = y * cols;
      for (let x = x0; x < x1; x++) {
        const f = xFilters[x];
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let k = 0; k < f.indices.length; k++) {
          const idx = (srcRow + f.indices[k]) * 4;
          const w = f.weights[k];
          const pa = src[idx + 3] / 255;
          r += src[idx] * pa * w;
          g += src[idx + 1] * pa * w;
          b += src[idx + 2] * pa * w;
          a += pa * w;
        }
        const o = (dstRow + (x - x0)) * 4;
        horiz[o] = r;
        horiz[o + 1] = g;
        horiz[o + 2] = b;
        horiz[o + 3] = a;
      }
    }
    for (let y = 0; y < dh; y++) {
      const f = yFilters[y];
      for (let x = 0; x < cols; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let k = 0; k < f.indices.length; k++) {
          const o = (f.indices[k] * cols + x) * 4;
          const w = f.weights[k];
          r += horiz[o] * w;
          g += horiz[o + 1] * w;
          b += horiz[o + 2] * w;
          a += horiz[o + 3] * w;
        }
        const oi = ((y * dw + (x0 + x)) * 4);
        if (a <= 0.002) {
          out[oi] = 0;
          out[oi + 1] = 0;
          out[oi + 2] = 0;
          out[oi + 3] = 0;
        } else {
          // r/g/b are premultiplied in 0–255; a is straight alpha in 0–1.
          const ia = 1 / Math.max(a, 1e-6);
          out[oi] = clamp(Math.round(r * ia), 0, 255);
          out[oi + 1] = clamp(Math.round(g * ia), 0, 255);
          out[oi + 2] = clamp(Math.round(b * ia), 0, 255);
          out[oi + 3] = clamp(Math.round(Math.min(1, a) * 255), 0, 255);
        }
      }
    }
  }
  return out;
}

export function cropToContent(src, w, h, margin = 0, threshold = 8) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (src[(row + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { rgba: src, w, h };
  minX = Math.max(0, minX - margin);
  minY = Math.max(0, minY - margin);
  maxX = Math.min(w - 1, maxX + margin);
  maxY = Math.min(h - 1, maxY + margin);
  const dw = maxX - minX + 1;
  const dh = maxY - minY + 1;
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const srcOff = ((minY + y) * w + minX) * 4;
    out.set(src.subarray(srcOff, srcOff + dw * 4), y * dw * 4);
  }
  return { rgba: out, w: dw, h: dh };
}

function gaussianKernel(sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return { kernel, radius };
}

/** Separable gaussian. `src` is Float32Array length w*h. */
export function gaussianBlur(src, w, h, sigma) {
  if (sigma < 0.08) return Float32Array.from(src);
  const { kernel, radius } = gaussianKernel(sigma);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k < 0 ? 0 : x + k >= w ? w - 1 : x + k;
        acc += src[row + xx] * kernel[k + radius];
      }
      tmp[row + x] = acc;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k < 0 ? 0 : y + k >= h ? h - 1 : y + k;
        acc += tmp[yy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/**
 * Mild unsharp mask on RGB, leaving alpha untouched.
 * This is the mobile stand-in for a Real-ESRGAN pass.
 */
export function unsharpRGB(rgba, w, h, amount = 0.5, sigma = 0.85) {
  const n = w * h;
  const plane = new Float32Array(n);
  const out = new Uint8ClampedArray(rgba);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) plane[i] = rgba[i * 4 + c];
    const blur = gaussianBlur(plane, w, h, sigma);
    for (let i = 0; i < n; i++) {
      if (rgba[i * 4 + 3] < 8) continue;
      const v = plane[i] + amount * (plane[i] - blur[i]);
      out[i * 4 + c] = clamp(Math.round(v), 0, 255);
    }
  }
  return out;
}

/** Two-pass box blur, applied twice. `src` is a Float32Array length w*h. */
export function fastBlur(src, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  const win = r * 2 + 1;
  let cur = Float32Array.from(src);
  const alt = new Float32Array(w * h);
  const scratch = new Float32Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += cur[row + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        alt[row + x] = sum / win;
        sum -= cur[row + clamp(x - r, 0, w - 1)];
        sum += cur[row + clamp(x + r + 1, 0, w - 1)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += alt[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        scratch[y * w + x] = sum / win;
        sum -= alt[clamp(y - r, 0, h - 1) * w + x];
        sum += alt[clamp(y + r + 1, 0, h - 1) * w + x];
      }
    }
    cur.set(scratch);
  }
  return cur;
}

export function erodeCross(src, w, h) {
  const dst = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (
        src[i] &&
        src[i - 1] &&
        src[i + 1] &&
        src[i - w] &&
        src[i + w]
      ) {
        dst[i] = 1;
      }
    }
  }
  return dst;
}

export function dilateCross(src, w, h) {
  const dst = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (src[i]) {
        dst[i] = 1;
        if (x > 0) dst[i - 1] = 1;
        if (x + 1 < w) dst[i + 1] = 1;
        if (y > 0) dst[i - w] = 1;
        if (y + 1 < h) dst[i + w] = 1;
      }
    }
  }
  return dst;
}

/**
 * Chamfer distance (3-4) from each pixel to the nearest zero pixel.
 * `solid` is 1 for foreground. Returns float pixels (approx. Euclidean).
 */
export function distanceInside(solid, w, h) {
  const INF = 65535;
  const d = new Uint16Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = solid[i] ? INF : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x + 1 < w) v = Math.min(v, d[i - w + 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x + 1 < w) v = Math.min(v, d[i + 1] + 3);
      if (y + 1 < h) {
        v = Math.min(v, d[i + w] + 3);
        if (x + 1 < w) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = v;
    }
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) out[i] = d[i] >= INF ? 1e6 : d[i] / 3;
  return out;
}

/** Distance to the nearest foreground (solid==1) pixel. */
export function distanceOutside(solid, w, h) {
  const inv = new Uint8Array(solid.length);
  for (let i = 0; i < solid.length; i++) inv[i] = solid[i] ? 0 : 1;
  return distanceInside(inv, w, h);
}

/**
 * Euclidean distance to the nearest zero, for the chrome bevel.
 * Foreground pixels (solid>0) get their distance to the background.
 */
export function distanceEuclidean(solid, w, h) {
  const n = w * h;
  const INF = 1e8;
  const grid = new Float64Array(n);
  for (let i = 0; i < n; i++) grid[i] = solid[i] ? INF : 0;
  const f = new Float64Array(Math.max(w, h));
  const line = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);

  const dt1d = (len) => {
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s =
        (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (k > 0 && s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const dx = q - v[k];
      line[q] = dx * dx + f[v[k]];
    }
  };

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    dt1d(w);
    for (let x = 0; x < w; x++) grid[row + x] = line[x];
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    dt1d(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = line[y];
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sqrt(Math.max(0, grid[i]));
  return out;
}

export function hexToRgb(hex) {
  const h = hex.replace("#", "").trim();
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = Number.parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function relLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function slugName(name) {
  const s = String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return s || "logo";
}

export function colorLabel(hex) {
  const key = hex.toLowerCase();
  const known = {
    "#000000": "black",
    "#111111": "black",
    "#1a1a1a": "black",
    "#1b1b1f": "charcoal",
    "#2a2a2e": "charcoal",
    "#1a2744": "navy",
    "#0e1a33": "navy",
    "#3d0c0c": "maroon",
    "#102418": "forest",
    "#ffffff": "white",
    "#f4f1ea": "natural",
  };
  return known[key] || hex.toUpperCase();
}
