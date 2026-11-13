import {
  LineCapStyle,
  LineJoinStyle,
  PDFDocument,
  StandardFonts,
  degrees,
  drawImage as drawImageOps,
  rgb,
  setLineCap,
  setLineJoin,
} from "pdf-lib";
import { CHOKE_IN, CHOKE_PT, LPI } from "./separate.js";

const IN = 72;

export function pageGeometry(artWIn, artHIn) {
  const header0 = 1.65 * IN;
  const footer = 1.2 * IN;
  const sideMin = 1.05 * IN;
  const artW = artWIn * IN;
  const artH = artHIn * IN;
  const pageW = Math.max(artW + 2 * sideMin, 11 * IN);
  const pageH = Math.max(artH + header0 + footer, 8.5 * IN);
  const artX = (pageW - artW) / 2;
  const artY = footer;
  return {
    pageW,
    pageH,
    artX,
    artY,
    artW,
    artH,
    footer,
    header: pageH - artH - footer,
  };
}

function ascii(s) {
  return String(s ?? "").replace(/[^\x20-\x7E]/g, "");
}

function wrap(font, text, size, maxW) {
  const words = ascii(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const word of words) {
    const trial = cur ? `${cur} ${word}` : word;
    if (font.widthOfTextAtSize(trial, size) <= maxW) cur = trial;
    else {
      if (cur) lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

async function fonts(doc) {
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { regular, bold };
}

export async function buildArtPdf(pngBytes, widthIn, heightIn, title, author) {
  const doc = await PDFDocument.create();
  doc.setTitle(ascii(title));
  doc.setAuthor(ascii(author));
  const page = doc.addPage([widthIn * IN, heightIn * IN]);
  const img = await doc.embedPng(pngBytes);
  page.drawImage(img, { x: 0, y: 0, width: widthIn * IN, height: heightIn * IN });
  return doc.save();
}

export async function buildVectorPdf(vector, title, author) {
  const doc = await PDFDocument.create();
  doc.setTitle(ascii(title));
  doc.setAuthor(ascii(author));
  const page = doc.addPage([vector.vbW, vector.vbH]);
  page.pushOperators(setLineJoin(LineJoinStyle.Round), setLineCap(LineCapStyle.Round));
  const s = vector.s;
  const place = (dx, dy, color, border) => {
    page.drawSvgPath(vector.d, {
      x: (-vector.minX + dx) * s,
      y: vector.vbH + (vector.minY - dy) * s,
      scale: s,
      color,
      borderColor: border,
      borderWidth: border ? vector.stroke : 0,
      borderLineCap: LineCapStyle.Round,
    });
  };
  place(vector.extrX, vector.extrY, rgb(0.165, 0.165, 0.18));
  place(0, 0, rgb(0.77, 0.77, 0.79), rgb(0.078, 0.078, 0.086));
  return doc.save();
}

function drawRegMarks(page, g) {
  const { artX: ax, artY: ay, artW: aw, artH: ah } = g;
  const mark = 0.22 * IN;
  const gap = 0.06 * IN;
  const corners = [
    [ax, ay + ah, -1, 1],
    [ax + aw, ay + ah, 1, 1],
    [ax, ay, -1, -1],
    [ax + aw, ay, 1, -1],
  ];
  for (const [x, y, sx, sy] of corners) {
    page.drawLine({
      start: { x: x - sx * gap, y },
      end: { x: x - sx * (gap + mark), y },
      thickness: 0.4,
      color: rgb(0, 0, 0),
    });
    page.drawLine({
      start: { x, y: y + sy * gap },
      end: { x, y: y + sy * (gap + mark) },
      thickness: 0.4,
      color: rgb(0, 0, 0),
    });
  }
  const off = 0.42 * IN;
  const targets = [
    [ax - off * 0.15, ay + ah + off],
    [ax + aw + off * 0.15, ay + ah + off],
    [ax - off * 0.15, ay - off * 0.55],
    [ax + aw + off * 0.15, ay - off * 0.55],
    [ax + aw / 2, ay + ah + off],
    [ax + aw / 2, ay - off * 0.55],
    [ax - off * 0.55, ay + ah / 2],
    [ax + aw + off * 0.55, ay + ah / 2],
  ];
  const r = 0.09 * IN;
  for (const [x, y] of targets) {
    page.drawCircle({ x, y, size: r, borderWidth: 0.5, borderColor: rgb(0, 0, 0) });
    page.drawCircle({ x, y, size: 0.015 * IN, color: rgb(0, 0, 0) });
    page.drawLine({
      start: { x: x - r - 0.05 * IN, y },
      end: { x: x + r + 0.05 * IN, y },
      thickness: 0.5,
      color: rgb(0, 0, 0),
    });
    page.drawLine({
      start: { x, y: y - r - 0.05 * IN },
      end: { x, y: y + r + 0.05 * IN },
      thickness: 0.5,
      color: rgb(0, 0, 0),
    });
  }
  page.drawRectangle({
    x: ax - 0.5,
    y: ay - 0.5,
    width: aw + 1,
    height: ah + 1,
    borderWidth: 0.25,
    borderColor: rgb(0, 0, 0),
    borderDashArray: [1, 2],
  });
}

function swatch(page, x, y, w, h, ink) {
  const [r, g, b] = ink.rgb.map((v) => v / 255);
  page.drawRectangle({
    x,
    y,
    width: w,
    height: h,
    color: rgb(r, g, b),
    borderColor: rgb(0, 0, 0),
    borderWidth: 0.7,
  });
  if (ink.hex.toUpperCase() === "#FFFFFF") {
    page.drawLine({ start: { x, y }, end: { x: x + w, y: y + h }, thickness: 0.6, color: rgb(0.5, 0.5, 0.5) });
    page.drawLine({ start: { x, y: y + h }, end: { x: x + w, y }, thickness: 0.6, color: rgb(0.5, 0.5, 0.5) });
  }
}

function embedFilm(doc, page, bits, filmW, filmH, x, y, w, h) {
  const stream = doc.context.flateStream(bits, {
    Type: "XObject",
    Subtype: "Image",
    Width: filmW,
    Height: filmH,
    ColorSpace: "DeviceGray",
    BitsPerComponent: 1,
  });
  const ref = doc.context.register(stream);
  const key = page.node.newXObject("Film", ref);
  page.pushOperators(
    ...drawImageOps(key, {
      x,
      y,
      width: w,
      height: h,
      rotate: degrees(0),
      xSkew: degrees(0),
      ySkew: degrees(0),
    }),
  );
}

export async function buildSeparationPdf({
  location,
  placement,
  artWIn,
  artHIn,
  channels,
  films,
  simPng,
  simW,
  simH,
}) {
  const doc = await PDFDocument.create();
  doc.setTitle(ascii(`Screen separations - ${location}`));
  doc.setAuthor("Print Shop Separator");
  const { regular, bold } = await fonts(doc);
  const g = pageGeometry(artWIn, artHIn);
  const pages = 1 + channels.length;
  const nInks = channels.length;
  const sim = await doc.embedPng(simPng);

  const cover = doc.addPage([g.pageW, g.pageH]);
  drawRegMarks(cover, g);
  cover.drawText(ascii(location.toUpperCase()), {
    x: 0.45 * IN,
    y: g.pageH - 0.38 * IN,
    size: 10,
    font: bold,
  });
  cover.drawText("FILM POSITIVE   -   ACTUAL SIZE   -   DO NOT SCALE", {
    x: g.pageW - 0.45 * IN - regular.widthOfTextAtSize("FILM POSITIVE   -   ACTUAL SIZE   -   DO NOT SCALE", 8),
    y: g.pageH - 0.36 * IN,
    size: 8,
    font: regular,
  });
  cover.drawText("COMPOSITE PREVIEW + INK LIST  (not a film)", {
    x: 0.45 * IN,
    y: g.pageH - 0.62 * IN,
    size: 13,
    font: bold,
  });
  cover.drawRectangle({
    x: g.artX,
    y: g.artY,
    width: g.artW,
    height: g.artH,
    color: rgb(0, 0, 0),
  });
  cover.drawImage(sim, { x: g.artX, y: g.artY, width: g.artW, height: g.artH });

  let legendX = 0.45 * IN;
  let legendY = g.pageH - 0.95 * IN;
  cover.drawText("PRINT ORDER (on black garment):", {
    x: legendX,
    y: legendY + 0.22 * IN,
    size: 8,
    font: bold,
  });
  for (const ink of channels) {
    const itemW = 1.7 * IN;
    if (legendX + itemW > g.pageW - 0.4 * IN) {
      legendX = 0.45 * IN;
      legendY -= 0.28 * IN;
    }
    swatch(cover, legendX, legendY, 0.22 * IN, 0.14 * IN, ink);
    cover.drawText(`${ink.order}. ${ascii(ink.short)}`, {
      x: legendX + 0.28 * IN,
      y: legendY + 0.03 * IN,
      size: 7.5,
      font: regular,
    });
    legendX += itemW;
  }
  const note1 = `Underbase choke: ${CHOKE_PT} pt (${CHOKE_IN.toFixed(3)} in) - flash white first; top colors trap over it. Halftones: ${LPI} LPI clustered-dot, unique angles. ${placement}`;
  const note2 = "Film pages: artwork is BLACK only (black = this ink prints, white = no ink). Color swatches appear only in the label margin.";
  let ny = 0.7 * IN;
  for (const line of [...wrap(regular, note1, 7, g.pageW - 0.9 * IN), ...wrap(regular, note2, 7, g.pageW - 0.9 * IN)]) {
    cover.drawText(line, { x: 0.45 * IN, y: ny, size: 7, font: regular });
    ny -= 0.12 * IN;
  }
  cover.drawText(`Page 1 of ${pages}`, {
    x: g.pageW - 0.45 * IN - regular.widthOfTextAtSize(`Page 1 of ${pages}`, 7.5),
    y: 0.28 * IN,
    size: 7.5,
    font: regular,
  });
  cover.drawText(`Live art: ${artWIn.toFixed(2)} x ${artHIn.toFixed(2)} in   -   Registration marks align on every page`, {
    x: 0.45 * IN,
    y: 0.28 * IN,
    size: 7.5,
    font: regular,
  });

  channels.forEach((ink, index) => {
    const page = doc.addPage([g.pageW, g.pageH]);
    drawRegMarks(page, g);
    page.drawText(ascii(location.toUpperCase()), {
      x: 0.45 * IN,
      y: g.pageH - 0.34 * IN,
      size: 10,
      font: bold,
    });
    const right = "FILM POSITIVE   -   ACTUAL SIZE   -   DO NOT SCALE";
    page.drawText(right, {
      x: g.pageW - 0.45 * IN - regular.widthOfTextAtSize(right, 8),
      y: g.pageH - 0.32 * IN,
      size: 8,
      font: regular,
    });
    page.drawText(ascii(ink.name), {
      x: 0.45 * IN,
      y: g.pageH - 0.58 * IN,
      size: 14,
      font: bold,
    });
    const sw = 0.48 * IN;
    const sh = 0.3 * IN;
    const sx = g.pageW - 0.45 * IN - sw;
    const sy = g.pageH - 0.66 * IN;
    swatch(page, sx, sy, sw, sh, ink);
    const pantone = ascii(ink.pantone);
    page.drawText(pantone, {
      x: sx - 0.1 * IN - regular.widthOfTextAtSize(pantone, 8),
      y: g.pageH - 0.5 * IN,
      size: 8,
      font: regular,
    });
    const screen = ink.lpi
      ? `${ink.lpi} LPI   -   ${ink.angle} deg screen`
      : "tonal / solid hold (50 LPI @ 45 deg where not solid)";
    const bits = `Print order: ${ink.order} of ${nInks}   -   ${screen}   -   ${ink.notes}`;
    let ty = g.pageH - 0.78 * IN;
    for (const line of wrap(regular, bits, 8, sx - 0.7 * IN)) {
      page.drawText(line, { x: 0.45 * IN, y: ty, size: 8, font: regular });
      ty -= 0.13 * IN;
    }
    page.drawRectangle({
      x: g.artX,
      y: g.artY,
      width: g.artW,
      height: g.artH,
      color: rgb(1, 1, 1),
    });
    const film = films[ink.key];
    embedFilm(doc, page, film.bits, film.w, film.h, g.artX, g.artY, g.artW, g.artH);

    const wedgeX = g.pageW - 0.38 * IN;
    page.drawText("STEP", {
      x: wedgeX - regular.widthOfTextAtSize("STEP", 5) / 2,
      y: g.artY + g.artH + 0.06 * IN,
      size: 5,
      font: regular,
    });
    [100, 75, 50, 25, 10].forEach((pct, k) => {
      const yy = g.artY + g.artH - (k + 1) * 0.32 * IN;
      const box = 0.22 * IN;
      const bx = wedgeX - box / 2;
      if (pct === 100) {
        page.drawRectangle({ x: bx, y: yy, width: box, height: box, color: rgb(0, 0, 0) });
      } else {
        page.drawRectangle({
          x: bx,
          y: yy,
          width: box,
          height: box,
          borderColor: rgb(0, 0, 0),
          borderWidth: 0.4,
        });
        const step = 1.2 + (100 - pct) / 40;
        for (let xh = bx; xh < bx + box; xh += step) {
          page.drawLine({
            start: { x: xh, y: yy },
            end: { x: xh, y: yy + box },
            thickness: 0.3,
            color: rgb(0, 0, 0),
          });
        }
      }
      const label = `${pct}%`;
      page.drawText(label, {
        x: wedgeX - regular.widthOfTextAtSize(label, 5) / 2,
        y: yy - 0.09 * IN,
        size: 5,
        font: regular,
      });
    });

    const label = `Page ${index + 2} of ${pages}`;
    page.drawText(label, {
      x: g.pageW - 0.45 * IN - regular.widthOfTextAtSize(label, 7.5),
      y: 0.28 * IN,
      size: 7.5,
      font: regular,
    });
    page.drawText(`Live art: ${artWIn.toFixed(2)} x ${artHIn.toFixed(2)} in   -   Registration marks align on every page`, {
      x: 0.45 * IN,
      y: 0.28 * IN,
      size: 7.5,
      font: regular,
    });
  });

  void simW;
  void simH;
  return doc.save();
}

export async function buildSpecPdf(info) {
  const doc = await PDFDocument.create();
  doc.setTitle(ascii(`Print Shop Spec - ${info.name}`));
  doc.setAuthor("Print Shop Separator");
  const page = doc.addPage([612, 792]);
  const { regular, bold } = await fonts(doc);
  const W = 612;
  const H = 792;
  const teal = rgb(46 / 255, 138 / 255, 134 / 255);
  const tealDark = rgb(27 / 255, 79 / 255, 76 / 255);
  const charcoal = rgb(0.13, 0.13, 0.15);
  page.drawRectangle({ x: 0, y: H - 64, width: W, height: 64, color: tealDark });
  page.drawRectangle({ x: 0, y: H - 68, width: W, height: 4, color: teal });
  page.drawText("PRINT SHOP SPECIFICATIONS", {
    x: 36,
    y: H - 30,
    size: 16,
    font: bold,
    color: rgb(1, 1, 1),
  });
  page.drawText(ascii(`${info.brand}  -  ${info.garmentLine}`), {
    x: 36,
    y: H - 48,
    size: 9,
    font: regular,
    color: rgb(1, 1, 1),
  });
  page.drawText(ascii(`For: ${info.name}`), {
    x: W - 36 - regular.widthOfTextAtSize(ascii(`For: ${info.name}`), 8),
    y: H - 28,
    size: 8,
    font: regular,
    color: rgb(1, 1, 1),
  });
  page.drawText("300 DPI transparent art", {
    x: W - 36 - regular.widthOfTextAtSize("300 DPI transparent art", 8),
    y: H - 44,
    size: 8,
    font: regular,
    color: rgb(1, 1, 1),
  });

  let y = H - 88;
  const heading = (text) => {
    page.drawText(text, { x: 36, y, size: 10, font: bold, color: tealDark });
    y -= 4;
    page.drawLine({ start: { x: 36, y }, end: { x: W - 36, y }, thickness: 1, color: teal });
    y -= 14;
  };
  const body = (text, x, width, size = 8) => {
    for (const line of wrap(regular, text, size, width)) {
      page.drawText(line, { x, y, size, font: regular, color: charcoal });
      y -= size + 2.5;
    }
  };

  heading("GARMENTS");
  body(info.garmentCopy, 36, 540);
  y -= 4;
  heading("RECOMMENDED PRINT METHOD");
  body(info.methodCopy, 36, 540);
  y -= 4;
  heading("ARTWORK, SIZE & PLACEMENT");
  const yStart = y;
  page.drawText("BACK PRINT", { x: 36, y, size: 8.5, font: bold, color: tealDark });
  page.drawText("LEFT CHEST", { x: 310, y, size: 8.5, font: bold, color: tealDark });
  y -= 12;
  const leftY = y;
  body(info.backCopy, 36, 260, 7.5);
  const afterLeft = y;
  y = leftY;
  body(info.chestCopy, 310, 250, 7.5);
  y = Math.min(afterLeft, y) - 6;
  void yStart;

  heading("PREVIEWS  (placement guide, not to scale)");
  const backImg = await doc.embedPng(info.backPreview);
  const chestImg = await doc.embedPng(info.chestPreview);
  const bh = 74;
  const bw = bh * (backImg.width / backImg.height);
  page.drawRectangle({ x: 36, y: y - bh - 4, width: bw + 8, height: bh + 8, color: rgb(0, 0, 0) });
  page.drawImage(backImg, { x: 40, y: y - bh, width: bw, height: bh });
  const ch = 70;
  const cw = Math.min(150, ch * (chestImg.width / chestImg.height));
  const ch2 = cw * (chestImg.height / chestImg.width);
  page.drawRectangle({ x: 36 + bw + 24, y: y - ch2 - 4, width: cw + 8, height: ch2 + 8, color: rgb(0, 0, 0) });
  page.drawImage(chestImg, { x: 40 + bw + 24, y: y - ch2, width: cw, height: ch2 });
  if (info.mockPreview) {
    const mock = await doc.embedPng(info.mockPreview);
    const mh = 100;
    const mw = mh * (mock.width / mock.height);
    page.drawImage(mock, { x: W - 36 - mw, y: y - mh, width: mw, height: mh });
  }
  y -= 96;
  page.drawText("Back and left-chest previews on the chosen garment color.", {
    x: 36,
    y,
    size: 7,
    font: regular,
    color: charcoal,
  });
  y -= 16;

  heading("FILE LIST");
  for (const [name, desc] of info.files) {
    if (y < 118) break;
    page.drawText(ascii(name), { x: 36, y, size: 6.5, font: bold, color: charcoal });
    page.drawText(ascii(desc), { x: 248, y, size: 6.5, font: regular, color: charcoal });
    y -= 8.4;
  }
  y -= 6;
  if (y > 78) {
    heading("PRODUCTION NOTES");
    for (const note of info.notes) {
      if (y < 40) break;
      for (const line of wrap(regular, note, 7, 530)) {
        if (y < 40) break;
        page.drawText(line, { x: 36, y, size: 7, font: regular, color: charcoal });
        y -= 9;
      }
    }
  }
  page.drawRectangle({ x: 0, y: 0, width: W, height: 26, color: tealDark });
  page.drawText(ascii(`${info.brand}  -  ${info.methodShort}  -  ${info.colorName} garments`), {
    x: 36,
    y: 10,
    size: 7,
    font: regular,
    color: rgb(1, 1, 1),
  });
  page.drawText("Print-ready package", {
    x: W - 36 - regular.widthOfTextAtSize("Print-ready package", 7),
    y: 10,
    size: 7,
    font: regular,
    color: rgb(1, 1, 1),
  });
  return doc.save();
}
