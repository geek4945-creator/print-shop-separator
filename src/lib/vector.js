/** Vector chest logo: SVG outlines plus geometry for a matching PDF. */

function xmlEscape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

export function chestVector(font, text, widthIn) {
  const upem = font.unitsPerEm || 1000;
  const path = font.getPath(text, 0, 0, upem);
  const bb = path.getBoundingBox();
  const pad = 0.06 * upem;
  const extrX = 0.045 * upem;
  const extrY = 0.07 * upem;
  const stroke = 0.034 * upem;
  const minX = bb.x1 - pad - stroke;
  const minY = bb.y1 - pad - stroke;
  const maxX = bb.x2 + pad + stroke + extrX;
  const maxY = bb.y2 + pad + stroke + extrY;
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const heightIn = (contentH * widthIn) / contentW;
  const vbW = widthIn * 72;
  const vbH = heightIn * 72;
  const s = vbW / contentW;
  const d = path.toPathData(2);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${widthIn.toFixed(4)}in" height="${heightIn.toFixed(4)}in" viewBox="0 0 ${vbW.toFixed(3)} ${vbH.toFixed(3)}">
  <title>${xmlEscape(text)} — left-chest logo (vector)</title>
  <desc>Chrome-style script name for a left-chest print. Print at ${widthIn} in wide. Lettering set in Kaushan Script (OFL).</desc>
  <defs>
    <linearGradient id="silver" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#F3F3F6"/>
      <stop offset="22%" stop-color="#D0D0D6"/>
      <stop offset="48%" stop-color="#8A8A92"/>
      <stop offset="70%" stop-color="#3A3A40"/>
      <stop offset="100%" stop-color="#C8C8CE"/>
    </linearGradient>
  </defs>
  <g transform="translate(${(-minX * s).toFixed(3)} ${(-minY * s).toFixed(3)}) scale(${s.toFixed(6)})">
    <path d="${d}" transform="translate(${extrX.toFixed(2)} ${extrY.toFixed(2)})" fill="#2A2A2E"/>
    <path d="${d}" fill="url(#silver)" stroke="#141416" stroke-width="${stroke.toFixed(2)}" stroke-linejoin="round" stroke-linecap="round"/>
  </g>
</svg>
`;
  return { svg, heightIn, d, minX, minY, s, extrX, extrY, stroke, vbW, vbH, widthIn };
}
