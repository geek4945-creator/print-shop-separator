import { clamp, distanceInside, yieldThread } from "./image.js";

export const DPI = 300;
export const FILM_DPI = 600;
export const LPI = 50;
export const CHOKE_PT = 1;
export const CHOKE_IN = CHOKE_PT / 72;

const SCREEN_ANGLES = [15, 75, 45, 0, 22.5, 30, 60, 82.5];

/** A short Pantone solid list so each ink can name the nearest suggestion. */
const PANTONE = [
  ["Black C", 16, 16, 16],
  ["Cool Gray 11 C", 83, 86, 90],
  ["Cool Gray 7 C", 146, 148, 151],
  ["Cool Gray 4 C", 187, 188, 188],
  ["Cool Gray 1 C", 232, 232, 230],
  ["185 C", 228, 0, 43],
  ["186 C", 200, 16, 46],
  ["021 C", 254, 80, 0],
  ["151 C", 255, 130, 0],
  ["123 C", 255, 199, 44],
  ["109 C", 255, 209, 0],
  ["348 C", 0, 132, 61],
  ["355 C", 0, 122, 51],
  ["354 C", 0, 177, 64],
  ["347 C", 0, 149, 67],
  ["3268 C", 0, 178, 169],
  ["321 C", 0, 140, 149],
  ["320 C", 0, 156, 166],
  ["Process Cyan C", 0, 159, 218],
  ["2995 C", 0, 163, 224],
  ["293 C", 0, 61, 165],
  ["286 C", 0, 51, 160],
  ["Reflex Blue C", 0, 20, 137],
  ["2685 C", 51, 0, 114],
  ["2592 C", 145, 0, 170],
  ["Purple C", 187, 41, 187],
  ["Magenta C", 208, 0, 111],
  ["219 C", 218, 24, 132],
  ["213 C", 226, 0, 116],
  ["1767 C", 198, 0, 126],
  ["White", 250, 250, 250],
];

export function nearestPantone(r, g, b) {
  let best = PANTONE[0];
  let bestD = Infinity;
  for (const row of PANTONE) {
    const d = (row[1] - r) ** 2 + (row[2] - g) ** 2 + (row[3] - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = row;
    }
  }
  return best[0] === "White" ? "Opaque White" : `Pantone ${best[0]}`;
}

/** Name a swatch from its hue and lightness. Not hardcoded to teal. */
export function describeColor(r, g, b) {
  const [h180, s, v] = hsv(r, g, b);
  const hue = h180 * 2;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  if (s < 30 || chroma < 18) {
    if (v < 48) return { name: "BLACK", short: "Black" };
    if (v < 105) return { name: "DARK GRAY", short: "Dark Gray" };
    if (v < 175) return { name: "GRAY / SILVER", short: "Gray / Silver" };
    if (v < 225) return { name: "LIGHT GRAY", short: "Light Gray" };
    return { name: "WHITE", short: "White" };
  }
  const bands = [
    [18, "RED", "Red"],
    [42, "ORANGE", "Orange"],
    [70, "YELLOW", "Yellow"],
    [100, "YELLOW GREEN", "Yellow Green"],
    [155, "GREEN", "Green"],
    [178, "TEAL", "Teal"],
    [198, "CYAN", "Cyan"],
    [255, "BLUE", "Blue"],
    [290, "PURPLE", "Purple"],
    [330, "MAGENTA", "Magenta"],
    [360, "RED", "Red"],
  ];
  let pick = bands[bands.length - 1];
  for (const band of bands) {
    if (hue <= band[0]) {
      pick = band;
      break;
    }
  }
  return { name: pick[1], short: pick[2] };
}

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

function u8(v) {
  return v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
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

function isNeutral(r, g, b) {
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  return chroma < 18 || hsv(r, g, b)[1] < 30;
}

function dist3(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function hexOf(r, g, b) {
  return `#${[r, g, b].map((v) => clamp(v, 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function uniqueNames(inks) {
  const groups = new Map();
  for (const ink of inks) {
    const list = groups.get(ink.short) || [];
    list.push(ink);
    groups.set(ink.short, list);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.v - b.v);
    list.forEach((ink, index) => {
      const shade = index === 0 ? "DARK " : index === list.length - 1 ? "LIGHT " : "";
      if (!shade) return;
      ink.short = `${shade}${ink.short}`.replace("DARK DARK ", "DARK ").replace("LIGHT LIGHT ", "LIGHT ");
      ink.name = ink.short.toUpperCase();
    });
  }
}

/**
 * Spot colors from the actual artwork. Chromatic pixels (red, green, teal, …)
 * get their own plates. Neutrals are black / gray / white, never forced to teal.
 */
export async function extractChannels(rgba, w, h, _kind, { inkCount = "auto", darkGarment = true } = {}) {
  const n = w * h;
  const samples = [];
  const step = Math.max(1, Math.floor(n / 9000));
  for (let p = 0; p < n; p += step) {
    const i = p * 4;
    if (rgba[i + 3] < 40) continue;
    samples.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  }
  const chromatic = [];
  const neutral = [];
  for (const sample of samples) {
    if (isNeutral(sample[0], sample[1], sample[2])) neutral.push(sample);
    else chromatic.push(sample);
  }

  const colorCap = inkCount === "auto" ? 6 : Math.max(1, Number(inkCount) - (darkGarment ? 1 : 0));
  const centers = [];
  const addCenter = (rgb, neutralInk) => {
    let nearest = -1;
    let best = 42 * 42;
    for (let i = 0; i < centers.length; i++) {
      if (centers[i].neutral !== neutralInk) continue;
      const d = dist3(centers[i].rgb, rgb);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    if (nearest >= 0) return false;
    centers.push({ rgb: rgb.slice(), neutral: neutralInk, count: 0 });
    return true;
  };
  const seedByPopulation = (group, neutralInk, cap) => {
    const buckets = [];
    for (const sample of group) {
      let nearest = null;
      let best = 36 * 36;
      for (const bucket of buckets) {
        const d = dist3(bucket.rgb, sample);
        if (d < best) {
          best = d;
          nearest = bucket;
        }
      }
      if (nearest) nearest.count++;
      else buckets.push({ rgb: sample.slice(), count: 1 });
    }
    buckets.sort((a, b) => b.count - a.count);
    const floor = Math.max(8, group.length * 0.08);
    let added = 0;
    for (const bucket of buckets) {
      if (added >= cap || bucket.count < floor) break;
      if (addCenter(bucket.rgb, neutralInk)) added++;
    }
  };
  seedByPopulation(chromatic, false, Math.min(6, colorCap));
  const grayBands = [
    [24, 24, 24],
    [90, 90, 94],
    [150, 150, 154],
    [214, 214, 216],
    [246, 246, 246],
  ];
  const bandGroups = grayBands.map(() => []);
  for (const sample of neutral) {
    let best = 0;
    let bestD = Infinity;
    grayBands.forEach((band, index) => {
      const d = dist3(sample, band);
      if (d < bestD) {
        bestD = d;
        best = index;
      }
    });
    if (bestD < 70 * 70) bandGroups[best].push(sample);
  }
  const neutralFloor = Math.max(8, neutral.length * 0.12);
  bandGroups.forEach((group, index) => {
    if (group.length > neutralFloor) addCenter(grayBands[index], true);
  });
  if (!centers.length && samples.length) addCenter(samples[0], isNeutral(samples[0][0], samples[0][1], samples[0][2]));

  for (let iter = 0; iter < 6; iter++) {
    for (const center of centers) center.sum = [0, 0, 0, 0];
    for (const sample of samples) {
      const neutralInk = isNeutral(sample[0], sample[1], sample[2]);
      let best = null;
      let bd = Infinity;
      for (const center of centers) {
        if (center.neutral !== neutralInk) continue;
        const d = dist3(center.rgb, sample);
        if (d < bd) {
          bd = d;
          best = center;
        }
      }
      if (!best) continue;
      best.sum[0] += sample[0];
      best.sum[1] += sample[1];
      best.sum[2] += sample[2];
      best.sum[3] += 1;
    }
    for (const center of centers) {
      if (!center.sum[3]) continue;
      center.rgb = [center.sum[0] / center.sum[3], center.sum[1] / center.sum[3], center.sum[2] / center.sum[3]];
    }
  }
  const inks = centers
    .filter((center) => center.sum && center.sum[3] > 0)
    .map((center) => {
      const r = Math.round(center.rgb[0]);
      const g = Math.round(center.rgb[1]);
      const b = Math.round(center.rgb[2]);
      const named = describeColor(r, g, b);
      return {
        rgb: [r, g, b],
        v: hsv(r, g, b)[2],
        neutral: center.neutral,
        name: named.name,
        short: named.short,
        count: center.sum[3],
      };
    });
  inks.sort((a, b) => a.v - b.v);
  await yieldThread();

  const maps = inks.map(() => new Uint8Array(n));
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = rgba[i + 3] / 255;
    if (a < 0.02) continue;
    const pix = [rgba[i], rgba[i + 1], rgba[i + 2]];
    const neutralInk = isNeutral(pix[0], pix[1], pix[2]);
    let best = -1;
    let second = -1;
    let bd = Infinity;
    let sd = Infinity;
    for (let k = 0; k < inks.length; k++) {
      if (inks[k].neutral !== neutralInk) continue;
      const d = dist3(inks[k].rgb, pix);
      if (d < bd) {
        sd = bd;
        second = best;
        bd = d;
        best = k;
      } else if (d < sd) {
        sd = d;
        second = k;
      }
    }
    if (best < 0) continue;
    const closeness = clamp(1 - Math.sqrt(bd) / 90, 0.15, 1);
    maps[best][p] = u8(a * closeness);
    if (second >= 0 && inks[best].neutral && Math.sqrt(sd) < 70) {
      const share = clamp(1 - Math.sqrt(sd) / 70, 0, 0.55) * a;
      if (share > 0.08) maps[second][p] = u8(Math.max(maps[second][p] / 255, share));
    }
  }

  const channels = [];
  if (darkGarment) {
    const under = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let other = 0;
      for (const map of maps) if (map[i] > other) other = map[i];
      let u = other * 0.45;
      if (other > 20) u = Math.max(u, 150);
      if (other > 80) u = Math.max(u, 230);
      under[i] = u > 255 ? 255 : u | 0;
    }
    channels.push({
      key: "underbase",
      name: "WHITE UNDERBASE",
      short: "Underbase",
      pantone: "Opaque White (underbase)",
      hex: "#FFFFFF",
      rgb: [255, 255, 255],
      lpi: null,
      angle: 45,
      notes: "Flash after this screen. Choked 1 pt (0.014 in).",
      coverage: choke(under, w, h, CHOKE_IN * DPI),
    });
  }
  inks.forEach((ink, index) => {
    const [r, g, b] = ink.rgb;
    channels.push({
      key: `${ink.short.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${index}`,
      name: ink.name,
      short: ink.short,
      pantone: nearestPantone(r, g, b),
      hex: hexOf(r, g, b),
      rgb: [r, g, b],
      lpi: LPI,
      angle: SCREEN_ANGLES[index % SCREEN_ANGLES.length],
      notes: ink.neutral ? "Neutral ink from the artwork." : `All ${ink.short.toLowerCase()} parts of the art.`,
      v: ink.v,
      coverage: maps[index],
    });
  });
  channels.forEach((channel, index) => {
    channel.order = index + 1;
  });
  const limit = inkCount === "auto" ? channels.length : Number(inkCount);
  const kept = [];
  if (channels[0]?.key === "underbase") kept.push(channels[0]);
  const rest = channels.filter((channel) => channel.key !== "underbase");
  rest.sort((a, b) => meanCov(b.coverage) - meanCov(a.coverage));
  for (const channel of rest) {
    if (kept.length >= limit) break;
    if (inkCount === "auto" && meanCov(channel.coverage) < 0.004) continue;
    kept.push(channel);
  }
  uniqueNames(kept.filter((channel) => channel.key !== "underbase"));
  kept.forEach((channel, index) => {
    channel.order = index + 1;
  });
  await yieldThread();
  return { channels: kept, w, h };
}

function meanCov(cov) {
  let sum = 0;
  const step = cov.length > 500000 ? 4 : 1;
  let count = 0;
  for (let i = 0; i < cov.length; i += step) {
    sum += cov[i];
    count++;
  }
  return sum / (count * 255);
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
