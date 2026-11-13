import { mountPackageExports } from "./lib/export-size.js";
import { initTools } from "./tools.js";

const SIZES = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"];

const cameraInput = document.querySelector("#camera-input");
const fileInput = document.querySelector("#file-input");
const sourcePreview = document.querySelector("#source-preview");
const stage = document.querySelector("#stage");
const fileName = document.querySelector("#file-name");
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

let file = null;
let worker = null;
let zipUrl = null;
let zipName = "print-files.zip";
let films = [];
let filmIndex = 0;
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

function useFile(next) {
  if (!next) return;
  file = next;
  if (sourcePreview.src) URL.revokeObjectURL(sourcePreview.src);
  sourcePreview.onload = () => packageSizes.refresh();
  sourcePreview.src = URL.createObjectURL(next);
  stage.hidden = false;
  fileName.textContent = next.name || "Camera photo";
  generateBtn.disabled = false;
  errorEl.hidden = true;
}

document.querySelector("#take-photo").addEventListener("click", () => cameraInput.click());
document.querySelector("#upload").addEventListener("click", () => fileInput.click());
cameraInput.addEventListener("change", () => {
  useFile(cameraInput.files && cameraInput.files[0]);
  cameraInput.value = "";
});
fileInput.addEventListener("change", () => {
  useFile(fileInput.files && fileInput.files[0]);
  fileInput.value = "";
});

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

const packageSizes = mountPackageExports(document.querySelector("#export-sizes"), () => {
  if (!sourcePreview.naturalWidth) return null;
  return { w: sourcePreview.naturalWidth, h: sourcePreview.naturalHeight };
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
  getPrintFile: () => file,
  usePrintFile: (next) => {
    useFile(next);
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
  const sizes = packageSizes.read();
  return {
    name: document.querySelector("#name").value,
    garmentColor: document.querySelector("#color").value,
    garments,
    dpi: sizes.dpi,
    backWidthIn: sizes.back.widthIn,
    backHeightIn: sizes.back.lock ? null : sizes.back.heightIn,
    backLock: sizes.back.lock,
    frontWidthIn: sizes.front.widthIn,
    frontHeightIn: sizes.front.lock ? null : sizes.front.heightIn,
    frontLock: sizes.front.lock,
    chestWidthIn: sizes.chest.widthIn,
    chestHeightIn: sizes.chest.lock ? null : sizes.chest.heightIn,
    chestLock: sizes.chest.lock,
    inkCount: document.querySelector("#inks").value,
  };
}

function showFilm() {
  const film = films[filmIndex];
  if (!film) return;
  filmView.src = film.url;
  filmTitle.textContent = `${filmIndex + 1} / ${films.length} · ${film.title}`;
}

function setBusy(busy) {
  generateBtn.disabled = busy || !file;
  document.querySelector("#download").disabled = busy;
}

generateBtn.addEventListener("click", async () => {
  if (!file) return;
  errorEl.hidden = true;
  results.hidden = true;
  statusEl.hidden = false;
  bar.hidden = false;
  statusEl.textContent = "Starting…";
  barFill.style.width = "2%";
  setBusy(true);
  if (worker) worker.terminate();
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const buffer = await file.arrayBuffer();
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
    const warn = s.warnings && s.warnings.length ? ` ${s.warnings.join(" ")}` : "";
    summaryEl.textContent =
      `${s.files.length} files. Back inks: ${s.backInks.join(", ")}. Front inks: ${(s.frontInks || []).join(", ")}. Chest inks: ${s.chestInks.join(", ")}. ` +
      `Back ${s.backIn[0].toFixed(2)} × ${s.backIn[1].toFixed(2)} in. Front ${s.frontIn[0].toFixed(2)} × ${s.frontIn[1].toFixed(2)} in. Chest ${s.chestIn[0].toFixed(2)} × ${s.chestIn[1].toFixed(2)} in.` +
      warn;
    results.hidden = false;
    statusEl.textContent = "Package ready.";
    barFill.style.width = "100%";
    setBusy(false);
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  worker.postMessage({ type: "generate", buffer, settings: settings() }, [buffer]);
});

document.querySelector("#download").addEventListener("click", () => {
  if (!zipUrl) return;
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
