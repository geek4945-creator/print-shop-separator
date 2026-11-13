import fontUrl from "./assets/KaushanScript-Regular.ttf?url";
import { captureNativePhoto } from "./lib/native.js";
import { loadStore, saveStore, mountSizeRow, DPI_CHOICES } from "./lib/export-size.js";
import { encodeRGBA } from "./lib/png.js";
import { buildArtPdf } from "./lib/pdf.js";
import { renderChrome } from "./lib/chrome.js";
import opentype from "opentype.js";

const TOOLS = [
  ["bg", "Background"],
  ["crop", "Crop"],
  ["resize", "Resize"],
  ["adjust", "Adjust"],
  ["colors", "Colors"],
  ["trace", "Trace"],
  ["text", "Text"],
  ["trim", "Trim"],
];

const RATIOS = [
  ["free", "Free"],
  ["1", "1:1"],
  ["0.8", "4:5"],
  ["1.5", "3:2"],
  ["1.778", "16:9"],
];

export function initTools({ getPrintFile, usePrintFile }) {
  const view = document.querySelector("#view-tools");
  const work = document.querySelector("#tools-work");
  const canvas = document.querySelector("#tool-canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const zoom = document.querySelector("#zoom");
  const inner = document.querySelector("#zoom-inner");
  const cropBox = document.querySelector("#crop-box");
  const controls = document.querySelector("#tool-controls");
  const status = document.querySelector("#tools-status");
  const chips = document.querySelector("#tool-chips");
  let tool = "bg";
  let image = null;
  let original = null;
  let undo = [];
  let redo = [];
  let busy = false;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let fontPromise = null;
  const pointers = new Map();
  let pinch = null;
  let crop = { x: 0, y: 0, w: 10, h: 10, drag: null };
  let textPos = { x: 40, y: 80 };
  let draggingText = false;
  let showTextGhost = true;

  const worker = new Worker(new URL("./tools-worker.js", import.meta.url), { type: "module" });
  let seq = 0;
  const pending = new Map();
  worker.onmessage = (event) => {
    const msg = event.data;
    const job = pending.get(msg.id);
    if (!job) return;
    pending.delete(msg.id);
    if (!msg.ok) job.reject(new Error(msg.message || "Tool failed"));
    else job.resolve(msg);
  };

  function job(op, pixels, w, h, params) {
    const id = ++seq;
    const copy = new Uint8Array(pixels);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, op, w, h, pixels: copy, params }, [copy.buffer]);
    });
  }

  function setStatus(text) {
    status.textContent = text || "";
  }

  function paint() {
    if (!image) return;
    canvas.width = image.w;
    canvas.height = image.h;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.w, image.h), 0, 0);
    if (tool === "text") drawTextPreview();
    layoutCrop();
    applyTransform();
  }

  function applyTransform() {
    inner.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  function fit() {
    if (!image) return;
    const rect = zoom.getBoundingClientRect();
    const s = Math.min((rect.width - 16) / image.w, (rect.height - 16) / image.h);
    scale = Number.isFinite(s) && s > 0 ? s : 1;
    tx = (rect.width - image.w * scale) / 2;
    ty = (rect.height - image.h * scale) / 2;
    applyTransform();
  }

  function replace(rgba, w, h) {
    if (image) {
      undo.push({ rgba: image.rgba.slice(), w: image.w, h: image.h });
      if (undo.length > 6) undo.shift();
      redo = [];
    }
    image = { rgba: new Uint8ClampedArray(rgba), w, h };
    paint();
    fit();
    toolsRow.refresh();
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    document.querySelector("#undo").disabled = !undo.length || busy;
    document.querySelector("#redo").disabled = !redo.length || busy;
  }

  async function run(op, params, label) {
    if (!image || busy) return null;
    busy = true;
    updateHistoryButtons();
    setStatus(label || "Working…");
    try {
      const msg = await job(op, image.rgba, image.w, image.h, params);
      if (msg.pixels) replace(msg.pixels, msg.w, msg.h);
      setStatus(msg.extra && msg.extra.warning ? msg.extra.warning : "Done.");
      return msg;
    } catch (err) {
      setStatus(err.message || String(err));
      return null;
    } finally {
      busy = false;
      updateHistoryButtons();
    }
  }

  function imagePoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function stampBrush(x, y, erase) {
    const size = Number(document.querySelector("#brush-size")?.value || 24);
    const r = size / 2;
    const x0 = Math.max(0, Math.floor(x - r));
    const y0 = Math.max(0, Math.floor(y - r));
    const x1 = Math.min(image.w, Math.ceil(x + r));
    const y1 = Math.min(image.h, Math.ceil(y + r));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const dx = xx - x;
        const dy = yy - y;
        if (dx * dx + dy * dy > r * r) continue;
        const i = (yy * image.w + xx) * 4;
        if (erase) image.rgba[i + 3] = 0;
        else if (original) {
          const oi = i;
          if (original.w === image.w && original.h === image.h) {
          image.rgba.set(original.rgba.subarray(i, i + 4), i);
        }
        }
      }
    }
  }

  let brushDirty = false;
  let brushUndoPushed = false;
  function onPointerDown(event) {
    zoom.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale, tx, ty, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      return;
    }
    if (tool === "bg" && document.querySelector("#tap-mode")?.checked) {
      const p = imagePoint(event);
      run("flood", { x: p.x, y: p.y, tolerance: Number(document.querySelector("#tap-tol").value) }, "Removing that color…");
      return;
    }
    if (tool === "bg" && document.querySelector("#brush-on")?.checked) {
      if (!brushUndoPushed && image) {
        undo.push({ rgba: image.rgba.slice(), w: image.w, h: image.h });
        if (undo.length > 6) undo.shift();
        redo = [];
        brushUndoPushed = true;
      }
      const p = imagePoint(event);
      stampBrush(p.x, p.y, document.querySelector("#brush-mode").value === "erase");
      brushDirty = true;
      paint();
      return;
    }
    if (tool === "text") {
      textPos = imagePoint(event);
      draggingText = true;
      showTextGhost = true;
      paint();
    }
  }
  function onPointerMove(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const next = clampScale(pinch.scale * (dist / pinch.dist));
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      scale = next;
      tx = pinch.tx + (mx - pinch.mx);
      ty = pinch.ty + (my - pinch.my);
      applyTransform();
      return;
    }
    if (tool === "colors" && document.querySelector("#eyedrop")?.checked) {
      const p = imagePoint(event);
      const i = (Math.round(p.y) * image.w + Math.round(p.x)) * 4;
      if (i >= 0 && i < image.rgba.length) showSwatch(image.rgba[i], image.rgba[i + 1], image.rgba[i + 2], "#picked");
    }
    if (brushDirty || (tool === "bg" && document.querySelector("#brush-on")?.checked && pointers.size === 1)) {
      const p = imagePoint(event);
      stampBrush(p.x, p.y, document.querySelector("#brush-mode").value === "erase");
      brushDirty = true;
      paint();
    }
    if (draggingText) {
      textPos = imagePoint(event);
      paint();
    }
  }
  function onPointerUp(event) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (brushDirty && pointers.size === 0) {
      brushDirty = false;
      brushUndoPushed = false;
      updateHistoryButtons();
      setStatus("Brush stroke applied. Undo is available.");
    }
    draggingText = false;
  }
  zoom.addEventListener("pointerdown", onPointerDown);
  zoom.addEventListener("pointermove", onPointerMove);
  zoom.addEventListener("pointerup", onPointerUp);
  zoom.addEventListener("pointercancel", onPointerUp);

  function clampScale(v) {
    return Math.min(8, Math.max(0.2, v));
  }

  function layoutCrop() {
    if (tool !== "crop" || !image) {
      cropBox.hidden = true;
      return;
    }
    cropBox.hidden = false;
    cropBox.style.left = `${crop.x}px`;
    cropBox.style.top = `${crop.y}px`;
    cropBox.style.width = `${crop.w}px`;
    cropBox.style.height = `${crop.h}px`;
  }

  function resetCrop() {
    if (!image) return;
    const ratio = Number(document.querySelector("#crop-ratio")?.value || 0);
    let w = image.w * 0.86;
    let h = image.h * 0.86;
    if (ratio) {
      h = w / ratio;
      if (h > image.h * 0.9) {
        h = image.h * 0.9;
        w = h * ratio;
      }
    }
    crop = { x: (image.w - w) / 2, y: (image.h - h) / 2, w, h };
    layoutCrop();
  }

  cropBox.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    const p = imagePoint(event);
    crop.drag = { x: p.x - crop.x, y: p.y - crop.y, id: event.pointerId };
    cropBox.setPointerCapture(event.pointerId);
  });
  cropBox.addEventListener("pointermove", (event) => {
    if (!crop.drag || crop.drag.id !== event.pointerId) return;
    const p = imagePoint(event);
    crop.x = Math.max(0, Math.min(image.w - crop.w, p.x - crop.drag.x));
    crop.y = Math.max(0, Math.min(image.h - crop.h, p.y - crop.drag.y));
    layoutCrop();
  });

  function drawTextPreview() {
    if (!showTextGhost) return;
    const text = document.querySelector("#text-value")?.value || "Stu";
    const size = Number(document.querySelector("#text-size")?.value || 120);
    const mode = document.querySelector("#text-font")?.value || "script";
    ctx.save();
    ctx.font = `${size}px ${mode === "sans" ? "sans-serif" : "Kaushan Script, cursive"}`;
    ctx.fillStyle = document.querySelector("#text-color")?.value || "#f2f2f4";
    ctx.textBaseline = "top";
    ctx.fillText(text, textPos.x, textPos.y);
    ctx.restore();
  }

  function showSwatch(r, g, b, id) {
    const hex = `#${[r, g, b].map((v) => clampByte(v).toString(16).padStart(2, "0")).join("")}`;
    const node = document.querySelector(id);
    if (!node) return;
    node.hidden = false;
    node.innerHTML = "";
    const chip = document.createElement("i");
    chip.style.background = hex;
    node.append(chip, document.createTextNode(` ${hex}`));
  }

  function renderControls() {
    controls.innerHTML = "";
    const add = (node) => controls.append(node);
    if (tool === "bg") {
      add(buttonRow([
        ["Auto remove", () => run("matte", { tryModel: true, tolerance: tolValue(), force: false }, "Removing the background…")],
        ["Flood fill", () => run("matte", { tryModel: false, tolerance: tolValue(), force: true }, "Flood-filling the backdrop…")],
      ]));
      add(slider("Flat-background tolerance", "bg-tol", 8, 80, 24, 1));
      add(slider("Edge feather / defringe", "feather", 0, 12, 2, 0.5));
      add(html(`<label class="check"><input id="brush-on" type="checkbox"><span>Brush</span>
        <select id="brush-mode"><option value="erase">Erase</option><option value="restore">Restore</option></select></label>`));
      add(slider("Brush size", "brush-size", 4, 80, 28, 1));
      add(html(`<label class="check"><input id="tap-mode" type="checkbox"><span>Tap to remove this color</span></label>`));
      add(slider("Tap color tolerance", "tap-tol", 8, 90, 36, 1));
      add(paragraph("Pinch to zoom. Auto tries the in-browser model, then the flood-fill matte. Feather kills white halos."));
      document.querySelector("#feather").addEventListener("change", () => {
        run("feather", { amount: Number(document.querySelector("#feather").value) }, "Feathering the edge…");
      });
    } else if (tool === "crop") {
      const ratio = document.createElement("select");
      ratio.id = "crop-ratio";
      for (const [value, label] of RATIOS) {
        const opt = document.createElement("option");
        opt.value = value === "free" ? "" : value;
        opt.textContent = label;
        ratio.append(opt);
      }
      const field = document.createElement("label");
      field.className = "field";
      field.append(span("Crop ratio"), ratio);
      add(field);
      ratio.addEventListener("change", resetCrop);
      add(buttonRow([
        ["Apply crop", applyCrop],
        ["Rotate 90°", () => run("rotate", { degrees: 90 }, "Rotating…")],
        ["Flip", () => run("flip", { horizontal: true }, "Flipping…")],
      ]));
      add(slider("Straighten", "straighten", -15, 15, 0, 0.25));
      add(buttonRow([["Apply straighten", applyStraighten]]));
      resetCrop();
    } else if (tool === "resize") {
      add(paragraph("Set the export size below. Inches are the default, in 0.25 in steps. Apply resamples this image to that pixel size."));
      add(buttonRow([["Apply size", applyResize]]));
    } else if (tool === "adjust") {
      add(slider("Brightness", "adj-b", -100, 100, 0, 1));
      add(slider("Contrast", "adj-c", -100, 100, 0, 1));
      add(slider("Saturation", "adj-s", -100, 100, 0, 1));
      add(slider("Sharpen", "adj-sh", 0, 100, 0, 1));
      add(slider("Levels black", "adj-black", 0, 120, 0, 1));
      add(slider("Levels white", "adj-white", 140, 255, 255, 1));
      add(slider("Threshold", "adj-th", 0, 255, 128, 1));
      add(html(`<label class="check"><input id="adj-gray" type="checkbox"><span>Grayscale</span></label>`));
      add(html(`<label class="check"><input id="adj-inv" type="checkbox"><span>Invert</span></label>`));
      add(html(`<label class="check"><input id="adj-use-th" type="checkbox"><span>Use threshold</span></label>`));
      add(buttonRow([["Apply adjustments", applyAdjust]]));
    } else if (tool === "colors") {
      add(slider("Number of colors", "color-n", 2, 12, 6, 1));
      add(buttonRow([["Reduce colors", applyPoster]]));
      add(html(`<label class="check"><input id="eyedrop" type="checkbox"><span>Eyedropper — drag on the image</span></label>`));
      const picked = document.createElement("p");
      picked.id = "picked";
      picked.className = "swatch-readout";
      picked.hidden = true;
      add(picked);
      const palette = document.createElement("div");
      palette.id = "palette";
      palette.className = "palette";
      add(palette);
    } else if (tool === "trace") {
      add(slider("Trace colors", "trace-n", 2, 16, 8, 1));
      add(buttonRow([["Trace to SVG", traceSvg]]));
      add(paragraph("Best for logos and lettering. The SVG downloads with the export button when SVG is the format, or immediately from this button."));
    } else if (tool === "text") {
      add(html(`<label class="field"><span>Text</span><input id="text-value" type="text" value="Stu" maxlength="32"></label>`));
      const font = document.createElement("select");
      font.id = "text-font";
      for (const [value, label] of [["script", "Script"], ["chrome", "Chrome"], ["sans", "Sans"]]) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        font.append(opt);
      }
      const field = document.createElement("label");
      field.className = "field";
      field.append(span("Style"), font);
      add(field);
      add(slider("Size", "text-size", 24, 400, 140, 1));
      add(html(`<label class="field"><span>Color</span><input id="text-color" type="color" value="#f4f4f6"></label>`));
      add(buttonRow([["Place text", placeText]]));
      add(paragraph("Drag on the image to move the words, then place them. Chrome uses the same metallic script as the chest logo."));
      for (const id of ["#text-value", "#text-font", "#text-size", "#text-color"]) {
        document.querySelector(id).addEventListener("input", () => {
          showTextGhost = true;
          paint();
        });
      }
      loadScriptFont();
    } else if (tool === "trim") {
      add(paragraph("Cuts the image to the non-transparent pixels."));
      add(buttonRow([["Trim edges", () => run("trim", {}, "Trimming…")]]));
    }
  }

  function tolValue() {
    return Number(document.querySelector("#bg-tol")?.value || 24);
  }

  function buttonRow(items) {
    const row = document.createElement("div");
    row.className = "actions wrap";
    for (const [label, fn] of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      btn.textContent = label;
      btn.addEventListener("click", fn);
      row.append(btn);
    }
    return row;
  }
  function slider(label, id, min, max, value, step) {
    const wrap = document.createElement("label");
    wrap.className = "field";
    wrap.innerHTML = `<span>${label}</span><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}">`;
    return wrap;
  }
  function paragraph(text) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = text;
    return p;
  }
  function html(source) {
    const wrap = document.createElement("div");
    wrap.innerHTML = source;
    return wrap.firstElementChild;
  }
  function span(text) {
    const node = document.createElement("span");
    node.textContent = text;
    return node;
  }

  function applyCrop() {
    if (!image) return;
    const x = Math.max(0, Math.round(crop.x));
    const y = Math.max(0, Math.round(crop.y));
    const w = Math.max(1, Math.min(image.w - x, Math.round(crop.w)));
    const h = Math.max(1, Math.min(image.h - y, Math.round(crop.h)));
    const out = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      const src = ((y + row) * image.w + x) * 4;
      out.set(image.rgba.subarray(src, src + w * 4), row * w * 4);
    }
    replace(out, w, h);
    resetCrop();
    setStatus("Cropped.");
  }

  async function applyStraighten() {
    const deg = Number(document.querySelector("#straighten").value || 0);
    if (!deg) return;
    const msg = await run("rotate", { degrees: deg }, "Straightening…");
    if (!msg || !image) return;
    const rad = Math.abs(deg) * Math.PI / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const prevW = undo[undo.length - 1]?.w || image.w;
    const prevH = undo[undo.length - 1]?.h || image.h;
    const cw = Math.max(1, Math.floor(prevW * c - prevH * s));
    const ch = Math.max(1, Math.floor(prevH * c - prevW * s));
    const x = Math.max(0, Math.round((image.w - cw) / 2));
    const y = Math.max(0, Math.round((image.h - ch) / 2));
    const out = new Uint8ClampedArray(cw * ch * 4);
    for (let row = 0; row < ch; row++) {
      const src = ((y + row) * image.w + x) * 4;
      out.set(image.rgba.subarray(src, src + cw * 4), row * cw * 4);
    }
    image = { rgba: out, w: cw, h: ch };
    paint();
    fit();
  }

  async function applyResize() {
    const spec = toolsRow.read();
    await run("resize", { dw: spec.pxW, dh: spec.pxH }, "Resampling…");
  }

  async function applyAdjust() {
    const thresholdOn = document.querySelector("#adj-use-th").checked;
    await run("adjust", {
      brightness: Number(document.querySelector("#adj-b").value),
      contrast: Number(document.querySelector("#adj-c").value),
      saturation: Number(document.querySelector("#adj-s").value),
      sharpen: Number(document.querySelector("#adj-sh").value),
      black: Number(document.querySelector("#adj-black").value),
      white: Number(document.querySelector("#adj-white").value),
      threshold: thresholdOn ? Number(document.querySelector("#adj-th").value) : null,
      invert: document.querySelector("#adj-inv").checked,
      grayscale: document.querySelector("#adj-gray").checked,
    }, "Adjusting…");
  }

  async function applyPoster() {
    const msg = await run("posterize", { colors: Number(document.querySelector("#color-n").value) }, "Reducing colors…");
    const palette = document.querySelector("#palette");
    if (!palette || !msg?.extra?.palette) return;
    palette.innerHTML = "";
    for (const color of msg.extra.palette) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "palette-chip";
      chip.innerHTML = `<i style="background:${color.hex}"></i><span>${color.hex}</span>`;
      palette.append(chip);
    }
  }

  let lastSvg = "";
  async function traceSvg() {
    if (!image) return;
    busy = true;
    setStatus("Tracing to SVG…");
    try {
      const msg = await job("trace", image.rgba, image.w, image.h, {
        colors: Number(document.querySelector("#trace-n")?.value || 8),
      });
      lastSvg = msg.svg || "";
      const blob = new Blob([lastSvg], { type: "image/svg+xml" });
      downloadBlob(blob, "traced.svg");
      setStatus("SVG downloaded.");
    } catch (err) {
      setStatus(err.message || String(err));
    } finally {
      busy = false;
    }
  }

  async function loadScriptFont() {
    if (fontPromise) return fontPromise;
    fontPromise = (async () => {
      const face = new FontFace("Kaushan Script", `url(${fontUrl})`);
      await face.load();
      document.fonts.add(face);
      const buf = await fetch(fontUrl).then((r) => r.arrayBuffer());
      return opentype.parse(buf);
    })();
    return fontPromise;
  }

  async function placeText() {
    if (!image) return;
    const text = document.querySelector("#text-value").value || "Stu";
    const size = Number(document.querySelector("#text-size").value || 140);
    const mode = document.querySelector("#text-font").value;
    const color = document.querySelector("#text-color").value;
    if (mode === "chrome") {
      busy = true;
      setStatus("Rendering chrome lettering…");
      try {
        const font = await loadScriptFont();
        const logo = await renderChrome(font, text, Math.round(size * 3));
        const out = image.rgba.slice();
        blit(out, image.w, image.h, logo.rgba, logo.w, logo.h, Math.round(textPos.x), Math.round(textPos.y));
        showTextGhost = false;
        replace(out, image.w, image.h);
        setStatus("Text placed.");
      } catch (err) {
        setStatus(err.message || String(err));
      } finally {
        busy = false;
      }
      return;
    }
    const bake = document.createElement("canvas");
    bake.width = image.w;
    bake.height = image.h;
    const g = bake.getContext("2d");
    g.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.w, image.h), 0, 0);
    g.font = `${size}px ${mode === "sans" ? "sans-serif" : "Kaushan Script, cursive"}`;
    g.fillStyle = color;
    g.textBaseline = "top";
    g.fillText(text, textPos.x, textPos.y);
    const snap = g.getImageData(0, 0, image.w, image.h);
    showTextGhost = false;
    replace(snap.data, image.w, image.h);
    setStatus("Text placed.");
  }

  function blit(dst, dw, dh, src, sw, sh, x0, y0) {
    for (let y = 0; y < sh; y++) {
      const dy = y0 + y;
      if (dy < 0 || dy >= dh) continue;
      for (let x = 0; x < sw; x++) {
        const dx = x0 + x;
        if (dx < 0 || dx >= dw) continue;
        const si = (y * sw + x) * 4;
        const a = src[si + 3] / 255;
        if (a <= 0) continue;
        const di = (dy * dw + dx) * 4;
        dst[di] = src[si] * a + dst[di] * (1 - a);
        dst[di + 1] = src[si + 1] * a + dst[di + 1] * (1 - a);
        dst[di + 2] = src[si + 2] * a + dst[di + 2] * (1 - a);
        dst[di + 3] = Math.max(dst[di + 3], src[si + 3]);
      }
    }
  }

  const store = loadStore();
  const toolsState = { ...store.tools, unit: store.unit, dpi: store.dpi };
  const exportHost = document.querySelector("#tools-export");
  const unitRow = document.createElement("div");
  unitRow.className = "unit-toggle";
  for (const [id, label] of [["in", "Inches"], ["cm", "cm"], ["px", "px"]]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.dataset.unit = id;
    btn.classList.toggle("on", id === (toolsState.unit || "in"));
    btn.addEventListener("click", () => {
      toolsState.unit = id;
      for (const b of unitRow.querySelectorAll("button")) b.classList.toggle("on", b.dataset.unit === id);
      toolsRow.setUnit(id);
      saveStore({ unit: id, tools: readTools() });
    });
    unitRow.append(btn);
  }
  if (![...unitRow.querySelectorAll("button")].some((b) => b.classList.contains("on"))) {
    unitRow.querySelector("[data-unit=in]").classList.add("on");
  }
  const dpiField = document.createElement("label");
  dpiField.className = "field";
  const dpiSelect = document.createElement("select");
  dpiSelect.id = "tools-dpi";
  for (const dpi of DPI_CHOICES) {
    const opt = document.createElement("option");
    opt.value = String(dpi);
    opt.textContent = `${dpi} DPI`;
    if (dpi === store.dpi) opt.selected = true;
    dpiSelect.append(opt);
  }
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "Custom DPI";
  dpiSelect.append(custom);
  const dpiCustom = document.createElement("input");
  dpiCustom.type = "number";
  dpiCustom.min = "72";
  dpiCustom.max = "1200";
  dpiCustom.step = "1";
  dpiCustom.value = String(store.dpi || 300);
  dpiCustom.hidden = DPI_CHOICES.includes(store.dpi);
  dpiField.append(span("DPI"), dpiSelect, dpiCustom);
  const formatField = document.createElement("label");
  formatField.className = "field";
  const format = document.createElement("select");
  format.id = "tools-format";
  for (const [value, label] of [["png", "PNG (transparent)"], ["jpg", "JPG"], ["svg", "SVG"], ["pdf", "PDF at actual size"]]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (value === (store.format || "png")) opt.selected = true;
    format.append(opt);
  }
  formatField.append(span("File format"), format);
  const quality = document.createElement("label");
  quality.className = "field";
  quality.innerHTML = `<span>JPG quality</span><input id="jpg-quality" type="range" min="0.5" max="1" step="0.01" value="${store.jpgQuality || 0.92}">`;
  quality.hidden = format.value !== "jpg";
  format.addEventListener("change", () => {
    quality.hidden = format.value !== "jpg";
    saveStore({ format: format.value });
  });
  dpiSelect.addEventListener("change", () => {
    dpiCustom.hidden = dpiSelect.value !== "custom";
    const dpi = dpiSelect.value === "custom" ? Number(dpiCustom.value) : Number(dpiSelect.value);
    toolsState.dpi = dpi;
    toolsRow.setDpi(dpi);
    saveStore({ dpi, tools: readTools() });
  });
  dpiCustom.addEventListener("change", () => {
    toolsState.dpi = Number(dpiCustom.value) || 300;
    toolsRow.setDpi(toolsState.dpi);
    saveStore({ dpi: toolsState.dpi });
  });
  exportHost.append(unitRow, dpiField, formatField, quality);
  const toolsRow = mountSizeRow(exportHost, {
    legend: "Export size",
    state: toolsState,
    getSource: () => (image ? { w: image.w, h: image.h } : null),
    onChange: () => saveStore({ unit: toolsState.unit, dpi: toolsState.dpi, tools: readTools() }),
  });
  function readTools() {
    return { preset: toolsState.preset, widthIn: toolsState.widthIn, heightIn: toolsState.heightIn, lock: toolsState.lock };
  }

  async function downloadCurrent() {
    if (!image) return;
    const spec = toolsRow.read();
    const formatName = format.value;
    setStatus("Preparing the file…");
    const msg = await job("resize", image.rgba, image.w, image.h, { dw: spec.pxW, dh: spec.pxH });
    if (formatName === "svg") {
      const traced = await job("trace", msg.pixels, msg.w, msg.h, { colors: 8 });
      downloadBlob(new Blob([traced.svg], { type: "image/svg+xml" }), "image.svg");
    } else if (formatName === "pdf") {
      const png = encodeRGBA(msg.pixels, msg.w, msg.h, spec.dpi);
      const pdf = await buildArtPdf(png, spec.widthIn, spec.heightIn, "Export", "Print Shop Separator");
      downloadBlob(new Blob([pdf], { type: "application/pdf" }), "image.pdf");
    } else if (formatName === "jpg") {
      const blob = await rasterBlob(msg.pixels, msg.w, msg.h, "image/jpeg", Number(document.querySelector("#jpg-quality").value));
      downloadBlob(blob, "image.jpg");
    } else {
      const png = encodeRGBA(msg.pixels, msg.w, msg.h, spec.dpi);
      downloadBlob(new Blob([png], { type: "image/png" }), "image.png");
    }
    setStatus(`Downloaded ${spec.pxW} × ${spec.pxH} px · ${spec.widthIn.toFixed(2)} in wide at ${spec.dpi} DPI.`);
  }

  function rasterBlob(rgba, w, h, type, quality) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    const out = new Uint8ClampedArray(rgba);
    if (type === "image/jpeg") {
      for (let i = 0; i < out.length; i += 4) {
        const a = out[i + 3] / 255;
        out[i] = out[i] * a + 255 * (1 - a);
        out[i + 1] = out[i + 1] * a + 255 * (1 - a);
        out[i + 2] = out[i + 2] * a + 255 * (1 - a);
        out[i + 3] = 255;
      }
    }
    g.putImageData(new ImageData(out, w, h), 0, 0);
    return new Promise((resolve) => c.toBlob(resolve, type, quality));
  }

  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function loadFile(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(file));
    let w = bitmap.width;
    let h = bitmap.height;
    const maxEdge = 2048;
    if (Math.max(w, h) > maxEdge) {
      const s = maxEdge / Math.max(w, h);
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const data = new Uint8ClampedArray(g.getImageData(0, 0, w, h).data);
    original = { rgba: data.slice(), w, h };
    undo = [];
    redo = [];
    image = { rgba: data, w, h };
    work.hidden = false;
    document.querySelector("#tools-file-name").textContent = file.name || "Camera photo";
    textPos = { x: w * 0.2, y: h * 0.15 };
    renderControls();
    paint();
    fit();
    toolsRow.refresh();
    updateHistoryButtons();
    setStatus("Ready.");
  }

  for (const [id, label] of TOOLS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = label;
    btn.dataset.tool = id;
    if (id === tool) btn.classList.add("on");
    btn.addEventListener("click", () => {
      tool = id;
      for (const chip of chips.querySelectorAll(".chip")) chip.classList.toggle("on", chip.dataset.tool === id);
      renderControls();
      paint();
    });
    chips.append(btn);
  }
  renderControls();

  document.querySelector("#tools-camera").addEventListener("click", async () => {
    try {
      const photo = await captureNativePhoto();
      if (photo) {
        await loadFile(photo);
        return;
      }
    } catch (err) {
      setStatus(err.message || String(err));
    }
    document.querySelector("#tools-camera-input").click();
  });
  document.querySelector("#tools-upload").addEventListener("click", () => document.querySelector("#tools-file-input").click());
  document.querySelector("#tools-camera-input").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) loadFile(file);
    event.target.value = "";
  });
  document.querySelector("#tools-file-input").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) loadFile(file);
    event.target.value = "";
  });
  document.querySelector("#bg-switch").addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    zoom.classList.remove("checker", "black", "white");
    zoom.classList.add(btn.dataset.bg);
    for (const b of document.querySelectorAll("#bg-switch button")) b.classList.toggle("on", b === btn);
  });
  document.querySelector("#undo").addEventListener("click", () => {
    if (!undo.length || !image) return;
    redo.push({ rgba: image.rgba.slice(), w: image.w, h: image.h });
    const prev = undo.pop();
    image = prev;
    paint();
    fit();
    updateHistoryButtons();
  });
  document.querySelector("#redo").addEventListener("click", () => {
    if (!redo.length || !image) return;
    undo.push({ rgba: image.rgba.slice(), w: image.w, h: image.h });
    image = redo.pop();
    paint();
    fit();
    updateHistoryButtons();
  });
  document.querySelector("#tools-download").addEventListener("click", () => downloadCurrent());
  document.querySelector("#tools-use").addEventListener("click", async () => {
    if (!image) return;
    const blob = await rasterBlob(image.rgba, image.w, image.h, "image/png");
    const file = new File([blob], "edited.png", { type: "image/png" });
    usePrintFile(file);
    setStatus("Sent to the print package.");
  });

  view.addEventListener("tools-show", async () => {
    if (!image) {
      const file = getPrintFile();
      if (file) await loadFile(file);
    } else {
      fit();
    }
  });

  return { loadFile, hasImage: () => !!image };
}

function clampByte(v) {
  return Math.max(0, Math.min(255, v | 0));
}
