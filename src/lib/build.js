import JSZip from "jszip";
import { makeAlpha } from "./alpha.js";
import { upscaleRgba } from "./upscale.js";
import { renderChrome } from "./chrome.js";
import {
  clamp,
  colorLabel,
  cropToContent,
  hexToRgb,
  relLuminance,
  resizeRGBA,
  slugName,
  unsharpRGB,
  yieldThread,
} from "./image.js";
import { drawGarment, placePrint } from "./mockup.js";
import { encodeGray1, encodeRGB, encodeRGBA, setPngDpi } from "./png.js";
import { buildArtPdf, buildSeparationPdf, buildSpecPdf, buildVectorPdf, pageGeometry } from "./pdf.js";
import { DPI, FILM_DPI, extractChannels, halftoneBits, simulateComposite } from "./separate.js";
import { chestVector } from "./vector.js";

const BODY_IN = { XS: 18, S: 20, M: 22, L: 24, XL: 26, "2XL": 28, "3XL": 30, "4XL": 32 };

function garmentPhrase(g) {
  const kind = g.kind === "tee" ? "t-shirt" : "crewneck sweatshirt";
  return `${g.size} ${kind}`;
}

function rgbaToRgb(rgba) {
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return rgb;
}

function compositeOn(rgba, w, h, hex) {
  const { r, g, b } = hexToRgb(hex);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, p = 0; p < w * h; p++, i += 4) {
    const a = rgba[i + 3] / 255;
    out[i] = rgba[i] * a + r * (1 - a);
    out[i + 1] = rgba[i + 1] * a + g * (1 - a);
    out[i + 2] = rgba[i + 2] * a + b * (1 - a);
    out[i + 3] = 255;
  }
  return out;
}

function fitPrint(cropped, widthIn, heightIn, lock, dpi) {
  const margin = Math.max(2, Math.round(0.06 * dpi));
  const boxW = Math.max(32, Math.round(widthIn * dpi));
  const artMaxW = Math.max(16, boxW - margin * 2);
  const naturalH = Math.round(cropped.h * (artMaxW / cropped.w)) + margin * 2;
  const boxH = !lock && heightIn ? Math.max(32, Math.round(Number(heightIn) * dpi)) : naturalH;
  const artMaxH = Math.max(16, boxH - margin * 2);
  const scale = Math.min(artMaxW / cropped.w, artMaxH / cropped.h);
  const fw = Math.max(1, Math.round(cropped.w * scale));
  const fh = Math.max(1, Math.round(cropped.h * scale));
  let fitted = resizeRGBA(cropped.rgba, cropped.w, cropped.h, fw, fh);
  fitted = unsharpRGB(fitted, fw, fh, 0.45, 0.8);
  const canvas = new Uint8ClampedArray(boxW * boxH * 4);
  const ox = Math.round((boxW - fw) / 2);
  const oy = Math.round((boxH - fh) / 2);
  for (let y = 0; y < fh; y++) {
    canvas.set(fitted.subarray(y * fw * 4, (y + 1) * fw * 4), ((y + oy) * boxW + ox) * 4);
  }
  return { rgba: canvas, w: boxW, h: boxH, inches: [boxW / dpi, boxH / dpi] };
}

function pasteCentered(fitted, fw, fh, canvasW, margin) {
  const canvasH = fh + margin * 2;
  const out = new Uint8ClampedArray(canvasW * canvasH * 4);
  for (let y = 0; y < fh; y++) {
    const src = y * fw * 4;
    const dst = ((y + margin) * canvasW + margin) * 4;
    out.set(fitted.subarray(src, src + fw * 4), dst);
  }
  return { rgba: out, w: canvasW, h: canvasH };
}

async function toJpeg(rgba, w, h, maxW = 780) {
  const scale = Math.min(1, maxW / w);
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const fitted = dw === w && dh === h ? rgba : resizeRGBA(rgba, w, h, dw, dh);
  const canvas = new OffscreenCanvas(dw, dh);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(fitted), dw, dh), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
  return new Uint8Array(await blob.arrayBuffer());
}

async function filmPreview({ location, title, ink, inkCount, pageIndex, pages, bits, filmW, filmH, sim, artWIn, artHIn }) {
  const geom = pageGeometry(artWIn, artHIn);
  const W = 820;
  const H = Math.max(1, Math.round(W * (geom.pageH / geom.pageW)));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const s = W / geom.pageW;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#111";
  ctx.font = "600 15px sans-serif";
  ctx.fillText(location.toUpperCase(), 22, 28);
  ctx.font = "12px sans-serif";
  ctx.fillText("FILM POSITIVE  ·  ACTUAL SIZE  ·  DO NOT SCALE", W - 330, 28);
  ctx.font = "700 22px sans-serif";
  ctx.fillText(title, 22, 58);
  if (ink) {
    ctx.fillStyle = ink.hex;
    ctx.fillRect(W - 108, 40, 72, 34);
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 1;
    ctx.strokeRect(W - 108, 40, 72, 34);
    ctx.fillStyle = "#111";
    ctx.font = "13px sans-serif";
    ctx.fillText(ink.pantone, 22, 82);
    const screen = ink.lpi ? `${ink.lpi} LPI @ ${ink.angle}°` : "50 LPI @ 45° where not solid";
    ctx.fillText(`Print order ${ink.order} of ${inkCount}   ·   ${screen}`, 22, 102);
  }
  const ax = geom.artX * s;
  const ay = (geom.pageH - geom.artY - geom.artH) * s;
  const aw = Math.max(1, Math.round(geom.artW * s));
  const ah = Math.max(1, Math.round(geom.artH * s));
  const img = ctx.createImageData(aw, ah);
  if (bits) {
    const rowBytes = Math.ceil(filmW / 8);
    for (let y = 0; y < ah; y++) {
      const sy = Math.min(filmH - 1, ((y * filmH) / ah) | 0);
      for (let x = 0; x < aw; x++) {
        const sx = Math.min(filmW - 1, ((x * filmW) / aw) | 0);
        const bit = (bits[sy * rowBytes + (sx >> 3)] >> (7 - (sx & 7))) & 1;
        const v = bit ? 255 : 0;
        const o = (y * aw + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
        img.data[o + 3] = 255;
      }
    }
  } else if (sim) {
    for (let y = 0; y < ah; y++) {
      const sy = Math.min(sim.h - 1, ((y * sim.h) / ah) | 0);
      for (let x = 0; x < aw; x++) {
        const sx = Math.min(sim.w - 1, ((x * sim.w) / aw) | 0);
        const si = (sy * sim.w + sx) * 3;
        const o = (y * aw + x) * 4;
        img.data[o] = sim.rgb[si];
        img.data[o + 1] = sim.rgb[si + 1];
        img.data[o + 2] = sim.rgb[si + 2];
        img.data[o + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, Math.round(ax), Math.round(ay));
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(ax), Math.round(ay), aw, ah);
  ctx.font = "12px sans-serif";
  ctx.fillStyle = "#111";
  ctx.fillText(`Page ${pageIndex} of ${pages}`, W - 110, H - 16);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  return new Uint8Array(await blob.arrayBuffer());
}

function extractFromSource(rgba, w, h, targetW) {
  const x0 = clamp(Math.round((1388 / 2048) * w), 0, w - 2);
  const y0 = clamp(Math.round((70 / 1152) * h), 0, h - 2);
  const x1 = clamp(Math.round((1705 / 2048) * w), x0 + 1, w);
  const y1 = clamp(Math.round((510 / 1152) * h), y0 + 1, h);
  const cw = x1 - x0;
  const ch = y1 - y0;
  const crop = new Uint8ClampedArray(cw * ch * 4);
  let mass = 0;
  for (let y = 0; y < ch; y++) {
    const src = ((y0 + y) * w + x0) * 4;
    crop.set(rgba.subarray(src, src + cw * 4), y * cw * 4);
  }
  for (let i = 3; i < crop.length; i += 4) if (crop[i] > 16) mass++;
  if (mass < 400) return null;
  const cropped = cropToContent(crop, cw, ch, 6);
  const dh = Math.max(1, Math.round(cropped.h * (targetW / cropped.w)));
  return { rgba: resizeRGBA(cropped.rgba, cropped.w, cropped.h, targetW, dh), w: targetW, h: dh };
}

async function buildFilms(rgba, w, h, kind, settings, artWIn, artHIn, location, placement, report, pct0, previews, artDpi = DPI) {
  const extracted = await extractChannels(rgba, w, h, kind, {
    inkCount: settings.inkCount,
    darkGarment: settings.darkGarment,
  });
  const channels = extracted.channels;
  await report(pct0, `${location}: ${channels.length} inks`);
  const simW = Math.min(w, 980);
  const sim = await simulateComposite(channels, w, h, simW);
  const simPng = encodeRGB(sim.rgb, sim.w, sim.h, 120);
  const pages = 1 + channels.length;
  previews.push({
    id: `${kind}-cover`,
    group: "film",
    title: `${location} · composite`,
    bytes: await filmPreview({
      location,
      title: "COMPOSITE PREVIEW + INK LIST (not a film)",
      ink: null,
      pageIndex: 1,
      pages,
      sim,
      artWIn,
      artHIn,
    }),
  });
  const filmDpi = Math.max(FILM_DPI, artDpi);
  const filmW = Math.round(w * (filmDpi / artDpi));
  const filmH = Math.round(h * (filmDpi / artDpi));
  const films = {};
  const pngs = [];
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    await report(pct0 + 2 + i * 3, `${location} film ${i + 1}/${channels.length}: ${ch.short}`);
    const bits = await halftoneBits(ch.coverage, w, h, filmW, filmH, ch.angle ?? 45, ch.lpi || 50, filmDpi);
    ch.coverage = null;
    const png = encodeGray1(bits, filmW, filmH, filmDpi);
    pngs.push({ name: `${ch.key}-film.png`, png });
    films[ch.key] = { bits, w: filmW, h: filmH };
    previews.push({
      id: `${kind}-${ch.key}`,
      group: "film",
      title: `${location} · ${ch.name}`,
      bytes: await filmPreview({
        location,
        title: ch.name,
        ink: ch,
        inkCount: channels.length,
        pageIndex: i + 2,
        pages,
        bits,
        filmW,
        filmH,
        artWIn,
        artHIn,
      }),
    });
    await yieldThread();
  }
  const pdf = await buildSeparationPdf({
    location,
    placement,
    artWIn,
    artHIn,
    channels,
    films,
    simPng,
  });
  for (const key of Object.keys(films)) films[key].bits = null;
  return { pdf, pngs, channels };
}

export async function buildPackage(font, rgbaIn, width, height, settings, report) {
  const warnings = [];
  const name = (settings.name || "Stu").trim().slice(0, 32) || "Stu";
  const slug = slugName(name);
  const color = settings.garmentColor || "#111111";
  const darkGarment = relLuminance(color) < 0.35;
  const dpi = clamp(Number(settings.dpi) || DPI, 72, 600);
  const backWidthIn = clamp(Number(settings.backWidthIn) || 12, 0.5, 20);
  const frontWidthIn = clamp(Number(settings.frontWidthIn) || 10, 0.5, 20);
  const chestWidthIn = clamp(Number(settings.chestWidthIn) || 3.5, 0.5, 12);
  const backLock = settings.backLock !== false;
  const frontLock = settings.frontLock !== false;
  const chestLock = settings.chestLock !== false;
  let garments = Array.isArray(settings.garments) ? settings.garments.filter((g) => g && (g.kind === "sweater" || g.kind === "tee")) : [];
  if (!garments.length) {
    garments = [
      { kind: "sweater", size: "XL" },
      { kind: "tee", size: "XL" },
    ];
  }
  garments = garments.map((g) => ({
    kind: g.kind,
    size: BODY_IN[g.size] ? g.size : "XL",
  }));
  const inkCount = settings.inkCount === 4 || settings.inkCount === 5 || settings.inkCount === 6 || settings.inkCount === "4" || settings.inkCount === "5" || settings.inkCount === "6"
    ? Number(settings.inkCount)
    : "auto";
  const tuned = { ...settings, name, inkCount, darkGarment, backWidthIn, frontWidthIn, chestWidthIn, dpi };

  const profile = settings.upscaleProfile || {};
  const printLong = Math.round(Math.max(backWidthIn, frontWidthIn) * dpi * Math.max(width, height) / Math.max(width, 1));
  const targetLong = Math.min(profile.longEdge || 3000, Math.max(Math.max(width, height), printLong));
  let working = { rgba: rgbaIn, w: width, h: height, mode: "none" };
  if (targetLong > Math.max(width, height) * 1.05) {
    await report(5, "Upscaling the artwork");
    working = await upscaleRgba(rgbaIn, width, height, {
      targetLong,
      tile: profile.tile || 128,
      overlap: profile.native ? 24 : 16,
      onProgress: async (frac) => {
        await report(5 + frac * 8, `Upscaling ${Math.round(frac * 100)}%`);
      },
    });
    if (working.warning) warnings.push(working.warning);
    else if (working.mode === "realesrgan") {
      warnings.push("Back art was upscaled with tiled Real-ESRGAN (realesr-general-x4v3), then matted at the higher resolution.");
    }
  }
  await report(14, "Removing the background");
  let matted = await makeAlpha(working.rgba, working.w, working.h);
  if (matted.needsModel && settings.removeComplex) {
    try {
      await report(8, "Background is busy — running the removal model");
      const removed = await settings.removeComplex(working.rgba, working.w, working.h);
      if (removed) matted = { rgba: removed.rgba, w: removed.w, h: removed.h, mode: "model" };
    } catch (err) {
      warnings.push(`Background model was unavailable (${err.message || err}). Used a color flood-fill instead.`);
      if (matted.mode === "complex") matted = await makeAlpha(working.rgba, working.w, working.h, { force: true });
    }
  } else if (matted.needsModel && matted.mode === "complex") {
    warnings.push("Background is not a flat color, so a simple flood-fill was used. Edges may need a cleanup.");
    matted = await makeAlpha(working.rgba, working.w, working.h, { force: true });
  }
  if (matted.warning) warnings.push(matted.warning);
  await report(18, "Fitting the prints");

  const chestTarget = Math.round(chestWidthIn * dpi);
  const fromSource = extractFromSource(matted.rgba, matted.w, matted.h, chestTarget);
  const cropped = cropToContent(matted.rgba, matted.w, matted.h, 0);
  const back = fitPrint(cropped, backWidthIn, settings.backHeightIn, backLock, dpi);
  const front = backWidthIn === frontWidthIn && backLock && frontLock
    ? back
    : fitPrint(cropped, frontWidthIn, settings.frontHeightIn, frontLock, dpi);
  const backIn = back.inches;
  const frontIn = front.inches;
  if (back.w > cropped.w * 1.5) {
    warnings.push(`Back art is enlarged about ${(back.w / cropped.w).toFixed(1)}× from the source. Fine detail will be softer than a native file.`);
  }
  await report(30, "Drawing the chest name");
  let chest = await renderChrome(font, name, chestTarget);
  if (!chestLock && settings.chestHeightIn) {
    const boxH = Math.max(16, Math.round(Number(settings.chestHeightIn) * dpi));
    const scale = Math.min(chestTarget / chest.w, boxH / chest.h);
    const fw = Math.max(1, Math.round(chest.w * scale));
    const fh = Math.max(1, Math.round(chest.h * scale));
    chest = { rgba: resizeRGBA(chest.rgba, chest.w, chest.h, fw, fh), w: fw, h: fh };
  }
  const chestIn = [chest.w / dpi, chest.h / dpi];
  const vector = chestVector(font, name, chestIn[0]);

  const previews = [];
  const onColor = compositeOn(back.rgba, back.w, back.h, color);
  previews.push({
    id: "back-art",
    group: "art",
    title: "Back print",
    bytes: await toJpeg(onColor, back.w, back.h, 900),
  });
  const chestOn = compositeOn(chest.rgba, chest.w, chest.h, color);
  previews.push({
    id: "chest-art",
    group: "art",
    title: `${name} chest`,
    bytes: await toJpeg(chestOn, chest.w, chest.h, 700),
  });

  await report(40, "Placing prints on the garments");
  const mockups = [];
  for (const g of garments) {
    const bodyIn = BODY_IN[g.size];
    for (const view of ["front", "back"]) {
      const scene = drawGarment(g.kind, view, color, bodyIn);
      let placed;
      if (view === "front") {
        const cx = scene.centerX + 4 * scene.pxPerIn;
        const top = scene.shoulderY + 3.75 * scene.pxPerIn;
        placed = placePrint(scene, chest.rgba, chest.w, chest.h, chestWidthIn, cx, top);
      } else {
        const top = scene.collarBottom + 3.5 * scene.pxPerIn;
        placed = placePrint(scene, back.rgba, back.w, back.h, backWidthIn, scene.centerX, top);
      }
      const file =
        g.kind === "tee"
          ? `mockups/tee-${view}-mockup.png`
          : `mockups/${view}-mockup.png`;
      const png = encodeRGB(rgbaToRgb(placed.rgba), placed.w, placed.h, 150);
      mockups.push({ file, png, rgba: placed.rgba, w: placed.w, h: placed.h });
      previews.push({
        id: file,
        group: "mockup",
        title: file.split("/").pop().replace(".png", "").replace(/-/g, " "),
        bytes: await toJpeg(placed.rgba, placed.w, placed.h, 700),
      });
      await yieldThread();
    }
  }

  await report(48, "Separating the back print");
  const backSeps = await buildFilms(
    back.rgba,
    back.w,
    back.h,
    "back",
    tuned,
    backIn[0],
    backIn[1],
    "BACK PRINT",
    "Place centered on the back, top of the art about 3.5 in below the collar.",
    report,
    46,
    previews,
    dpi,
  );
  await report(62, "Separating the front print");
  const frontSeps = front === back
    ? backSeps
    : await buildFilms(
        front.rgba,
        front.w,
        front.h,
        "front",
        tuned,
        frontIn[0],
        frontIn[1],
        "FRONT PRINT",
        "Centered on the front. Use this file when the design is a full front print rather than a left-chest logo.",
        report,
        62,
        previews,
        dpi,
      );
  await report(80, "Separating the chest print");
  const chestSeps = await buildFilms(
    chest.rgba,
    chest.w,
    chest.h,
    "chest",
    tuned,
    chestIn[0],
    chestIn[1],
    `LEFT CHEST  ·  ${name.toUpperCase()}`,
    "Wearer's left chest: about 3.75 in down from the shoulder seam, centered about 4 in from center front.",
    report,
    80,
    previews,
    dpi,
  );

  await report(92, "Writing the spec sheet and PDFs");
  const backPng = encodeRGBA(back.rgba, back.w, back.h, dpi);
  const frontPng = front === back ? backPng : encodeRGBA(front.rgba, front.w, front.h, dpi);
  const chestPng = encodeRGBA(chest.rgba, chest.w, chest.h, dpi);
  const backPdf = await buildArtPdf(backPng, backIn[0], backIn[1], "Back print", `Print package for ${name}`);
  const frontPdf = front === back ? backPdf : await buildArtPdf(frontPng, frontIn[0], frontIn[1], "Front print", `Print package for ${name}`);
  const chestPdf = await buildVectorPdf(vector, `${name} left-chest logo`, `Print package for ${name}`);
  let fromPng = null;
  if (fromSource) fromPng = encodeRGBA(fromSource.rgba, fromSource.w, fromSource.h, dpi);

  const colorName = colorLabel(color);
  const garmentLine = garments.map(garmentPhrase).join(" and ");
  const files = [
    ["back/back-print.png", `Back art, transparent PNG, ${back.w}x${back.h} px, ${dpi} DPI`],
    ["back/back-print.pdf", `Same back art at actual size (${backIn[0].toFixed(2)} x ${backIn[1].toFixed(2)} in)`],
    ["front/front-print.png", `Full front art, transparent PNG, ${front.w}x${front.h} px, ${dpi} DPI`],
    ["front/front-print.pdf", `Full front art at actual size (${frontIn[0].toFixed(2)} x ${frontIn[1].toFixed(2)} in)`],
    [`chest/${slug}-chest.png`, `Left-chest "${name}", transparent PNG, ${chest.w}x${chest.h} px, ${dpi} DPI`],
    [`chest/${slug}-chest.svg`, "Vector left-chest name (silver gradient and dark outline)"],
    [`chest/${slug}-chest.pdf`, `Vector left-chest name, actual size (${chestIn[0].toFixed(2)} in wide)`],
  ];
  if (fromPng) files.push([`chest/${slug}-chest-from-source.png`, "Alternate chest mark cropped from the source artwork"]);
  files.push(
    ["separations/back-separations.pdf", `Screen films for the back: cover + ${backSeps.channels.length} inks`],
    ["separations/front-separations.pdf", `Screen films for the full front: cover + ${frontSeps.channels.length} inks`],
    ["separations/chest-separations.pdf", `Screen films for the chest: cover + ${chestSeps.channels.length} inks`],
    ["separations/README-SEPARATIONS.txt", "How to print the films"],
  );
  files.push(
    [
      "separations/films/back/",
      `1-bit films: ${backSeps.channels.map((c) => c.short).join(", ")}`,
    ],
    [
      "separations/films/front/",
      `1-bit films: ${frontSeps.channels.map((c) => c.short).join(", ")}`,
    ],
    [
      "separations/films/chest/",
      `600 DPI 1-bit: ${chestSeps.channels.map((c) => c.short).join(", ")}`,
    ],
  );
  for (const mock of mockups) files.push([mock.file, "Placement mockup, not a print file"]);
  files.push(["PRINT-SPEC.pdf", "This specification sheet"], ["README.txt", "Short file guide"]);

  const backPreview = encodeRGB(rgbaToRgb(resizeRGBA(onColor, back.w, back.h, 640, Math.round(640 * (back.h / back.w)))), 640, Math.round(640 * (back.h / back.w)), 100);
  const chestPrevW = 420;
  const chestPrevH = Math.round(chestPrevW * (chest.h / chest.w));
  const chestPreview = encodeRGB(rgbaToRgb(resizeRGBA(chestOn, chest.w, chest.h, chestPrevW, chestPrevH)), chestPrevW, chestPrevH, 100);
  const mockPreview = mockups[0] ? encodeRGB(rgbaToRgb(resizeRGBA(mockups[0].rgba, mockups[0].w, mockups[0].h, 280, Math.round(280 * (mockups[0].h / mockups[0].w)))), 280, Math.round(280 * (mockups[0].h / mockups[0].w)), 72) : null;

  const underbaseNote = darkGarment
    ? "On this dark garment, print the white underbase first (it is choked 1 pt), flash, then the other inks."
    : "The garment is light, so no white underbase is included. Proof it before a production run.";

  const spec = await buildSpecPdf({
    name,
    brand: "Print Shop Separator",
    garmentLine,
    colorName,
    methodShort: "DTG / DTF or screen print",
    garmentCopy: `Garments: ${garmentLine}. Base color ${colorName} (${color}). ${underbaseNote}`,
    methodCopy:
      "Preferred: DTG or DTF, which hold the photographic chrome and fine detail. Screen printing: film-positive separations are in separations/. Each film page is pure black and white, one ink per page, at actual size, with registration marks in the same place on every page. Color swatches and Pantone suggestions sit in the label margin only.",
    backCopy: `Back: ${backIn[0].toFixed(2)} in wide by ${backIn[1].toFixed(2)} in tall (${back.w} x ${back.h} px at ${dpi} DPI). Center it on the back, top about 3.5 in below the collar. Full front file: ${frontIn[0].toFixed(2)} x ${frontIn[1].toFixed(2)} in (${front.w} x ${front.h} px) for a centered front print.`,
    chestCopy: `Size ${chestIn[0].toFixed(2)} in wide by ${chestIn[1].toFixed(2)} in tall (${chest.w} x ${chest.h} px at ${dpi} DPI). Place on the wearer's left chest: top of the art about 3.75 in down from the shoulder seam, centered about 4 in from center front toward the wearer's left.`,
    files,
    notes: [
      `Transparent PNGs at ${dpi} DPI. Do not place them on a white box.`,
      "Do not re-sharpen or auto-enhance the print files.",
      "Upscale prefers tiled Real-ESRGAN (realesr-general-x4v3) and falls back to Lanczos. The matte runs after the upscale so chrome edges lose less of their white halo.",
      "Screen films are a limited spot-color reading of the art. DTG or DTF will match a photo more closely.",
      underbaseNote,
      "Mockups are a placement guide only, not print files.",
      "Chrome should read as metallic silver. Confirm any trademarks in the artwork before printing.",
      "Chest script is Kaushan Script, used under the SIL Open Font License.",
    ],
    backPreview,
    chestPreview,
    mockPreview,
  });

  const readme =
    `${name} — print-ready package\n` +
    `${"=".repeat(Math.min(48, name.length + 24))}\n\n` +
    `Garments: ${garmentLine}. Color: ${colorName} (${color}).\n` +
    `Method:   DTG or DTF preferred for photographic art.\n` +
    `          Screen-print films are in separations/ if the shop screens it.\n\n` +
    `Start with PRINT-SPEC.pdf for sizes, placement, and production notes.\n` +
    `For screen printing, also read separations/README-SEPARATIONS.txt.\n\n` +
    `Key artwork:\n` +
    `  back/back-print.png                 back print, ${backWidthIn} in wide, ${dpi} DPI, transparent\n` +
    `  front/front-print.png               full front, ${frontWidthIn} in wide, ${dpi} DPI, transparent\n` +
    `  chest/${slug}-chest.png             left-chest "${name}", ${chestIn[0].toFixed(2)} in wide, ${dpi} DPI\n` +
    `  chest/${slug}-chest.svg / .pdf      vector version of the chest logo\n` +
    (fromPng ? `  chest/${slug}-chest-from-source.png  alternate crop from the source image\n` : "") +
    `  separations/back-separations.pdf    film positives, one ink per page\n` +
    `  separations/front-separations.pdf   film positives for the full front\n` +
    `  separations/chest-separations.pdf   film positives, one ink per page\n\n` +
    `Chest lettering uses Kaushan Script (SIL Open Font License).\n` +
    `The back art was enlarged with Lanczos resampling and a light sharpen,\n` +
    `not a desktop Real-ESRGAN model.\n\n` +
    `Give the print shop the PNG files (and PDFs if they prefer). Mockups are a\n` +
    `visual placement guide only, not print files.\n`;

  const sepReadme =
    `SCREEN-PRINT COLOR SEPARATIONS\n` +
    `==============================\n\n` +
    `One PDF per print location. Page 1 of each is a color composite\n` +
    `preview and the ink list (not a film). Every following page is a film\n` +
    `positive: BLACK = that ink prints, WHITE = no ink. The artwork itself\n` +
    `is pure black and white. The ink name, a color swatch, a Pantone\n` +
    `suggestion, the print order, and the screen (LPI / angle) are in the\n` +
    `label margin only.\n\n` +
    `  back-separations.pdf   — back print, ${backIn[0].toFixed(2)} in wide, ${backSeps.channels.length} inks + cover\n` +
    `  front-separations.pdf  — full front, ${frontIn[0].toFixed(2)} in wide, ${frontSeps.channels.length} inks + cover\n` +
    `  chest-separations.pdf  — left-chest "${name}", ${chestIn[0].toFixed(2)} in wide, ${chestSeps.channels.length} inks + cover\n\n` +
    `Back inks, in print order: ${backSeps.channels.map((c) => c.short).join(", ")}.\n` +
    `Front inks, in print order: ${frontSeps.channels.map((c) => c.short).join(", ")}.\n` +
    `Chest inks, in print order: ${chestSeps.channels.map((c) => c.short).join(", ")}.\n\n` +
    (darkGarment
      ? `Print on a dark garment (${colorName}). Print in the numbered order.\n` +
        `Flash the white underbase before the other screens.\n` +
        `The underbase is choked 1 point (0.014 in) so top colors trap over it\n` +
        `and no white edge flashes out. Do not scale the films.\n`
      : `The garment color is light (${colorName}), so these films have no white underbase.\n` +
        `Print in the numbered order. Do not scale the films.\n`) +
    `Registration marks are in the same position on every page.\n\n` +
    `Chrome and tonal areas are clustered-dot halftones at about 50 LPI with\n` +
    `offset screen angles. 1-bit 600 DPI PNGs of each film are in films/.\n` +
    `This is a limited spot-color interpretation of photographic art; DTG/DTF\n` +
    `will match the original more closely.\n`;

  await report(96, "Packing the ZIP");
  const zip = new JSZip();
  const add = (path, data) => zip.file(path, data);
  add("README.txt", readme);
  add("PRINT-SPEC.pdf", spec);
  add("back/back-print.png", backPng);
  add("back/back-print.pdf", backPdf);
  add("front/front-print.png", frontPng);
  add("front/front-print.pdf", frontPdf);
  add(`chest/${slug}-chest.png`, chestPng);
  add(`chest/${slug}-chest.svg`, vector.svg);
  add(`chest/${slug}-chest.pdf`, chestPdf);
  if (fromPng) add(`chest/${slug}-chest-from-source.png`, fromPng);
  for (const mock of mockups) add(mock.file, mock.png);
  add("separations/back-separations.pdf", backSeps.pdf);
  add("separations/front-separations.pdf", frontSeps.pdf);
  add("separations/chest-separations.pdf", chestSeps.pdf);
  add("separations/README-SEPARATIONS.txt", sepReadme);
  for (const film of backSeps.pngs) add(`separations/films/back/${film.name}`, film.png);
  for (const film of frontSeps.pngs) add(`separations/films/front/${film.name}`, film.png);
  for (const film of chestSeps.pngs) add(`separations/films/chest/${film.name}`, film.png);

  const zipBytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await report(100, "Ready");
  return {
    zipBytes,
    zipName: `${slug}-print-files.zip`,
    previews,
    summary: {
      name,
      slug,
      files: Object.keys(zip.files).filter((p) => !p.endsWith("/")),
      backInks: backSeps.channels.map((c) => c.name),
      frontInks: frontSeps.channels.map((c) => c.name),
      chestInks: chestSeps.channels.map((c) => c.name),
      warnings,
      backIn,
      frontIn,
      chestIn,
      darkGarment,
    },
  };
}
