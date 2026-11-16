# Print Shop Separator

A phone-friendly site that turns a logo or photo into a print-shop package, entirely in the browser. Nothing is uploaded. Image tools (background removal, crop, resize, color, trace, text) sit on the same page and can hand the result to the package generator.

Open it at [https://geek4945-creator.github.io/print-shop-separator/](https://geek4945-creator.github.io/print-shop-separator/) after the Pages workflow on `main` finishes.

## What you get

Check the locations you want. Each checked location is its own folder, with its own art, size, mockup, separations PDF, and films. Unchecked locations are omitted.

- **Back** (on by default, about 12 in wide): `back/back-print.png` and `.pdf`
- **Front** (off by default, about 12 in wide): `front/front-print.png` and `.pdf`
- **Name plate** (on by default, about 3.75 in wide): type a name such as Stu, or upload a photo. A typed name is `name/<name>-name.png` plus a chrome-script `.svg` and `.pdf` (Kaushan Script, SIL Open Font License)
- **Shirt cuff** (off by default, about 3 in wide): `cuff/cuff-print.png` and `.pdf`
- `mockups/` — one placement mockup per included location, on the crewneck and tee you checked
- `PRINT-SPEC.pdf` — garments, placement, method, and only the files in this package
- `separations/<location>-separations.pdf` — page 1 is a color composite and ink list; every later page is one ink, pure black and white, actual size, shared registration marks, with that ink’s name, swatch, nearest Pantone suggestion, and print order in the margin
- `separations/films/<location>/*-film.png` — 1-bit, 600 DPI film positives
- `README.txt` and `separations/README-SEPARATIONS.txt`

Ink names come from the colors in the art (Black, Gray, Green, Red, Teal, and so on). Dark garments get a white underbase choked about 1 point. Tonal areas are clustered-dot halftones around 50 LPI with offset screen angles.

Export sizes are in inches by default, in 0.25 in steps. Centimeters and pixels are a secondary toggle. Presets cover a name plate (3.75 in), left chest (3.5 in), full back (12 in), full front (12 in), youth back (10 in), sleeve (3 in), hat (4 in), and koozie/sticker (3 in). DPI can be 150, 200, 300, 600, or a custom value. The last choices are remembered in this browser. Image-tool downloads can be transparent PNG, JPG, SVG, or a PDF at actual size.

## Image tools

Open Image tools, then Background, Crop, Resize, Adjust, Colors, Trace, Text, or Trim. Each tool previews on the photo. Background removal can use the in-browser model (flood-fill if that model cannot load), a tolerance slider, tap-to-remove-color, an erase/restore brush with pinch-zoom, and an edge feather. Undo and redo keep the last few steps. Download uses the export size, or send the image into the first checked print location.

## Use it

```bash
npm install
npm run dev
```

The dev server uses the GitHub Pages base path, so open the `/print-shop-separator/` URL Vite prints.

`npm run build` writes `dist/` for GitHub Pages. `npm run build:native` writes a relative-path `dist/` for the Android and Windows shells. Pushing `main` runs `.github/workflows/pages.yml`, which publishes the site. Pages is already set to deploy from a workflow.

## Android and Windows

The same site is wrapped for sideloading:

- Android uses Capacitor. The camera prompt and ZIP share sheet are used when the page is running inside the app. CI builds a debug APK, `print-shop-separator.apk` (signed with the debug keystore, not a Play signing key).
- Windows uses Electron. CI builds an unsigned NSIS installer, `Print-Shop-Separator-Setup.exe`. The desktop shell asks where to save the ZIP and runs Real-ESRGAN with a larger tile.

`.github/workflows/native.yml` builds both on pull requests, on every push to `main`, and on tags `v*`. Pull requests and `main` keep the files as Actions artifacts. A tag such as `v1.0.0` also publishes them on the [Releases](https://github.com/geek4945-creator/print-shop-separator/releases) page.

Install notes:

- Android: download `print-shop-separator.apk`, allow install from unknown sources (or “Install unknown apps” for the browser), then open the file.
- Windows: download `Print-Shop-Separator-Setup.exe`. SmartScreen will say it is unrecognized because the installer is unsigned. Choose More info, then Run anyway.

## Limits

- Back art is upscaled with tiled Real-ESRGAN (`realesr-general-x4v3`) in ONNX Runtime Web: WebGPU when the browser has it, otherwise single-thread WASM. Phones use 128 px tiles and cap the long edge around 3000 px. The Android and Windows apps use larger tiles and up to a 4096 px edge. If the model cannot load, the app falls back to Lanczos. The matte runs after the upscale and defringes light edges so chrome picks up less of a white halo. It is still not identical to a desktop 4× pass that keeps the full-resolution buffer.
- Flat white or flat dark backgrounds are knocked out with the same flood-fill idea as that package (letter counters opened, whitewalls kept). Busy photos try a small in-browser removal model from a CDN and fall back to the flood-fill if the model cannot load.
- Film pages in the PDF are real 1-bit images at 600 DPI. On a phone, a 12 inch back print is a lot of pixels and can take a minute. Very large photos are scaled so the long edge is about 2200 px before the 300 DPI fit.
- Separations are a spot-color reading of a photograph. DTG or DTF still matches the original more closely.
