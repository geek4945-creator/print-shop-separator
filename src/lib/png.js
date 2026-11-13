import { zlibSync } from "fflate";

const SIG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = new Uint8Array(4 + data.length);
  body.set(new TextEncoder().encode(type), 0);
  body.set(data, 4);
  const crc = crc32(body);
  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc);
  return out;
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function ihdr(w, h, bitDepth, colorType) {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  data[8] = bitDepth;
  data[9] = colorType;
  return chunk("IHDR", data);
}

function phys(dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  view.setUint32(0, ppm);
  view.setUint32(4, ppm);
  data[8] = 1;
  return chunk("pHYs", data);
}

function textChunk(key, value) {
  const kb = new TextEncoder().encode(key);
  const vb = new TextEncoder().encode(value);
  const data = new Uint8Array(kb.length + 1 + vb.length);
  data.set(kb, 0);
  data[kb.length] = 0;
  data.set(vb, kb.length + 1);
  return chunk("tEXt", data);
}

function encodeFiltered(raw, level) {
  return chunk("IDAT", zlibSync(raw, { level }));
}

/**
 * Inject or replace a pHYs DPI chunk. Works on PNG bytes from canvas or our encoder.
 */
export function setPngDpi(bytes, dpi) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const parts = [SIG];
  let offset = 8;
  let inserted = false;
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  while (offset + 8 <= src.length) {
    const len = view.getUint32(offset);
    const type = String.fromCharCode(
      src[offset + 4],
      src[offset + 5],
      src[offset + 6],
      src[offset + 7],
    );
    const end = offset + 12 + len;
    if (type === "pHYs") {
      offset = end;
      continue;
    }
    parts.push(src.subarray(offset, end));
    if (type === "IHDR" && !inserted) {
      parts.push(phys(dpi));
      parts.push(textChunk("Software", "Print Shop Separator"));
      inserted = true;
    }
    if (type === "IEND") break;
    offset = end;
  }
  return concat(parts);
}

/** 8-bit straight RGBA PNG. */
export function encodeRGBA(rgba, w, h, dpi = 300) {
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 1; // Sub
    const src = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[src + x - 4] : 0;
      raw[rowStart + 1 + x] = (rgba[src + x] - left) & 255;
    }
  }
  return concat([
    SIG,
    ihdr(w, h, 8, 6),
    phys(dpi),
    textChunk("Software", "Print Shop Separator"),
    textChunk("Comment", `${dpi} DPI print-ready PNG`),
    encodeFiltered(raw, 4),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * 1-bit grayscale PNG. `bits` is MSB-first, 1 = white, 0 = black,
 * row stride `ceil(width/8)`.
 */
export function encodeGray1(bits, w, h, dpi = 600) {
  const rowBytes = Math.ceil(w / 8);
  const raw = new Uint8Array((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (rowBytes + 1);
    raw[o] = 0;
    raw.set(bits.subarray(y * rowBytes, y * rowBytes + rowBytes), o + 1);
  }
  return concat([
    SIG,
    ihdr(w, h, 1, 0),
    phys(dpi),
    textChunk("Software", "Print Shop Separator"),
    textChunk("Comment", `${dpi} DPI 1-bit film positive`),
    encodeFiltered(raw, 4),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** 8-bit RGB PNG (no alpha), for the separation cover composite. */
export function encodeRGB(rgb, w, h, dpi = 150) {
  const stride = w * 3;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 1;
    const src = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? rgb[src + x - 3] : 0;
      raw[rowStart + 1 + x] = (rgb[src + x] - left) & 255;
    }
  }
  return concat([
    SIG,
    ihdr(w, h, 8, 2),
    phys(dpi),
    encodeFiltered(raw, 4),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
