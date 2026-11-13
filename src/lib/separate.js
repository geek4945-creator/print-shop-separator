import { clamp, distanceInside, distanceOutside, gaussianBlur, yieldThread } from "./image.js";

export const DPI = 300;
export const FILM_DPI = 600;
export const LPI = 50;
export const CHOKE_PT = 1;
export const CHOKE_IN = CHOKE_PT / 72;

const INK_INFO = {
  underbase: {
    name: "WHITE UNDERBASE",
    short: "Underbase",
    pantone: "Opaque White (underbase)",
    hex: "#FFFFFF",
    rgb: [255, 255, 255],
    lpi: null,
    angle: 45,
    notes: "Flash after this screen. Choked 1 pt (0.014 in).",
  },
  teal: {
    name: "TEAL",
    short: "Teal",
    pantone: "Pantone 321 C (custom-match to art ~#3F9998)",
    hex: "#3F9998",
    rgb: [63, 153, 152],
    lpi: LPI,
    angle: 15,
    notes: "All teal / green body-paint components.",
  },
  dark: {
    name: "DARK GRAY",
    short: "Dark Gray",
    pantone: "Pantone Cool Gray 11 C",
    hex: "#53565A",
    rgb: [83, 86, 90],
    lpi: LPI,
    angle: 75,
    notes: "Chrome shadows, letter extrusion, dark metal.",
  },
  mid: {
    name: "MID SILVER",
    short: "Mid Silver",
    pantone: "Pantone Cool Gray 6 C (or 877 C Metallic if available)",
    hex: "#A7A8AA",
    rgb: [167, 168, 170],
    lpi: LPI,
    angle: 45,
    notes: "Mid chrome, letter faces, mid metal.",
  },
  highlight: {
    name: "HIGHLIGHT / LIGHT SILVER",
    short: "Highlight",
    pantone: "Pantone Cool Gray 1 C or Mixing White",
    hex: "#E8E8E6",
    rgb: [232, 232, 230],
    lpi: LPI,
    angle: 0,
    notes: "Specular chrome, letter highlights, whitewall tire.",
  },
  black: {
    name: "BLACK (DETAIL)",
    short: "Black",
    pantone: "Pantone Black C",
    hex: "#111111",
    rgb: [17, 17, 17],
    lpi: LPI,
    angle: 22.5,
    notes: "Dark detail that sits on other inks (e.g. tank script). Shirt-black areas are left unprinted.",
  },
};

function hsv(r, g, b) {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = rf > gf ? (rf > bf ? rf : bf) : gf > bf ? gf : bf;
  const min = rf < gf ? (rf < bf ? rf : bf) : gf < bf ? gf : bf;
  const d = max - min;
  let h = 0;
  if (d > 1e-8) {
    if (max === rf) h = ((gf - bf) / d) % 6;
    else if (max === gf) h = (bf - rf) / d + 2;
    else h = (rf - gf) / d + 4;
    h *= 30;
    if (h < 0) h += 180;
  }
  return [h, max === 0 ? 0 : (d / max) * 255, max * 255];
}

function softPeak(x, lo, peak, hi) {
  const left = clamp((x - lo) / Math.max(peak - lo, 1e-6), 0, 1);
  const right = clamp((hi - x) / Math.max(hi - peak, 1e-6), 0, 1);
  return left < right ? left : right;
}

function u8(v) {
  return v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
}

function dilateBin(mask, w, h, radius) {
  const dist = distanceOutside(mask, w, h);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) if (dist[i] <= radius) out[i] = 1;
  return out;
}

function choke(cov, w, h, radiusPx) {
  const solid = new Uint8Array(cov.length);
  for (let i = 0; i < cov.length; i++) if (cov[i] > 13) solid[i] = 1;
  const dist = distanceInside(solid, w, h);
  const out = new Uint8Array(cov.length);
  const inner = radiusPx - 0.6;
  for (let i = 0; i < cov.length; i++) {
    const soft = clamp((dist[i] - inner) / 1.2, 0, 1);
    out[i] = (cov[i] * soft + 0.5) | 0;
  }
  return out;
}

function significant(cov) {
  let hot = 0;
  const step = cov.length > 2_000_000 ? 3 : 1;
  for (let i = 0; i < cov.length; i += step) if (cov[i] > 18) hot++;
  return hot / Math.ceil(cov.length / step) > 0.00035;
}

function maxInto(dst, src) {
  for (let i = 0; i < dst.length; i++) if (src[i] > dst[i]) dst[i] = src[i];
}

/**
 * Spot-color coverages for one print.
 * `kind` is "back" (photo, may include teal) or "chest" (chrome name only).
 * `inkCount` is "auto" or 4 | 5 | 6.
 */
export async function extractChannels(rgba, w, h, kind, { inkCount = "auto", darkGarment = true } = {}) {
  const n = w * h;
  const teal = new Uint8Array(n);
  const tealness = new Uint8Array(n);
  const dark = new Uint8Array(n);
  const mid = new Uint8Array(n);
  const hi = new Uint8Array(n);
  const wantTeal = kind === "back";

  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = rgba[i + 3] / 255;
    if (a < 0.02) continue;
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const pr = r * a;
    const pg = g * a;
    const pb = b * a;
    const lum = (0.2126 * pr + 0.7152 * pg + 0.0722 * pb) / 255;
    let tn = 0;
    if (wantTeal) {
      const [H, S, V] = hsv(r, g, b);
      const hueDist = Math.min(Math.abs(H - 90), 180 - Math.abs(H - 90));
      tn =
        clamp((18 - hueDist) / 18, 0, 1) *
        clamp((S - 30) / 50, 0, 1) *
        clamp((V - 25) / 40, 0, 1) *
        clamp((a - 0.08) / 0.2, 0, 1);
      const vN = V / 255;
      let t = clamp(tn * clamp(0.25 + 0.85 * vN, 0, 1), 0, 1);
      if (tn > 0.75 && vN > 0.3 && vN < 0.78) t = Math.max(t, 0.97);
      teal[p] = u8(t);
      tealness[p] = u8(tn);
    }
    const chrome = clamp(a - tn, 0, 1);
    let d = chrome * softPeak(lum, kind === "chest" ? 0.02 : 0.04, kind === "chest" ? 0.2 : 0.22, kind === "chest" ? 0.5 : 0.52);
    let m = chrome * softPeak(lum, kind === "chest" ? 0.18 : 0.2, kind === "chest" ? 0.5 : 0.52, 0.88);
    let highlight = chrome * clamp((lum - (kind === "chest" ? 0.52 : 0.55)) / (kind === "chest" ? 0.38 : 0.35), 0, 1);
    if (chrome > 0.5 && lum > 0.88) highlight = Math.max(highlight, 0.97);
    if (kind === "chest" && a > 0.6 && lum < 0.16) d = Math.max(d, 0.92);
    dark[p] = u8(d);
    mid[p] = u8(m);
    hi[p] = u8(highlight);
  }
  await yieldThread();

  const maps = { dark, mid, highlight: hi };
  if (wantTeal) maps.teal = teal;

  let black;
  if (wantTeal) {
    const colorBin = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (teal[i] > 64 || mid[i] > 64 || hi[i] > 64) colorBin[i] = 1;
    }
    const near = dilateBin(colorBin, w, h, 4);
    black = new Uint8Array(n);
    const soft = new Float32Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const a = rgba[i + 3] / 255;
      if (a <= 0.4 || !near[p] || tealness[p] >= 64) continue;
      const pr = rgba[i] * a;
      const pg = rgba[i + 1] * a;
      const pb = rgba[i + 2] * a;
      const lum = (0.2126 * pr + 0.7152 * pg + 0.0722 * pb) / 255;
      if (lum < 0.14) soft[p] = a;
    }
    const blurred = gaussianBlur(soft, w, h, 0.6);
    for (let i = 0; i < n; i++) black[i] = u8(blurred[i]);
    maps.black = black;
    await yieldThread();
  }

  if (darkGarment) {
    const under = new Uint8Array(n);
    const keys = Object.keys(maps);
    for (let i = 0; i < n; i++) {
      let other = 0;
      let bright = 0;
      for (const k of keys) {
        const v = maps[k][i];
        if (v > other) other = v;
        if (k === "teal" || k === "mid" || k === "highlight") if (v > bright) bright = v;
      }
      let u = other * 0.35 + bright * 0.8;
      if (other > 20) u = Math.max(u, 140);
      if (other > 89) u = Math.max(u, 230);
      under[i] = u > 255 ? 255 : u | 0;
    }
    maps.underbase = choke(under, w, h, CHOKE_IN * DPI);
    await yieldThread();
  }

  let order = darkGarment
    ? ["underbase", "teal", "dark", "mid", "highlight", "black"]
    : ["teal", "dark", "mid", "highlight", "black"];
  order = order.filter((k) => maps[k]);

  if (inkCount === "auto") {
    order = order.filter((k) => k === "underbase" || significant(maps[k]));
  } else {
    const target = Number(inkCount);
    const merges = [
      ["black", "dark"],
      ["mid", "highlight"],
      ["dark", "highlight"],
      ["teal", "dark"],
    ];
    while (order.length > target) {
      let did = false;
      for (const [from, to] of merges) {
        if (order.includes(from) && order.includes(to) && order.length > target) {
          maxInto(maps[to], maps[from]);
          order = order.filter((k) => k !== from);
          did = true;
          break;
        }
      }
      if (!did) break;
    }
  }

  const channels = order.map((key, index) => ({
    key,
    ...INK_INFO[key],
    order: index + 1,
    coverage: maps[key],
  }));
  return { channels, w, h };
}

/**
 * Clustered-dot film. Returns MSB-first bits, 1 = white (no ink), 0 = black (ink).
 * The screen is evaluated at `dpi` (600 for films) while coverage is sampled
 * from the 300 DPI map.
 */
export async function halftoneBits(cov, covW, covH, filmW, filmH, angleDeg, lpi, dpi, onRows) {
  const rowBytes = Math.ceil(filmW / 8);
  const bits = new Uint8Array(rowBytes * filmH);
  bits.fill(255);
  const cell = dpi / lpi;
  const theta = (angleDeg * Math.PI) / 180;
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const scaleX = covW / filmW;
  const scaleY = covH / filmH;
  for (let y = 0; y < filmH; y++) {
    const covY = Math.min(covH - 1, (y * scaleY) | 0);
    const covRow = covY * covW;
    let empty = true;
    const rowEnd = covRow + covW;
    for (let i = covRow; i < rowEnd; i++) {
      if (cov[i] > 5) {
        empty = false;
        break;
      }
    }
    if (empty) {
      if ((y & 255) === 0 && onRows) await onRows(y, filmH);
      continue;
    }
    const yst = y * st;
    const yct = y * ct;
    const bitRow = y * rowBytes;
    for (let x = 0; x < filmW; x++) {
      const c = cov[covRow + Math.min(covW - 1, (x * scaleX) | 0)];
      if (c <= 5) continue;
      let dot = true;
      if (c < 247) {
        const xr = x * ct + yst;
        const yr = -x * st + yct;
        let fx = (xr / cell) % 1;
        if (fx < 0) fx += 1;
        fx -= 0.5;
        let fy = (yr / cell) % 1;
        if (fy < 0) fy += 1;
        fy -= 0.5;
        const t = (fx * fx + fy * fy) * 2;
        dot = c / 255 > (t < 1 ? t : 1);
      }
      if (dot) bits[bitRow + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
    if ((y & 63) === 0) {
      await yieldThread();
      if (onRows) await onRows(y, filmH);
    }
  }
  return bits;
}

/** Color composite of the spot inks on black, at `simW` pixels wide. */
export async function simulateComposite(channels, covW, covH, simW) {
  const simH = Math.max(1, Math.round((covH / covW) * simW));
  const rgb = new Uint8Array(simW * simH * 3);
  const scaleX = covW / simW;
  const scaleY = covH / simH;
  const simDpi = DPI * (simW / covW);
  const prepared = channels.map((ch) => ({
    rgb: ch.rgb,
    cov: ch.coverage,
    angle: ch.angle == null ? 45 : ch.angle,
    lpi: ch.lpi || LPI,
  }));
  for (let y = 0; y < simH; y++) {
    const covY = Math.min(covH - 1, (y * scaleY) | 0) * covW;
    for (let x = 0; x < simW; x++) {
      const ci = covY + Math.min(covW - 1, (x * scaleX) | 0);
      let r = 0;
      let g = 0;
      let b = 0;
      for (const ch of prepared) {
        const c = ch.cov[ci];
        if (c <= 5) continue;
        let dot = true;
        if (c < 247) {
          const cell = simDpi / ch.lpi;
          const theta = (ch.angle * Math.PI) / 180;
          const ct = Math.cos(theta);
          const st = Math.sin(theta);
          const xr = x * ct + y * st;
          const yr = -x * st + y * ct;
          let fx = (xr / cell) % 1;
          if (fx < 0) fx += 1;
          fx -= 0.5;
          let fy = (yr / cell) % 1;
          if (fy < 0) fy += 1;
          fy -= 0.5;
          const t = (fx * fx + fy * fy) * 2;
          dot = c / 255 > (t < 1 ? t : 1);
        }
        if (dot) {
          r = ch.rgb[0];
          g = ch.rgb[1];
          b = ch.rgb[2];
        }
      }
      const o = (y * simW + x) * 3;
      rgb[o] = r;
      rgb[o + 1] = g;
      rgb[o + 2] = b;
    }
    if ((y & 31) === 0) await yieldThread();
  }
  return { rgb, w: simW, h: simH };
}
