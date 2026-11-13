import { clamp, fastBlur, hexToRgb, relLuminance, resizeRGBA } from "./image.js";

/**
 * Simple garment silhouette. Placement metrics assume the chosen body width
 * (about 26 in pit-to-pit for an XL).
 */
export function drawGarment(kind, view, colorHex, bodyInches, W = 1400, H = 1700) {
  const bodyW = Math.round(W * 0.7);
  const sweater = kind !== "tee";
  const bodyH = Math.round(H * (sweater ? 0.72 : 0.7));
  const neckW = Math.round(bodyW * (sweater ? 0.28 : 0.3));
  const neckD = Math.round(bodyH * (sweater ? 0.1 : 0.09));
  const sleeveW = Math.round(bodyW * (sweater ? 0.42 : 0.36));
  const sleeveH = Math.round(bodyH * (sweater ? 0.55 : 0.28));
  const cuff = Math.round(bodyH * (sweater ? 0.08 : 0.05));
  const hem = Math.round(bodyH * (sweater ? 0.08 : 0.04));
  const shoulderDrop = Math.round(bodyH * (sweater ? 0.04 : 0.02));

  const cx = Math.round(W / 2);
  const top = Math.round(H * 0.1);
  const bodyX0 = cx - Math.round(bodyW / 2);
  const bodyY0 = top + Math.round(neckD * 0.45);
  const bodyX1 = bodyX0 + bodyW;
  const bodyY1 = bodyY0 + bodyH;
  const taper = Math.round(bodyW * 0.03);

  const mask = new OffscreenCanvas(W, H);
  const mctx = mask.getContext("2d");
  mctx.fillStyle = "#fff";
  mctx.beginPath();
  mctx.moveTo(bodyX0 + taper / 2, bodyY0 + shoulderDrop);
  mctx.lineTo(bodyX0, bodyY0 + Math.round(bodyH * 0.18));
  mctx.lineTo(bodyX0 + taper, bodyY1);
  mctx.lineTo(bodyX1 - taper, bodyY1);
  mctx.lineTo(bodyX1, bodyY0 + Math.round(bodyH * 0.18));
  mctx.lineTo(bodyX1 - taper / 2, bodyY0 + shoulderDrop);
  mctx.closePath();
  mctx.fill();

  const sleeve = (left) => {
    const sx = left ? bodyX0 : bodyX1;
    const dir = left ? -1 : 1;
    const armTop = bodyY0 + shoulderDrop;
    const armBot = armTop + sleeveH;
    const pitY = bodyY0 + Math.round(bodyH * 0.22);
    const outerX = sx + dir * sleeveW;
    mctx.beginPath();
    mctx.moveTo(sx, armTop);
    mctx.lineTo(sx + dir * Math.round(sleeveW * 0.85), armTop + Math.round(sleeveH * 0.08));
    mctx.lineTo(outerX, armBot);
    mctx.lineTo(outerX - dir * Math.round(sleeveW * 0.22), armBot);
    mctx.lineTo(sx + dir * Math.round(bodyW * 0.02), pitY);
    mctx.closePath();
    mctx.fill();
  };
  sleeve(true);
  sleeve(false);

  const neckCy = bodyY0 + Math.round(neckD * 0.15);
  const neckBox =
    view === "front"
      ? [cx - neckW / 2, neckCy - neckD * 0.15, neckW, neckD + neckD * 0.15]
      : [cx - neckW * 0.42, neckCy - neckD * 0.05, neckW * 0.84, neckD * 0.6];
  mctx.globalCompositeOperation = "destination-out";
  mctx.fillStyle = "#000";
  mctx.beginPath();
  mctx.ellipse(
    neckBox[0] + neckBox[2] / 2,
    neckBox[1] + neckBox[3] / 2,
    neckBox[2] / 2,
    neckBox[3] / 2,
    0,
    0,
    Math.PI * 2,
  );
  mctx.fill();
  mctx.fillRect(neckBox[0], 0, neckBox[2], neckCy + neckD * (view === "front" ? 0.35 : 0.2));
  mctx.globalCompositeOperation = "source-over";

  const maskData = mctx.getImageData(0, 0, W, H);
  const base = hexToRgb(colorHex);
  const darkShirt = relLuminance(colorHex) < 0.08;
  const fabric = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const yy = y / (H - 1);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const a = maskData.data[i * 4 + 3];
      if (!a) continue;
      const xx = (x / (W - 1)) * 2 - 1;
      let shade = 18 + 10 * Math.exp(-((xx * 1.4) ** 2)) * (0.7 + 0.3 * (1 - yy));
      shade += 4 * Math.sin(xx * 7 + 0.4) * Math.exp(-((xx * 1.1) ** 2));
      shade = clamp(shade, 8, 40);
      let r;
      let g;
      let b;
      if (darkShirt) {
        r = g = b = shade;
      } else {
        const k = shade / 22;
        r = clamp(base.r * k, 0, 255);
        g = clamp(base.g * k, 0, 255);
        b = clamp(base.b * k, 0, 255);
      }
      const o = i * 4;
      fabric[o] = r;
      fabric[o + 1] = g;
      fabric[o + 2] = b;
      fabric[o + 3] = a;
    }
  }

  const rib = darkShirt ? [42, 42, 46] : [
    clamp(base.r * 1.15 + 18, 0, 255),
    clamp(base.g * 1.15 + 18, 0, 255),
    clamp(base.b * 1.15 + 18, 0, 255),
  ];
  for (let y = bodyY1 - hem; y < bodyY1; y++) {
    for (let x = bodyX0 + taper; x < bodyX1 - taper; x++) {
      const i = (y * W + x) * 4;
      if (!fabric[i + 3]) continue;
      const stripe = (y - (bodyY1 - hem)) % Math.max(3, (hem / 8) | 0) === 0;
      const mix = stripe ? 0.55 : 0.35;
      fabric[i] = fabric[i] * (1 - mix) + rib[0] * mix;
      fabric[i + 1] = fabric[i + 1] * (1 - mix) + rib[1] * mix;
      fabric[i + 2] = fabric[i + 2] * (1 - mix) + rib[2] * mix;
    }
  }

  // Collar ring: pixels just outside the neck cut and inside a slightly larger ellipse.
  const outer =
    view === "front"
      ? [neckBox[0] - neckW * 0.08, neckBox[1] - neckD * 0.08, neckBox[2] + neckW * 0.16, neckBox[3] + neckD * 0.14]
      : [cx - neckW * 0.5, neckCy - neckD * 0.12, neckW, neckD * 0.74];
  const ocx = outer[0] + outer[2] / 2;
  const ocy = outer[1] + outer[3] / 2;
  const orx = outer[2] / 2;
  const ory = outer[3] / 2;
  const icx = neckBox[0] + neckBox[2] / 2;
  const icy = neckBox[1] + neckBox[3] / 2;
  const irx = neckBox[2] / 2;
  const iry = neckBox[3] / 2;
  const collar = darkShirt ? [36, 36, 40] : rib;
  for (let y = Math.max(0, Math.floor(outer[1])); y < Math.min(H, Math.ceil(outer[1] + outer[3])); y++) {
    for (let x = Math.max(0, Math.floor(outer[0])); x < Math.min(W, Math.ceil(outer[0] + outer[2])); x++) {
      const oe = ((x - ocx) / orx) ** 2 + ((y - ocy) / ory) ** 2;
      const ie = ((x - icx) / irx) ** 2 + ((y - icy) / iry) ** 2;
      if (oe <= 1 && ie >= 1 && y >= bodyY0 - 4) {
        const i = (y * W + x) * 4;
        fabric[i] = collar[0];
        fabric[i + 1] = collar[1];
        fabric[i + 2] = collar[2];
        fabric[i + 3] = 255;
      }
    }
  }

  const alpha = new Float32Array(W * H);
  for (let i = 0; i < alpha.length; i++) alpha[i] = maskData.data[i * 4 + 3] / 255;
  const blurred = fastBlur(alpha, W, H, 14);
  const scene = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const vy = (y / (H - 1)) * 2 - 1;
    for (let x = 0; x < W; x++) {
      const vx = (x / (W - 1)) * 2 - 1;
      const vig = clamp(1.15 - 0.35 * (vx * vx + vy * vy), 0.7, 1);
      const bg = 24 * vig;
      const i = y * W + x;
      const sx = Math.min(W - 1, x - 6);
      const sy = Math.min(H - 1, y - 14);
      const sh = blurred[sy * W + sx] * 0.55;
      const o = i * 4;
      const a = fabric[o + 3] / 255;
      const underR = bg * (1 - sh);
      const underG = bg * (1 - sh);
      const underB = bg * (1 - sh);
      scene[o] = underR * (1 - a) + fabric[o] * a;
      scene[o + 1] = underG * (1 - a) + fabric[o + 1] * a;
      scene[o + 2] = underB * (1 - a) + fabric[o + 2] * a;
      scene[o + 3] = 255;
    }
  }

  const pxPerIn = bodyW / bodyInches;
  const shoulderY = bodyY0 + shoulderDrop;
  const collarBottom = neckCy + neckD * (view === "back" ? 0.55 : 0.85);
  return { rgba: scene, w: W, h: H, pxPerIn, centerX: cx, shoulderY, collarBottom };
}

export function placePrint(scene, printRgba, printW, printH, widthIn, cx, topY) {
  const tw = Math.max(1, Math.round(widthIn * scene.pxPerIn));
  const th = Math.max(1, Math.round(printH * (tw / printW)));
  const fitted = resizeRGBA(printRgba, printW, printH, tw, th);
  const out = new Uint8ClampedArray(scene.rgba);
  const x0 = Math.round(cx - tw / 2);
  const y0 = Math.round(topY);
  for (let y = 0; y < th; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= scene.h) continue;
    for (let x = 0; x < tw; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= scene.w) continue;
      const si = (y * tw + x) * 4;
      const a = fitted[si + 3] / 255;
      if (a <= 0) continue;
      const di = (dy * scene.w + dx) * 4;
      out[di] = fitted[si] * a + out[di] * (1 - a);
      out[di + 1] = fitted[si + 1] * a + out[di + 1] * (1 - a);
      out[di + 2] = fitted[si + 2] * a + out[di + 2] * (1 - a);
    }
  }
  return { rgba: out, w: scene.w, h: scene.h };
}
