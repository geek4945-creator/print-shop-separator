import { DPI_CHOICES, loadStore, mountSizeRow, saveStore } from "./lib/export-size.js";
import { captureNativePhoto, deliverZip, upscaleProfile } from "./lib/native.js";
import { initTools } from "./tools.js";

const SIZES = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"];
const LOCS = ["back", "front", "name", "cuff"];

const generateBtn = document.querySelector("#generate");
const statusEl = document.querySelector("#status");
const bar = document.querySelector("#bar");
const barFill = document.querySelector("#bar-fill");
const errorEl = document.querySelector("#error");
const results = document.querySelector("#results");
const summaryEl = document.querySelector("#summary");
const mockupsEl = document.querySelector("#mockups");
const filmView = document.querySelector("#film-view");
const filmTitle = document.querySelector("#film-title");

const artFiles = { back: null, front: null, name: null, cuff: null };
const sizeRows = {};
const store = loadStore();
const shared = { unit: store.unit || "in", dpi: store.dpi || 300 };

let worker = null;
let zipUrl = null;
let zipName = "print-files.zip";
let zipBytesCache = null;
let films = [];
let filmIndex = 0;
let busy = false;
const urls = [];

function fillSizes(id) {
  const select = document.querySelector(id);
  for (const size of SIZES) {
    const option = document.createElement("option");
    option.value = size;
    option.textContent = size;
    if (size === "XL") option.selected = true;
    select.append(option);
  }
}
fillSizes("#sweater-size");
fillSizes("#tee-size");

function track(url) {
  urls.push(url);
  return url;
}
function clearUrls() {
  for (const url of urls) URL.revokeObjectURL(url);
  urls.length = 0;
}

function sourceFor(id) {
  const img = document.querySelector(`#preview-${id}`);
  if (!img || !img.naturalWidth) return null;
  return { w: img.naturalWidth, h: img.naturalHeight };
}

function locationChecked(id) {
  return document.querySelector(`#loc-${id}`).checked;
}

function locationReady(id) {
  if (!locationChecked(id)) return true;
  if (artFiles[id]) return true;
  if (id === "name" && document.querySelector("#name").value.trim()) return true;
  return false;
}

function refreshGenerate() {
  const any = LOCS.some(locationChecked);
  generateBtn.disabled = busy || !any || !LOCS.every(locationReady);
}

function persistLocations() {
  const next = { unit: shared.unit, dpi: shared.dpi, locations: {} };
  for (const id of LOCS) {
    next.locations[id] = locationChecked(id);
    const value = sizeRows[id].read();
    next[id] = { preset: value.preset, widthIn: value.widthIn, heightIn: value.lock ? null : value.heightIn, lock: value.lock };
  }
  saveStore(next);
}

function setLocationFile(id, next) {
  artFiles[id] = next || null;
  const img = document.querySelector(`#preview-${id}`);
  const stage = document.querySelector(`#stage-${id}`);
  const label = document.querySelector(`#file-${id}`);
  if (img.src && img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
  if (next) {
    img.onload = () => sizeRows[id].refresh();
    img.src = URL.createObjectURL(next);
    stage.hidden = false;
    label.textContent = next.name || "Camera photo";
  } else {
    img.removeAttribute("src");
    stage.hidden = true;
    label.textContent = id === "name" ? "Using the typed name in chrome script." : `No ${id} artwork yet.`;
  }
  refreshGenerate();
}

for (const id of LOCS) {
  const box = document.querySelector(`#loc-${id}`);
  if (id in (store.locations || {})) box.checked = !!store.locations[id];
  document.querySelector(`#body-${id}`).hidden = !box.checked;
  box.addEventListener("change", () => {
    document.querySelector(`#body-${id}`).hidden = !box.checked;
    persistLocations();
    refreshGenerate();
  });
  const state = { ...(store[id] || {}), unit: shared.unit, dpi: shared.dpi };
  sizeRows[id] = mountSizeRow(document.querySelector(`#size-${id}`), {
    legend: "Export size",
    state,
    getSource: () => sourceFor(id),
    onChange: persistLocations,
  });
}

const dpiSelect = document.querySelector("#package-dpi");
for (const value of DPI_CHOICES) {
  const opt = document.createElement("option");
  opt.value = String(value);
  opt.textContent = `${value} DPI`;
  if (value === shared.dpi) opt.selected = true;
  dpiSelect.append(opt);
}
const customOpt = document.createElement("option");
customOpt.value = "custom";
customOpt.textContent = "Custom DPI";
dpiSelect.append(customOpt);
const customDpi = document.querySelector("#package-dpi-custom");
customDpi.value = String(shared.dpi);
customDpi.hidden = DPI_CHOICES.includes(shared.dpi);
if (!DPI_CHOICES.includes(shared.dpi)) dpiSelect.value = "custom";
function applyDpi() {
  shared.dpi = dpiSelect.value === "custom" ? Number(customDpi.value) || 300 : Number(dpiSelect.value);
  for (const row of Object.values(sizeRows)) row.setDpi(shared.dpi);
  persistLocations();
}
dpiSelect.addEventListener("change", () => {
  customDpi.hidden = dpiSelect.value !== "custom";
  applyDpi();
});
customDpi.addEventListener("change", applyDpi);

for (const button of document.querySelectorAll("#unit-toggle button")) {
  button.classList.toggle("on", button.dataset.unit === shared.unit);
  button.addEventListener("click", () => {
    shared.unit = button.dataset.unit;
    for (const other of document.querySelectorAll("#unit-toggle button")) {
      other.classList.toggle("on", other.dataset.unit === shared.unit);
    }
    for (const row of Object.values(sizeRows)) row.setUnit(shared.unit);
    persistLocations();
  });
}

async function pickPhoto(id) {
  try {
    const photo = await captureNativePhoto();
    if (photo) {
      setLocationFile(id, photo);
      return;
    }
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = err.message || String(err);
  }
  document.querySelector(`[data-camera-input="${id}"]`).click();
}

document.querySelector("#view-print").addEventListener("click", (event) => {
  const camera = event.target.closest("[data-camera]");
  const upload = event.target.closest("[data-upload]");
  if (camera) pickPhoto(camera.dataset.camera);
  if (upload) document.querySelector(`[data-file-input="${upload.dataset.upload}"]`).click();
});
for (const id of LOCS) {
  document.querySelector(`[data-camera-input="${id}"]`).addEventListener("change", (event) => {
    setLocationFile(id, event.target.files && event.target.files[0]);
    event.target.value = "";
  });
  document.querySelector(`[data-file-input="${id}"]`).addEventListener("change", (event) => {
    setLocationFile(id, event.target.files && event.target.files[0]);
    event.target.value = "";
  });
}
document.querySelector("#name").addEventListener("input", refreshGenerate);

document.querySelector("#swatches").addEventListener("click", (event) => {
  const button = event.target.closest(".swatch[data-color]");
  if (!button) return;
  document.querySelector("#color").value = button.dataset.color;
  for (const el of document.querySelectorAll(".swatch")) el.classList.remove("on");
  button.classList.add("on");
});
document.querySelector("#color").addEventListener("input", (event) => {
  for (const el of document.querySelectorAll(".swatch")) el.classList.remove("on");
  event.target.closest(".swatch").classList.add("on");
});

function showView(name) {
  const tools = name === "tools";
  document.querySelector("#view-print").hidden = tools;
  document.querySelector("#view-tools").hidden = !tools;
  document.querySelector("#nav-print").classList.toggle("on", !tools);
  document.querySelector("#nav-tools").classList.toggle("on", tools);
  document.querySelector("#nav-print").setAttribute("aria-selected", String(!tools));
  document.querySelector("#nav-tools").setAttribute("aria-selected", String(tools));
  if (tools) document.querySelector("#view-tools").dispatchEvent(new Event("tools-show"));
}
document.querySelector("#nav-print").addEventListener("click", () => showView("print"));
document.querySelector("#nav-tools").addEventListener("click", () => showView("tools"));
initTools({
  getPrintFile: () => artFiles.back || artFiles.front || artFiles.cuff || artFiles.name,
  usePrintFile: (next) => {
    const target = LOCS.find((id) => id !== "name" && locationChecked(id)) || "back";
    document.querySelector(`#loc-${target}`).checked = true;
    document.querySelector(`#body-${target}`).hidden = false;
    setLocationFile(target, next);
    showView("print");
  },
});

function settings() {
  const garments = [];
  if (document.querySelector("#sweater").checked) {
    garments.push({ kind: "sweater", size: document.querySelector("#sweater-size").value });
  }
  if (document.querySelector("#tee").checked) {
    garments.push({ kind: "tee", size: document.querySelector("#tee-size").value });
  }
  return {
    name: document.querySelector("#name").value,
    garmentColor: document.querySelector("#color").value,
    garments,
    dpi: shared.dpi,
    inkCount: document.querySelector("#inks").value,
    upscaleProfile: upscaleProfile(),
  };
}

async function collectLocations() {
  const locations = [];
  const transfers = [];
  for (const id of LOCS) {
    if (!locationChecked(id)) continue;
    const size = sizeRows[id].read();
    const entry = {
      id,
      widthIn: size.widthIn,
      heightIn: size.lock ? null : size.heightIn,
      lock: size.lock,
      text: id === "name" ? document.querySelector("#name").value : "",
    };
    if (artFiles[id]) {
      entry.buffer = await artFiles[id].arrayBuffer();
      transfers.push(entry.buffer);
    }
    locations.push(entry);
  }
  return { locations, transfers };
}

function showFilm() {
  const film = films[filmIndex];
  if (!film) return;
  filmView.src = film.url;
  filmTitle.textContent = `${filmIndex + 1} / ${films.length} · ${film.title}`;
}

function setBusy(next) {
  busy = next;
  document.querySelector("#download").disabled = next;
  refreshGenerate();
}

generateBtn.addEventListener("click", async () => {
  if (!LOCS.some(locationChecked) || !LOCS.every(locationReady)) return;
  errorEl.hidden = true;
  results.hidden = true;
  statusEl.hidden = false;
  bar.hidden = false;
  statusEl.textContent = "Starting…";
  barFill.style.width = "2%";
  setBusy(true);
  if (worker) worker.terminate();
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onerror = (event) => {
    console.error(event.message || event);
    errorEl.hidden = false;
    errorEl.textContent = event.message || "The print worker failed to start.";
    statusEl.textContent = "Something went wrong. You can try again.";
    setBusy(false);
  };
  const packed = await collectLocations();
  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "progress") {
      statusEl.textContent = msg.detail;
      barFill.style.width = `${Math.max(2, Math.min(100, msg.pct))}%`;
      return;
    }
    if (msg.type === "error") {
      console.error(msg.stack || msg.message);
      errorEl.hidden = false;
      errorEl.textContent = msg.message;
      statusEl.textContent = "Something went wrong. You can try again.";
      setBusy(false);
      return;
    }
    if (msg.type !== "done") return;
    clearUrls();
    if (zipUrl) URL.revokeObjectURL(zipUrl);
    zipName = msg.zipName;
    zipBytesCache = msg.zipBytes;
    zipUrl = URL.createObjectURL(new Blob([msg.zipBytes], { type: "application/zip" }));
    const previewUrls = msg.previews.map((p) => ({
      ...p,
      url: track(URL.createObjectURL(new Blob([p.bytes], { type: "image/jpeg" }))),
    }));
    mockupsEl.replaceChildren();
    for (const shot of previewUrls.filter((p) => p.group === "mockup" || p.group === "art")) {
      const fig = document.createElement("figure");
      const img = document.createElement("img");
      img.src = shot.url;
      img.alt = shot.title;
      const cap = document.createElement("figcaption");
      cap.textContent = shot.title;
      fig.append(img, cap);
      mockupsEl.append(fig);
    }
    films = previewUrls.filter((p) => p.group === "film");
    filmIndex = 0;
    showFilm();
    const s = msg.summary;
    const parts = (s.locations || []).map((loc) => {
      const inches = loc.inches ? `${loc.inches[0].toFixed(2)} × ${loc.inches[1].toFixed(2)} in` : "";
      return `${loc.label} (${inches}): ${(loc.inks || []).join(", ")}`;
    });
    const warn = s.warnings && s.warnings.length ? ` ${s.warnings.join(" ")}` : "";
    summaryEl.textContent = `${s.files.length} files. ${parts.join(". ")}.${warn}`;
    results.hidden = false;
    statusEl.textContent = "Package ready.";
    barFill.style.width = "100%";
    setBusy(false);
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  worker.postMessage({ type: "generate", locations: packed.locations, settings: settings() }, packed.transfers);
});

document.querySelector("#download").addEventListener("click", async () => {
  if (!zipBytesCache) return;
  try {
    const handled = await deliverZip(zipBytesCache, zipName);
    if (handled) return;
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = err.message || String(err);
  }
  const a = document.createElement("a");
  a.href = zipUrl;
  a.download = zipName;
  a.click();
});
document.querySelector("#film-prev").addEventListener("click", () => {
  if (!films.length) return;
  filmIndex = (filmIndex - 1 + films.length) % films.length;
  showFilm();
});
document.querySelector("#film-next").addEventListener("click", () => {
  if (!films.length) return;
  filmIndex = (filmIndex + 1) % films.length;
  showFilm();
});

refreshGenerate();
