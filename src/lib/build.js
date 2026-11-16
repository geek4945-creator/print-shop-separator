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
import { drawCuff, drawGarment, placePrint } from "./mockup.js";
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

async function filmPreview({ location, title, ink, inks, inkCount, pageIndex, pages, bits, filmW, filmH, sim, artWIn, artHIn }) {
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
  } else if (inks && inks.length) {
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "#111";
    ctx.fillText("Print order", 22, 82);
    let x = 22;
    let y = 108;
    for (const item of inks) {
      const label = `${item.order}. ${item.short}`;
      const w = ctx.measureText(label).width + 40;
      if (x + w > W - 16) {
        x = 22;
        y += 22;
      }
      ctx.fillStyle = item.hex;
      ctx.fillRect(x, y - 12, 18, 14);
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y - 12, 18, 14);
      ctx.fillStyle = "#111";
      ctx.fillText(label, x + 22, y);
      x += w;
    }
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
      inks: channels,
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

const LOCATIONS = {
  back: {
    label: "Back",
    folder: "back",
    stem: "back-print",
    title: "BACK PRINT",
    placement: "Place centered on the back, top of the art about 3.5 in below the collar.",
    defaultWidth: 12,
    maxWidth: 20,
    view: "back",
  },
  front: {
    label: "Front",
    folder: "front",
    stem: "front-print",
    title: "FRONT PRINT",
    placement: "Centered on the front of the garment.",
    defaultWidth: 12,
    maxWidth: 20,
    view: "front",
  },
  name: {
    label: "Name plate",
    folder: "name",
    stem: null,
    title: "NAME PLATE",
    placement: "Wearer's left chest: about 3.75 in down from the shoulder seam, centered about 4 in from center front.",
    defaultWidth: 3.75,
    maxWidth: 8,
    view: "front",
    text: true,
  },
  cuff: {
    label: "Shirt cuff",
    folder: "cuff",
    stem: "cuff-print",
    title: "SHIRT CUFF",
    placement: "Center the plate on the sleeve cuff band.",
    defaultWidth: 3,
    maxWidth: 8,
    cuff: true,
  },
};

function placeOnGarment(meta, scene, art, widthIn) {
  if (meta.view === "back") {
    const top = scene.collarBottom + 3.5 * scene.pxPerIn;
    return placePrint(scene, art.rgba, art.w, art.h, widthIn, scene.centerX, top);
  }
  if (art.id === "name") {
    const cx = scene.centerX + 4 * scene.pxPerIn;
    const top = scene.shoulderY + 3.75 * scene.pxPerIn;
    return placePrint(scene, art.rgba, art.w, art.h, widthIn, cx, top);
  }
  const top = scene.collarBottom + 2.25 * scene.pxPerIn;
  return placePrint(scene, art.rgba, art.w, art.h, widthIn, scene.centerX, top);
}

async function preparePhoto(rgba, w, h, widthIn, heightIn, lock, dpi, profile, removeComplex, report, warnings, label, pct0) {
  const printLong = Math.round(widthIn * dpi * Math.max(w, h) / Math.max(w, 1));
  const targetLong = Math.min(profile.longEdge || 3000, Math.max(Math.max(w, h), printLong));
  let working = { rgba, w, h, mode: "none" };
  if (targetLong > Math.max(w, h) * 1.05) {
    await report(pct0, `Upscaling the ${label.toLowerCase()}`);
    working = await upscaleRgba(rgba, w, h, {
      targetLong,
      tile: profile.tile || 128,
      overlap: profile.native ? 24 : 16,
      onProgress: async (frac) => {
        await report(pct0 + frac * 4, `Upscaling ${label.toLowerCase()} ${Math.round(frac * 100)}%`);
      },
    });
    if (working.warning) warnings.push(working.warning);
    else if (working.mode === "realesrgan") {
      warnings.push(`${label} was upscaled with tiled Real-ESRGAN (realesr-general-x4v3), then matted at the higher resolution.`);
    }
  }
  let matted = await makeAlpha(working.rgba, working.w, working.h);
  if (matted.needsModel && removeComplex) {
    try {
      await report(pct0 + 4, `${label}: removing a busy background`);
      const removed = await removeComplex(working.rgba, working.w, working.h);
      if (removed) matted = { rgba: removed.rgba, w: removed.w, h: removed.h, mode: "model" };
    } catch (err) {
      warnings.push(`Background model was unavailable (${err.message || err}). Used a color flood-fill instead.`);
      if (matted.mode === "complex") matted = await makeAlpha(working.rgba, working.w, working.h, { force: true });
    }
  } else if (matted.needsModel && matted.mode === "complex") {
    warnings.push(`${label} background is not a flat color, so a simple flood-fill was used. Edges may need a cleanup.`);
    matted = await makeAlpha(working.rgba, working.w, working.h, { force: true });
  }
  if (matted.warning) warnings.push(matted.warning);
  const cropped = cropToContent(matted.rgba, matted.w, matted.h, 0);
  const fitted = fitPrint(cropped, widthIn, heightIn, lock, dpi);
  if (fitted.w > cropped.w * 1.5) {
    warnings.push(`${label} is enlarged about ${(fitted.w / cropped.w).toFixed(1)}× from the source. Fine detail will be softer than a native file.`);
  }
  return fitted;
}

export async function buildPackage(font, locationsIn, settings, report) {
  const warnings = [];
  const name = (settings.name || "Stu").trim().slice(0, 32) || "Stu";
  const slug = slugName(name);
  const color = settings.garmentColor || "#111111";
  const darkGarment = relLuminance(color) < 0.35;
  const dpi = clamp(Number(settings.dpi) || DPI, 72, 600);
  let garments = Array.isArray(settings.garments) ? settings.garments.filter((g) => g && (g.kind === "sweater" || g.kind === "tee")) : [];
  if (!garments.length) {
    garments = [
      { kind: "sweater", size: "XL" },
      { kind: "tee", size: "XL" },
    ];
  }
  garments = garments.map((g) => ({ kind: g.kind, size: BODY_IN[g.size] ? g.size : "XL" }));
  const inkCount = settings.inkCount === 4 || settings.inkCount === 5 || settings.inkCount === 6 || settings.inkCount === "4" || settings.inkCount === "5" || settings.inkCount === "6"
    ? Number(settings.inkCount)
    : "auto";
  const tuned = { ...settings, name, inkCount, darkGarment, dpi };
  const profile = settings.upscaleProfile || {};
  const requested = (Array.isArray(locationsIn) ? locationsIn : []).filter((loc) => loc && LOCATIONS[loc.id]);
  if (!requested.length) throw new Error("Choose at least one print location.");

  const previews = [];
  const prepared = [];
  for (let index = 0; index < requested.length; index++) {
    const loc = requested[index];
    const meta = LOCATIONS[loc.id];
    const widthIn = clamp(Number(loc.widthIn) || meta.defaultWidth, 0.5, meta.maxWidth);
    const lock = loc.lock !== false;
    const pct0 = 4 + Math.round((index / requested.length) * 18);
    await report(pct0, `Preparing ${meta.label.toLowerCase()}`);
    let art;
    const text = (loc.text || name).trim().slice(0, 32);
    if (meta.text && !(loc.rgba && loc.w && loc.h)) {
      if (!text) throw new Error("The name plate needs a name or a photo.");
      const target = Math.round(widthIn * dpi);
      let chrome = await renderChrome(font, text, target);
      if (!lock && loc.heightIn) {
        const boxH = Math.max(16, Math.round(Number(loc.heightIn) * dpi));
        const scale = Math.min(target / chrome.w, boxH / chrome.h);
        const fw = Math.max(1, Math.round(chrome.w * scale));
        const fh = Math.max(1, Math.round(chrome.h * scale));
        chrome = { rgba: resizeRGBA(chrome.rgba, chrome.w, chrome.h, fw, fh), w: fw, h: fh };
      }
      art = { rgba: chrome.rgba, w: chrome.w, h: chrome.h, inches: [chrome.w / dpi, chrome.h / dpi] };
      art.vector = chestVector(font, text, art.inches[0]);
      art.text = text;
    } else {
      if (!(loc.rgba && loc.w && loc.h)) throw new Error(`${meta.label} needs an image.`);
      art = await preparePhoto(loc.rgba, loc.w, loc.h, widthIn, loc.heightIn, lock, dpi, profile, settings.removeComplex, report, warnings, meta.label, pct0);
      art.text = text;
    }
    art.id = loc.id;
    art.meta = meta;
    art.widthIn = widthIn;
    prepared.push(art);
    const onColor = compositeOn(art.rgba, art.w, art.h, color);
    previews.push({
      id: `${loc.id}-art`,
      group: "art",
      title: meta.label,
      bytes: await toJpeg(onColor, art.w, art.h, loc.id === "name" || loc.id === "cuff" ? 700 : 900),
    });
    art.onColor = onColor;
  }

  await report(28, "Placing prints on the garments");
  const mockups = [];
  for (const art of prepared) {
    const meta = art.meta;
    const targets = meta.cuff ? [garments[0]] : garments;
    for (const g of targets) {
      const scene = meta.cuff
        ? drawCuff(color)
        : drawGarment(g.kind, meta.view, color, BODY_IN[g.size]);
      const placed = meta.cuff
        ? placePrint(scene, art.rgba, art.w, art.h, art.widthIn, scene.centerX, scene.collarBottom)
        : placeOnGarment(meta, scene, art, art.widthIn);
      const garmentBit = meta.cuff ? "" : g.kind === "tee" ? "tee-" : "";
      const file = `mockups/${garmentBit}${meta.folder}-mockup.png`;
      const png = encodeRGB(rgbaToRgb(placed.rgba), placed.w, placed.h, 150);
      mockups.push({ file, png, rgba: placed.rgba, w: placed.w, h: placed.h, id: art.id });
      previews.push({
        id: file,
        group: "mockup",
        title: file.split("/").pop().replace(".png", "").replace(/-/g, " "),
        bytes: await toJpeg(placed.rgba, placed.w, placed.h, 700),
      });
      await yieldThread();
    }
  }

  const seps = [];
  for (let index = 0; index < prepared.length; index++) {
    const art = prepared[index];
    const meta = art.meta;
    const pct = 40 + Math.round((index / prepared.length) * 48);
    await report(pct, `Separating the ${meta.label.toLowerCase()}`);
    const filmTitle = art.id === "name" ? `${meta.title}  ·  ${(art.text || name).toUpperCase()}` : meta.title;
    const result = await buildFilms(
      art.rgba,
      art.w,
      art.h,
      art.id,
      tuned,
      art.inches[0],
      art.inches[1],
      filmTitle,
      meta.placement,
      report,
      pct,
      previews,
      dpi,
    );
    seps.push({ art, result });
  }

  await report(92, "Writing the spec sheet and PDFs");
  const outputs = [];
  for (const item of seps) {
    const { art, result } = item;
    const meta = art.meta;
    const stem = meta.stem || `${slug}-name`;
    const png = encodeRGBA(art.rgba, art.w, art.h, dpi);
    const pngPath = `${meta.folder}/${stem}.png`;
    const pdfPath = `${meta.folder}/${stem}.pdf`;
    let pdf;
    const extra = [];
    if (art.vector) {
      pdf = await buildVectorPdf(art.vector, `${art.text} name plate`, `Print package for ${name}`);
      extra.push([`${meta.folder}/${stem}.svg`, art.vector.svg, "Vector name plate (silver gradient and dark outline)"]);
    } else {
      pdf = await buildArtPdf(png, art.inches[0], art.inches[1], meta.label, `Print package for ${name}`);
    }
    outputs.push({
      art,
      result,
      stem,
      png,
      pngPath,
      pdf,
      pdfPath,
      extra,
    });
  }

  const colorName = colorLabel(color);
  const garmentLine = garments.map(garmentPhrase).join(" and ");
  const files = [];
  for (const out of outputs) {
    const { art } = out;
    files.push([out.pngPath, `${art.meta.label}, transparent PNG, ${art.w}x${art.h} px, ${dpi} DPI`]);
    files.push([out.pdfPath, `${art.meta.label} at actual size (${art.inches[0].toFixed(2)} x ${art.inches[1].toFixed(2)} in)`]);
    for (const extra of out.extra) files.push([extra[0], extra[2]]);
  }
  for (const out of outputs) {
    files.push([
      `separations/${out.art.meta.folder}-separations.pdf`,
      `Screen films for the ${out.art.meta.label.toLowerCase()}: cover + ${out.result.channels.length} inks`,
    ]);
  }
  files.push(["separations/README-SEPARATIONS.txt", "How to print the films"]);
  for (const out of outputs) {
    files.push([
      `separations/films/${out.art.meta.folder}/`,
      `1-bit films: ${out.result.channels.map((c) => c.short).join(", ")}`,
    ]);
  }
  for (const mock of mockups) files.push([mock.file, "Placement mockup, not a print file"]);
  files.push(["PRINT-SPEC.pdf", "This specification sheet"], ["README.txt", "Short file guide"]);

  const artPreviews = outputs.slice(0, 4).map((out) => {
    const tw = out.art.id === "name" || out.art.id === "cuff" ? 280 : 420;
    const th = Math.max(1, Math.round(tw * (out.art.h / out.art.w)));
    return {
      caption: out.art.meta.label,
      png: encodeRGB(rgbaToRgb(resizeRGBA(out.art.onColor, out.art.w, out.art.h, tw, th)), tw, th, 100),
    };
  });
  const firstMock = mockups[0];
  const mockPreview = firstMock
    ? encodeRGB(rgbaToRgb(resizeRGBA(firstMock.rgba, firstMock.w, firstMock.h, 220, Math.round(220 * (firstMock.h / firstMock.w)))), 220, Math.round(220 * (firstMock.h / firstMock.w)), 72)
    : null;

  const underbaseNote = darkGarment
    ? "On this dark garment, print the white underbase first (it is choked 1 pt), flash, then the other inks."
    : "The garment is light, so no white underbase is included. Proof it before a production run.";
  const placements = outputs.map((out) => ({
    title: out.art.meta.title,
    copy: `${out.art.meta.label}: ${out.art.inches[0].toFixed(2)} in wide by ${out.art.inches[1].toFixed(2)} in tall (${out.art.w} x ${out.art.h} px at ${dpi} DPI). ${out.art.meta.placement} Inks: ${out.result.channels.map((c) => c.short).join(", ")}.`,
  }));
  const included = outputs.map((out) => out.art.meta.label.toLowerCase()).join(", ");
  const spec = await buildSpecPdf({
    name,
    brand: "Print Shop Separator",
    garmentLine,
    colorName,
    dpi,
    methodShort: "DTG / DTF or screen print",
    garmentCopy: `Garments: ${garmentLine}. Base color ${colorName} (${color}). Included locations: ${included}. ${underbaseNote}`,
    methodCopy:
      "Preferred: DTG or DTF, which hold the photographic chrome and fine detail. Screen printing: film-positive separations are in separations/. Each film page is pure black and white, one ink per page, at actual size, with registration marks in the same place on every page. Color swatches and Pantone suggestions sit in the label margin only. Locations that were not selected are not in this package.",
    placements,
    files,
    notes: [
      `Transparent PNGs at ${dpi} DPI. Do not place them on a white box.`,
      "Do not re-sharpen or auto-enhance the print files.",
      "Each ink is named from the color in the art (red, green, gray, black, and so on), with the nearest Pantone suggestion in the film margin.",
      "Upscale prefers tiled Real-ESRGAN (realesr-general-x4v3) and falls back to Lanczos. The matte runs after the upscale so chrome edges lose less of their white halo.",
      "Screen films are a limited spot-color reading of the art. DTG or DTF will match a photo more closely.",
      underbaseNote,
      "Mockups are a placement guide only, not print files.",
      "A typed name plate is Kaushan Script, used under the SIL Open Font License.",
    ],
    artPreviews,
    mockPreview,
  });

  const artLines = outputs
    .map((out) => `  ${out.pngPath.padEnd(40)} ${out.art.meta.label}, ${out.art.inches[0].toFixed(2)} in wide, ${dpi} DPI`)
    .join("\n");
  const sepLines = outputs
    .map((out) => `  ${`${out.art.meta.folder}-separations.pdf`.padEnd(36)} ${out.art.meta.label.toLowerCase()}, ${out.art.inches[0].toFixed(2)} in wide, ${out.result.channels.length} inks + cover`)
    .join("\n");
  const inkLines = outputs
    .map((out) => `${out.art.meta.label} inks, in print order: ${out.result.channels.map((c) => c.short).join(", ")}.`)
    .join("\n");
  const readme =
    `${name} — print-ready package\n` +
    `${"=".repeat(Math.min(48, name.length + 24))}\n\n` +
    `Garments: ${garmentLine}. Color: ${colorName} (${color}).\n` +
    `Locations in this package: ${included}.\n` +
    `Method:   DTG or DTF preferred for photographic art.\n` +
    `          Screen-print films are in separations/ if the shop screens it.\n\n` +
    `Start with PRINT-SPEC.pdf for sizes, placement, and production notes.\n` +
    `For screen printing, also read separations/README-SEPARATIONS.txt.\n\n` +
    `Artwork:\n${artLines}\n\n` +
    `Separations:\n${sepLines}\n\n` +
    `A typed name plate uses Kaushan Script (SIL Open Font License).\n` +
    `Photos are enlarged with tiled Real-ESRGAN when it loads, otherwise Lanczos.\n\n` +
    `Give the print shop the PNG files (and PDFs if they prefer). Mockups are a\n` +
    `visual placement guide only, not print files.\n`;

  const sepReadme =
    `SCREEN-PRINT COLOR SEPARATIONS\n` +
    `==============================\n\n` +
    `One PDF per print location that was included. Page 1 of each is a color\n` +
    `composite preview and the ink list (not a film). Every following page is\n` +
    `a film positive: BLACK = that ink prints, WHITE = no ink. The artwork\n` +
    `itself is pure black and white. The ink name, a color swatch, a Pantone\n` +
    `suggestion, the print order, and the screen (LPI / angle) are in the\n` +
    `label margin only. Each plate is named for the color it actually prints.\n\n` +
    `${sepLines}\n\n` +
    `${inkLines}\n\n` +
    (darkGarment
      ? `Print on a dark garment (${colorName}). Print in the numbered order.\n` +
        `Flash the white underbase before the other screens.\n` +
        `The underbase is choked 1 point (0.014 in) so top colors trap over it\n` +
        `and no white edge flashes out. Do not scale the films.\n`
      : `The garment color is light (${colorName}), so these films have no white underbase.\n` +
        `Print in the numbered order. Do not scale the films.\n`) +
    `Registration marks are in the same position on every page.\n\n` +
    `Tonal areas are clustered-dot halftones at about 50 LPI with offset\n` +
    `screen angles. 1-bit 600 DPI PNGs of each film are in films/<location>/.\n` +
    `This is a limited spot-color interpretation of photographic art; DTG/DTF\n` +
    `will match the original more closely.\n`;

  await report(96, "Packing the ZIP");
  const zip = new JSZip();
  const add = (path, data) => zip.file(path, data);
  add("README.txt", readme);
  add("PRINT-SPEC.pdf", spec);
  for (const out of outputs) {
    add(out.pngPath, out.png);
    add(out.pdfPath, out.pdf);
    for (const extra of out.extra) add(extra[0], extra[1]);
    add(`separations/${out.art.meta.folder}-separations.pdf`, out.result.pdf);
    for (const film of out.result.pngs) add(`separations/films/${out.art.meta.folder}/${film.name}`, film.png);
  }
  for (const mock of mockups) add(mock.file, mock.png);
  add("separations/README-SEPARATIONS.txt", sepReadme);

  const zipBytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await report(100, "Ready");
  const summaryLocations = outputs.map((out) => ({
    id: out.art.id,
    label: out.art.meta.label,
    inks: out.result.channels.map((c) => c.name),
    inches: out.art.inches,
  }));
  return {
    zipBytes,
    zipName: `${slug}-print-files.zip`,
    previews,
    summary: {
      name,
      slug,
      files: Object.keys(zip.files).filter((p) => !p.endsWith("/")),
      locations: summaryLocations,
      warnings,
      darkGarment,
    },
  };
}
