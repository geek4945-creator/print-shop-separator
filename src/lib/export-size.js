/** Shared export size: inches are the stored unit and the default display unit. */

export const STORE_KEY = "print-shop-separator-export-v1";

export const PRESETS = [
  { id: "chest", label: "Left chest 3.5 in", widthIn: 3.5 },
  { id: "back", label: "Full back 12 in", widthIn: 12 },
  { id: "front", label: "Full front 10 in", widthIn: 10 },
  { id: "youth", label: "Youth back 10 in", widthIn: 10 },
  { id: "sleeve", label: "Sleeve 3 in", widthIn: 3 },
  { id: "hat", label: "Hat 4 in", widthIn: 4 },
  { id: "koozie", label: "Koozie/sticker 3 in", widthIn: 3 },
  { id: "custom", label: "Custom", widthIn: null },
];

export const DPI_CHOICES = [150, 200, 300, 600];

const DEFAULTS = {
  unit: "in",
  dpi: 300,
  format: "png",
  jpgQuality: 0.92,
  back: { preset: "back", widthIn: 12, heightIn: null, lock: true },
  front: { preset: "front", widthIn: 10, heightIn: null, lock: true },
  chest: { preset: "chest", widthIn: 3.5, heightIn: null, lock: true },
  tools: { preset: "back", widthIn: 12, heightIn: null, lock: true },
};

export function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULTS),
      ...parsed,
      back: { ...DEFAULTS.back, ...(parsed.back || {}) },
      front: { ...DEFAULTS.front, ...(parsed.front || {}) },
      chest: { ...DEFAULTS.chest, ...(parsed.chest || {}) },
      tools: { ...DEFAULTS.tools, ...(parsed.tools || {}) },
      unit: parsed.unit === "cm" || parsed.unit === "px" ? parsed.unit : "in",
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveStore(next) {
  const current = loadStore();
  const merged = { ...current, ...next };
  localStorage.setItem(STORE_KEY, JSON.stringify(merged));
  return merged;
}

export function toInches(value, unit, dpi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (unit === "cm") return n / 2.54;
  if (unit === "px") return n / Math.max(1, dpi);
  return n;
}

export function fromInches(inches, unit, dpi) {
  if (unit === "cm") return inches * 2.54;
  if (unit === "px") return inches * dpi;
  return inches;
}

export function stepFor(unit) {
  if (unit === "in") return 0.25;
  if (unit === "cm") return 0.5;
  return 1;
}

export function unitLabel(unit) {
  if (unit === "cm") return "cm";
  if (unit === "px") return "px";
  return "in";
}

export function formatLength(inches, unit, dpi) {
  const v = fromInches(inches, unit, dpi);
  if (unit === "px") return String(Math.round(v));
  return (Math.round(v * 100) / 100).toString();
}

/**
 * Pixel size for an export. Locked aspect uses the source ratio.
 * Unlocked sizes fit the artwork inside the inch box without stretching.
 */
export function outputPixels({ widthIn, heightIn, lock, dpi, srcW, srcH }) {
  const dpiN = Math.max(72, Math.min(1200, Number(dpi) || 300));
  const wIn = Math.max(0.25, Number(widthIn) || 1);
  let hIn = heightIn;
  const aspect = srcW > 0 && srcH > 0 ? srcH / srcW : 1;
  if (lock || !hIn) hIn = wIn * aspect;
  hIn = Math.max(0.25, hIn);
  let pxW = Math.max(1, Math.round(wIn * dpiN));
  let pxH = Math.max(1, Math.round(hIn * dpiN));
  if (!lock && srcW > 0 && srcH > 0) {
    const scale = Math.min(pxW / srcW, pxH / srcH);
    pxW = Math.max(1, Math.round(srcW * scale));
    pxH = Math.max(1, Math.round(srcH * scale));
  }
  const effectiveDpi = srcW > 0 ? srcW / wIn : 0;
  const upscale = srcW > 0 ? pxW / srcW : 1;
  return { dpi: dpiN, widthIn: wIn, heightIn: hIn, pxW, pxH, effectiveDpi, upscale };
}

export function upscaleWarning(info) {
  if (!info || !info.upscale) return "";
  if (info.upscale >= 2) {
    return `This enlarges the source about ${info.upscale.toFixed(1)}×. Fine detail will look soft.`;
  }
  if (info.upscale >= 1.5) {
    return `This enlarges the source about ${info.upscale.toFixed(1)}×. Check a proof before printing.`;
  }
  if (info.effectiveDpi && info.effectiveDpi + 1 < info.dpi) {
    return `Source is about ${Math.round(info.effectiveDpi)} DPI at this width, below the ${info.dpi} DPI output.`;
  }
  return "";
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

/**
 * One size block. Values are kept in inches. The visible inputs follow `unit`.
 */
export function mountSizeRow(parent, { legend, state, getSource, onChange }) {
  const root = el("fieldset", { class: "size-row" });
  const legendEl = el("legend", { text: legend });
  const preset = el("select", { "aria-label": `${legend} preset` });
  for (const item of PRESETS) {
    const opt = el("option", { value: item.id, text: item.label });
    if (item.id === state.preset) opt.selected = true;
    preset.append(opt);
  }
  const width = el("input", { type: "number", inputmode: "decimal", "aria-label": `${legend} width` });
  const height = el("input", { type: "number", inputmode: "decimal", "aria-label": `${legend} height` });
  const lock = el("input", { type: "checkbox" });
  lock.checked = state.lock !== false;
  const lockLabel = el("label", { class: "lock" }, [lock, el("span", { text: "Lock aspect" })]);
  const readout = el("p", { class: "readout" });
  const warn = el("p", { class: "hint warn" });

  function unit() {
    return state.unit || "in";
  }
  function syncInputs() {
    const dpi = state.dpi || 300;
    const u = unit();
    const step = String(stepFor(u));
    width.step = step;
    height.step = step;
    width.min = u === "px" ? "16" : u === "cm" ? "0.5" : "0.25";
    height.min = width.min;
    width.value = formatLength(state.widthIn, u, dpi);
    const src = getSource() || { w: 0, h: 0 };
    const info = outputPixels({ ...state, dpi, srcW: src.w, srcH: src.h });
    state.heightIn = info.heightIn;
    height.value = formatLength(info.heightIn, u, dpi);
    height.disabled = !!state.lock;
    const name = unitLabel(u);
    readout.textContent = src.w
      ? `${info.pxW} × ${info.pxH} px at ${info.dpi} DPI · source about ${Math.round(info.effectiveDpi)} DPI at this width`
      : `${info.pxW} × ${info.pxH} px at ${info.dpi} DPI · load an image to see source DPI`;
    warn.textContent = src.w ? upscaleWarning(info) : "";
    warn.hidden = !warn.textContent;
    width.dataset.unit = name;
    void name;
  }

  function emit() {
    onChange(read());
    syncInputs();
  }

  preset.addEventListener("change", () => {
    const item = PRESETS.find((p) => p.id === preset.value);
    state.preset = preset.value;
    if (item && item.widthIn) state.widthIn = item.widthIn;
    emit();
  });
  width.addEventListener("change", () => {
    state.widthIn = Math.max(0.25, toInches(width.value, unit(), state.dpi || 300));
    state.preset = "custom";
    preset.value = "custom";
    emit();
  });
  height.addEventListener("change", () => {
    if (state.lock) return;
    state.heightIn = Math.max(0.25, toInches(height.value, unit(), state.dpi || 300));
    state.preset = "custom";
    preset.value = "custom";
    emit();
  });
  lock.addEventListener("change", () => {
    state.lock = lock.checked;
    if (lock.checked) state.heightIn = null;
    emit();
  });
  syncInputs();

  const widthField = el("label", { class: "field" }, [el("span", { class: "unit-caption", text: "Width" }), width]);
  const heightField = el("label", { class: "field" }, [el("span", { class: "unit-caption", text: "Height" }), height]);
  root.append(legendEl, preset, el("div", { class: "split" }, [widthField, heightField]), lockLabel, readout, warn);
  parent.append(root);

  function read() {
    const src = getSource() || { w: 0, h: 0 };
    const info = outputPixels({ ...state, dpi: state.dpi || 300, srcW: src.w, srcH: src.h });
    return {
      preset: state.preset,
      widthIn: state.widthIn,
      heightIn: info.heightIn,
      lock: !!state.lock,
      dpi: info.dpi,
      ...info,
      warning: upscaleWarning(info),
    };
  }

  return {
    root,
    read,
    refresh() {
      syncInputs();
    },
    setUnit(unitName) {
      state.unit = unitName;
      syncInputs();
    },
    setDpi(dpi) {
      state.dpi = dpi;
      syncInputs();
    },
  };
}

const PACKAGE_ROWS = [
  ["back", "Back"],
  ["front", "Front"],
  ["chest", "Chest"],
];

/** Back, front, and chest sizes for the print package. Inches are the default unit. */
export function mountPackageExports(parent, getSource) {
  const store = loadStore();
  const shared = { unit: store.unit || "in", dpi: store.dpi || 300 };
  parent.innerHTML = "";
  const title = el("h2", { text: "Export size" });
  const note = el("p", { class: "hint", text: "Sizes are in inches, in 0.25 in steps. PNG and actual-size PDF both use this size and DPI." });
  const unitRow = el("div", { class: "unit-toggle" });
  for (const [id, label] of [["in", "Inches"], ["cm", "cm"], ["px", "px"]]) {
    const btn = el("button", { type: "button", text: label, "data-unit": id });
    if (id === shared.unit) btn.classList.add("on");
    btn.addEventListener("click", () => {
      shared.unit = id;
      for (const b of unitRow.querySelectorAll("button")) b.classList.toggle("on", b.dataset.unit === id);
      for (const row of Object.values(rows)) row.setUnit(id);
      persist();
    });
    unitRow.append(btn);
  }
  const dpi = el("select", { id: "package-dpi", "aria-label": "Output DPI" });
  for (const value of DPI_CHOICES) {
    const opt = el("option", { value: String(value), text: `${value} DPI` });
    if (value === shared.dpi) opt.selected = true;
    dpi.append(opt);
  }
  const customOpt = el("option", { value: "custom", text: "Custom DPI" });
  dpi.append(customOpt);
  const customDpi = el("input", {
    type: "number",
    min: "72",
    max: "1200",
    step: "1",
    value: String(shared.dpi),
    "aria-label": "Custom DPI",
  });
  customDpi.hidden = DPI_CHOICES.includes(shared.dpi);
  if (!DPI_CHOICES.includes(shared.dpi)) dpi.value = "custom";
  dpi.addEventListener("change", () => {
    customDpi.hidden = dpi.value !== "custom";
    shared.dpi = dpi.value === "custom" ? Number(customDpi.value) || 300 : Number(dpi.value);
    for (const row of Object.values(rows)) row.setDpi(shared.dpi);
    persist();
  });
  customDpi.addEventListener("change", () => {
    shared.dpi = Number(customDpi.value) || 300;
    for (const row of Object.values(rows)) row.setDpi(shared.dpi);
    persist();
  });
  const dpiField = el("label", { class: "field" }, [el("span", { text: "DPI" }), dpi, customDpi]);
  parent.append(title, note, unitRow, dpiField);
  const states = {};
  const rows = {};
  for (const [key, label] of PACKAGE_ROWS) {
    states[key] = { ...store[key], unit: shared.unit, dpi: shared.dpi };
    rows[key] = mountSizeRow(parent, {
      legend: label,
      state: states[key],
      getSource,
      onChange: persist,
    });
  }
  function persist() {
    const next = { unit: shared.unit, dpi: shared.dpi };
    for (const key of Object.keys(rows)) {
      const value = rows[key].read();
      next[key] = { preset: value.preset, widthIn: value.widthIn, heightIn: value.lock ? null : value.heightIn, lock: value.lock };
      states[key].widthIn = value.widthIn;
      states[key].preset = value.preset;
      states[key].lock = value.lock;
    }
    saveStore(next);
  }
  return {
    refresh() {
      for (const row of Object.values(rows)) row.refresh();
    },
    read() {
      const out = { dpi: shared.dpi, unit: shared.unit };
      for (const key of Object.keys(rows)) out[key] = rows[key].read();
      return out;
    },
  };
}
