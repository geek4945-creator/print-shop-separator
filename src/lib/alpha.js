import { clamp, dilateCross, erodeCross, gaussianBlur, yieldThread } from "./image.js";

/**
 * Border-connected background matte.
 * Near-uniform light backdrops follow the print-shop flood fill:
 * punch trapped counters, keep whitewalls and small chrome highlights.
 * Dark studio backdrops use the same edge treatment with a dark hole punch.
 * Busy photos return `needsModel: true` so the caller can try a neural matte.
 */

function borderSamples(rgba, w, h, band) {
  const pts = [];
  const push = (x, y) => {
    const i = (y * w + x) * 4;
    pts.push(rgba[i], rgba[i + 1], rgba[i + 2]);
  };
  for (let y = 0; y < band; y++) for (let x = 0; x < w; x++) push(x, y);
  for (let y = h - band; y < h; y++) for (let x = 0; x < w; x++) push(x, y);
  for (let y = band; y < h - band; y++) {
    for (let x = 0; x < band; x++) push(x, y);
    for (let x = w - band; x < w; x++) push(x, y);
  }
  return pts;
}

function medianChannel(pts, channel) {
  const n = pts.length / 3;
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) values[i] = pts[i * 3 + channel];
  values.sort();
  const mid = Math.floor((n - 1) / 2);
  return n % 2 ? values[mid] : (values[mid] + values[mid + 1]) / 2;
}

function mad(pts, bg) {
  const n = pts.length / 3;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const dr = pts[i * 3] - bg[0];
    const dg = pts[i * 3 + 1] - bg[1];
    const db = pts[i * 3 + 2] - bg[2];
    acc += Math.sqrt(dr * dr + dg * dg + db * db);
  }
  return acc / Math.max(1, n);
}

function labelComponents(bin, w, h) {
  const parent = new Int32Array(bin.length + 1);
  const labels = new Int32Array(bin.length);
  let next = 1;
  const find = (a) => {
    let root = a;
    while (parent[root] !== root) root = parent[root];
    while (a !== root) {
      const n = parent[a];
      parent[a] = root;
      a = n;
    }
    return root;
  };
  const unite = (a, b) => {
    a = find(a);
    b = find(b);
    if (a === b) return a;
    if (a < b) {
      parent[b] = a;
      return a;
    }
    parent[a] = b;
    return b;
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (!bin[i]) continue;
      let lab = 0;
      const consider = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= w) return;
        const nl = labels[ny * w + nx];
        if (!nl) return;
        lab = lab ? unite(lab, nl) : nl;
      };
      consider(x - 1, y);
      consider(x, y - 1);
      consider(x - 1, y - 1);
      consider(x + 1, y - 1);
      if (!lab) {
        lab = next++;
        parent[lab] = lab;
      } else lab = find(lab);
      labels[i] = lab;
    }
  }
  const map = new Int32Array(next);
  let count = 0;
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (!l) continue;
    const root = find(l);
    if (!map[root]) map[root] = ++count;
    labels[i] = map[root];
  }
  return { labels, count };
}

function smoothstep(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * @returns {Promise<{rgba: Uint8ClampedArray, w: number, h: number, needsModel?: boolean, warning?: string, mode: string}>}
 */
export async function makeAlpha(rgbaIn, w, h, options = {}) {
  const force = !!options.force;
  const rgba = rgbaIn;
  let transparent = 0;
  let opaque = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 16) transparent++;
    else if (rgba[i] > 240) opaque++;
  }
  const pixels = w * h;
  if (transparent > pixels * 0.01 && opaque > pixels * 0.05) {
    return { rgba, w, h, mode: "existing-alpha" };
  }

  const band = Math.max(2, Math.min(8, Math.floor(Math.min(w, h) * 0.01)));
  const samples = borderSamples(rgba, w, h, band);
  const bg = [medianChannel(samples, 0), medianChannel(samples, 1), medianChannel(samples, 2)];
  const deviation = mad(samples, bg);
  const bgLum = (bg[0] + bg[1] + bg[2]) / 3;
  if (deviation > 18 && !force) {
    return {
      rgba,
      w,
      h,
      needsModel: true,
      mode: "complex",
      warning: "Background is not a flat color. Trying the in-browser removal model.",
    };
  }

  const light = bgLum >= 170;
  const tolerance = Math.max(4, Number(options.tolerance) || 24);
  const dist = new Float32Array(pixels);
  const lum = new Uint8Array(pixels);
  const bin = new Uint8Array(pixels);
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    const dr = rgba[i] - bg[0];
    const dg = rgba[i + 1] - bg[1];
    const db = rgba[i + 2] - bg[2];
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    dist[p] = d;
    lum[p] = (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
    bin[p] = d < tolerance ? 1 : 0;
  }
  await yieldThread();

  const { labels, count } = labelComponents(bin, w, h);
  await yieldThread();

  const minX = new Int32Array(count + 1);
  const minY = new Int32Array(count + 1);
  const maxX = new Int32Array(count + 1);
  const maxY = new Int32Array(count + 1);
  const area = new Int32Array(count + 1);
  const sumY = new Float64Array(count + 1);
  const sumLum = new Float64Array(count + 1);
  minX.fill(w);
  minY.fill(h);
  maxX.fill(-1);
  maxY.fill(-1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const id = labels[row + x];
      if (!id) continue;
      area[id]++;
      sumY[id] += y;
      sumLum[id] += lum[row + x];
      if (x < minX[id]) minX[id] = x;
      if (y < minY[id]) minY[id] = y;
      if (x > maxX[id]) maxX[id] = x;
      if (y > maxY[id]) maxY[id] = y;
    }
  }

  const neigh = new Int32Array(count + 1);
  const darkN = new Int32Array(count + 1);
  const seen = new Int32Array(8);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (labels[i]) continue;
      let nSeen = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const id = labels[yy * w + xx];
          if (!id) continue;
          let known = false;
          for (let s = 0; s < nSeen; s++) if (seen[s] === id) known = true;
          if (!known && nSeen < 8) seen[nSeen++] = id;
        }
      }
      for (let s = 0; s < nSeen; s++) {
        neigh[seen[s]]++;
        if (lum[i] < 80) darkN[seen[s]]++;
      }
    }
  }
  await yieldThread();

  const onBorder = new Uint8Array(count + 1);
  const markBorder = (x, y) => {
    const id = labels[y * w + x];
    if (id) onBorder[id] = 1;
  };
  for (let x = 0; x < w; x++) {
    markBorder(x, 0);
    markBorder(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    markBorder(0, y);
    markBorder(w - 1, y);
  }

  const punch = new Uint8Array(count + 1);
  const areaHighlight = 28;
  const thickWall = 3;
  const wheelY = 0.5 * h;
  for (let id = 1; id <= count; id++) {
    if (onBorder[id] || area[id] < 3) continue;
    const perim = neigh[id];
    const lumMean = sumLum[id] / area[id];
    if (!perim) {
      punch[id] = 1;
      continue;
    }
    if (light) {
      if (lumMean < 243) continue;
      const darkFrac = darkN[id] / perim;
      const thick = (2 * area[id]) / (perim + 1e-6);
      const cy = sumY[id] / area[id];
      const inWheel = cy >= wheelY;
      if (inWheel && darkFrac >= 0.08 && thick >= thickWall) continue;
      if (inWheel && area[id] <= areaHighlight) continue;
      punch[id] = 1;
    } else if (Math.abs(lumMean - bgLum) < 22 && area[id] > 12) {
      punch[id] = 1;
    }
  }

  const alpha = new Float32Array(pixels);
  alpha.fill(1);
  for (let i = 0; i < pixels; i++) {
    const id = labels[i];
    const bgLike = id && (onBorder[id] || punch[id]);
    if (!bgLike) continue;
    const d0 = tolerance * 0.5;
    const d1 = tolerance * 0.92;
    let soft = smoothstep((dist[i] - d0) / Math.max(0.001, d1 - d0));
    if (light && lum[i] >= 247) soft = 0;
    else if (dist[i] < tolerance * 0.4) soft = 0;
    alpha[i] = soft;
  }
  await yieldThread();

  const hard = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) if (alpha[i] > 0.45) hard[i] = 1;
  const opened = dilateCross(erodeCross(hard, w, h), w, h);
  const thin = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) if (hard[i] && !opened[i]) thin[i] = 1;
  const blurred = gaussianBlur(alpha, w, h, 0.59);
  for (let i = 0; i < pixels; i++) {
    const choked = clamp((blurred[i] - 0.06) / 0.94, 0, 1);
    let a = thin[i] ? Math.max(alpha[i], choked) : choked;
    if (thin[i]) a = Math.max(a, hard[i]);
    alpha[i] = a;
  }

  const out = new Uint8ClampedArray(pixels * 4);
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    let a = alpha[p];
    if (a <= 0.01) {
      out[i + 3] = 0;
      continue;
    }
    let r = rgba[i];
    let g = rgba[i + 1];
    let b = rgba[i + 2];
    if (a < 0.98) {
      const ia = 1 / Math.max(a, 1e-4);
      r = clamp((r - (1 - a) * bg[0]) * ia, 0, 255);
      g = clamp((g - (1 - a) * bg[1]) * ia, 0, 255);
      b = clamp((b - (1 - a) * bg[2]) * ia, 0, 255);
    }
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = Math.round(clamp(a, 0, 1) * 255);
  }
  if (light) defringeLight(out, w, h, bg);

  // A failed matte (almost everything removed, or almost nothing) should
  // fall through to the neural model when the caller has one.
  let kept = 0;
  for (let i = 3; i < out.length; i += 4) if (out[i] > 16) kept++;
  const keepRatio = kept / pixels;
  if (keepRatio < 0.02 || keepRatio > 0.98) {
    return {
      rgba: out,
      w,
      h,
      needsModel: true,
      mode: light ? "light-flood" : "dark-flood",
      warning: "Flood-fill matte looked unreliable.",
    };
  }
  return { rgba: out, w, h, mode: light ? "light-flood" : "dark-flood" };
}

/** Pull near-white fringe off chrome and painted edges after the flood matte. */
function defringeLight(out, w, h, bg) {
  const n = w * h;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = out[i * 4 + 3] / 255;
  const blurred = gaussianBlur(alpha, w, h, 0.8);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const o = p * 4;
      const a = out[o + 3];
      if (a < 8 || a > 250) continue;
      const nearHole =
        out[o - 1] < 16 ||
        out[o + 7] < 16 ||
        out[o - w * 4 + 3] < 16 ||
        out[o + w * 4 + 3] < 16;
      if (!nearHole && blurred[p] > 0.92) continue;
      const dr = out[o] - bg[0];
      const dg = out[o + 1] - bg[1];
      const db = out[o + 2] - bg[2];
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist > 36) continue;
      const keep = clamp(dist / 28, 0, 1);
      const next = a * keep * (blurred[p] < 0.35 ? 0.65 : 1);
      const na = clamp(next / 255, 0, 1);
      if (na <= 0.02) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
        continue;
      }
      const ia = 1 / Math.max(na, 1e-4);
      out[o] = clamp((out[o] - (1 - na) * bg[0]) * ia, 0, 255);
      out[o + 1] = clamp((out[o + 1] - (1 - na) * bg[1]) * ia, 0, 255);
      out[o + 2] = clamp((out[o + 2] - (1 - na) * bg[2]) * ia, 0, 255);
      out[o + 3] = Math.round(na * 255);
    }
  }
}

/** Apply an RGBA matte (straight alpha) over `rgba` which may be opaque. */