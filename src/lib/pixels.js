import { clamp, gaussianBlur } from "./image.js";

export function copyRGBA(src) {
  return new Uint8ClampedArray(src);
}

export function floodTransparent(rgba, w, h, x0, y0, tolerance) {
  const out = new Uint8ClampedArray(rgba);
  const x = clamp(Math.round(x0), 0, w - 1);
  const y = clamp(Math.round(y0), 0, h - 1);
  const start = (y * w + x) * 4;
  const cr = out[start];
  const cg = out[start + 1];
  const cb = out[start + 2];
  const tol2 = tolerance * tolerance;
  const seen = new Uint8Array(w * h);
  const qx = new Int32Array(w * h);
  const qy = new Int32Array(w * h);
  let qs = 0;
  let qe = 0;
  const push = (px, py) => {
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const id = py * w + px;
    if (seen[id]) return;
    const i = id * 4;
    const dr = out[i] - cr;
    const dg = out[i + 1] - cg;
    const db = out[i + 2] - cb;
    if (dr * dr + dg * dg + db * db > tol2) return;
    seen[id] = 1;
    qx[qe] = px;
    qy[qe] = py;
    qe++;
  };
  push(x, y);
  while (qs < qe) {
    const cx = qx[qs];
    const cy = qy[qs];
    qs++;
    out[(cy * w + cx) * 4 + 3] = 0;
    push(cx + 1, cy);
    push(cx - 1, cy);
    push(cx, cy + 1);
    push(cx, cy - 1);
  }
  return out;
}

/** Soften the alpha edge and knock back white fringes. `amount` is in pixels. */
export function featherEdges(rgba, w, h, amount) {
  const radius = Number(amount) || 0;
  if (radius <= 0) return new Uint8ClampedArray(rgba);
  const n = w * h;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = rgba[i * 4 + 3] / 255;
  const blurred = gaussianBlur(alpha, w, h, Math.max(0.4, radius * 0.55));
  const out = new Uint8ClampedArray(rgba);
  for (let i = 0; i < n; i++) {
    let a = blurred[i];
    const o = i * 4;
    const lum = (out[o] + out[o + 1] + out[o + 2]) / 3;
    if (lum > 200 && a < 0.98) {
      const keep = clamp((245 - lum) / 55, 0, 1);
      a *= keep;
    }
    if (a <= 0.01) {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    } else {
      out[o + 3] = clamp(Math.round(a * 255), 0, 255);
    }
  }
  return out;
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

export function adjustImage(rgba, w, h, opts) {
  const brightness = Number(opts.brightness) || 0;
  const contrast = Number(opts.contrast) || 0;
  const saturation = Number(opts.saturation) || 0;
  const black = Number(opts.black) || 0;
  const white = Number(opts.white ?? 255);
  const threshold = opts.threshold == null ? null : Number(opts.threshold);
  const invert = !!opts.invert;
  const grayscale = !!opts.grayscale;
  const cFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const span = Math.max(1, white - black);
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    let r = rgba[i];
    let g = rgba[i + 1];
    let b = rgba[i + 2];
    const a = rgba[i + 3];
    r = cFactor * (r - 128) + 128 + brightness * 1.2;
    g = cFactor * (g - 128) + 128 + brightness * 1.2;
    b = cFactor * (b - 128) + 128 + brightness * 1.2;
    r = ((r - black) / span) * 255;
    g = ((g - black) / span) * 255;
    b = ((b - black) / span) * 255;
    if (saturation !== 0 || grayscale) {
      const [hh, ss, ll] = rgbToHsl(clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255));
      const sat = grayscale ? 0 : clamp(ss + saturation / 100, 0, 1);
      const rgb = hslToRgb(hh, sat, ll);
      r = rgb[0];
      g = rgb[1];
      b = rgb[2];
    }
    if (threshold != null) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const v = lum >= threshold ? 255 : 0;
      r = g = b = v;
    }
    if (invert) {
      r = 255 - r;
      g = 255 - g;
      b = 255 - b;
    }
    out[i] = clamp(Math.round(r), 0, 255);
    out[i + 1] = clamp(Math.round(g), 0, 255);
    out[i + 2] = clamp(Math.round(b), 0, 255);
    out[i + 3] = a;
  }
  return out;
}

function dist2(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

export function posterize(rgba, w, h, count) {
  const n = Math.max(2, Math.min(12, count | 0));
  const samples = [];
  const step = Math.max(1, Math.floor((w * h) / 12000));
  for (let p = 0; p < w * h; p += step) {
    const i = p * 4;
    if (rgba[i + 3] < 20) continue;
    samples.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
    if (samples.length >= 12000) break;
  }
  if (samples.length < n) {
    return { rgba: new Uint8ClampedArray(rgba), palette: [] };
  }
  const centers = [];
  centers.push(samples[(Math.random() * samples.length) | 0].slice());
  while (centers.length < n) {
    let best = 0;
    let bestD = -1;
    const stride = Math.max(1, Math.floor(samples.length / 2000));
    for (let i = 0; i < samples.length; i += stride) {
      let near = Infinity;
      for (const c of centers) near = Math.min(near, dist2(samples[i], c));
      if (near > bestD) {
        bestD = near;
        best = i;
      }
    }
    centers.push(samples[best].slice());
  }
  const acc = centers.map(() => [0, 0, 0, 0]);
  for (let iter = 0; iter < 8; iter++) {
    for (const a of acc) a[0] = a[1] = a[2] = a[3] = 0;
    for (let i = 0; i < samples.length; i += 2) {
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = dist2(samples[i], centers[c]);
        if (d < bd) {
          bd = d;
          bi = c;
        }
      }
      acc[bi][0] += samples[i][0];
      acc[bi][1] += samples[i][1];
      acc[bi][2] += samples[i][2];
      acc[bi][3]++;
    }
    for (let c = 0; c < centers.length; c++) {
      if (!acc[c][3]) continue;
      centers[c][0] = acc[c][0] / acc[c][3];
      centers[c][1] = acc[c][1] / acc[c][3];
      centers[c][2] = acc[c][2] / acc[c][3];
    }
  }
  const out = new Uint8ClampedArray(rgba);
  const used = new Array(n).fill(0);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (out[i + 3] < 8) continue;
    const pix = [out[i], out[i + 1], out[i + 2]];
    let bi = 0;
    let bd = Infinity;
    for (let c = 0; c < centers.length; c++) {
      const d = dist2(pix, centers[c]);
      if (d < bd) {
        bd = d;
        bi = c;
      }
    }
    out[i] = centers[bi][0];
    out[i + 1] = centers[bi][1];
    out[i + 2] = centers[bi][2];
    used[bi]++;
  }
  const palette = centers.map((c, i) => {
    const r = clamp(Math.round(c[0]), 0, 255);
    const g = clamp(Math.round(c[1]), 0, 255);
    const b = clamp(Math.round(c[2]), 0, 255);
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    return { hex, rgb: [r, g, b], count: used[i] };
  });
  return { rgba: out, palette };
}

function sample(src, w, h, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return [0, 0, 0, 0];
  const i00 = (y0 * w + Math.max(0, x0)) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + Math.max(0, x0)) * 4;
  const i11 = (y1 * w + x1) * 4;
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const a = src[i00 + c] * (1 - tx) + src[i10 + c] * tx;
    const b = src[i01 + c] * (1 - tx) + src[i11 + c] * tx;
    out[c] = a * (1 - ty) + b * ty;
  }
  return out;
}

export function rotateRGBA(src, w, h, degrees) {
  const rad = (degrees * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const cx = w / 2;
  const cy = h / 2;
  const pts = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ].map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  });
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const nw = Math.max(1, Math.ceil(maxX - minX));
  const nh = Math.max(1, Math.ceil(maxY - minY));
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const ox = x + minX;
      const oy = y + minY;
      const dx = ox - cx;
      const dy = oy - cy;
      const sx = cx + dx * c + dy * s;
      const sy = cy - dx * s + dy * c;
      const pix = sample(src, w, h, sx, sy);
      const o = (y * nw + x) * 4;
      out[o] = pix[0];
      out[o + 1] = pix[1];
      out[o + 2] = pix[2];
      out[o + 3] = pix[3];
    }
  }
  return { rgba: out, w: nw, h: nh };
}

export function rotate90(src, w, h) {
  const nw = h;
  const nh = w;
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = h - 1 - y;
      const ny = x;
      out.set(src.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (ny * nw + nx) * 4);
    }
  }
  return { rgba: out, w: nw, h: nh };
}

export function flipRGBA(src, w, h, horizontal) {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = horizontal ? w - 1 - x : x;
      const sy = horizontal ? y : h - 1 - y;
      out.set(src.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return out;
}

export function hexAt(rgba, w, x, y) {
  const xx = clamp(Math.round(x), 0, w - 1);
  const i = (Math.round(y) * w + xx) * 4;
  const r = rgba[i];
  const g = rgba[i + 1];
  const b = rgba[i + 2];
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
