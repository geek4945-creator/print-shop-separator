# Print Shop Separator

A phone-friendly site that turns a logo or photo into a print-shop package, entirely in the browser. Nothing is uploaded.

Open it at [https://geek4945-creator.github.io/print-shop-separator/](https://geek4945-creator.github.io/print-shop-separator/) after the Pages workflow on `main` finishes.

## What you get

A ZIP with the same breakdown as a hand-built shop package:

- `back/back-print.png` and `back/back-print.pdf` — transparent art at the chosen width, 300 DPI, with pHYs metadata, and a PDF at actual size
- `chest/<name>-chest.png` plus `.svg` and `.pdf` — the chest name in a chrome script (Kaushan Script, SIL Open Font License)
- `chest/<name>-chest-from-source.png` when the source has a mark in the usual chest-logo position
- `mockups/` — crewneck and tee, front and back, in the chosen color and size
- `PRINT-SPEC.pdf` — garments, placement, method, and the file list
- `separations/back-separations.pdf` and `separations/chest-separations.pdf` — page 1 is a color composite and ink list; every later page is one ink, pure black and white, actual size, shared registration marks, with the ink name, swatch, Pantone suggestion, and print order in the margin
- `separations/films/<location>/*-film.png` — 1-bit, 600 DPI film positives
- `README.txt` and `separations/README-SEPARATIONS.txt`

Dark garments get a white underbase choked about 1 point. Chrome and teal are clustered-dot halftones around 50 LPI with offset screen angles.

## Use it

```bash
npm install
npm run dev
```

The dev server uses the GitHub Pages base path, so open the `/print-shop-separator/` URL Vite prints.

`npm run build` writes `dist/`. Pushing `main` runs `.github/workflows/pages.yml`, which publishes that folder. Pages is already set to deploy from a workflow.

## Limits

- The back art is enlarged with Lanczos resampling and a light sharpen. It is not the desktop Real-ESRGAN (`realesr-general-x4v3`) pass the original Python package used, so fine spokes and hairline type are a bit softer.
- Flat white or flat dark backgrounds are knocked out with the same flood-fill idea as that package (letter counters opened, whitewalls kept). Busy photos try a small in-browser removal model from a CDN and fall back to the flood-fill if the model cannot load.
- Film pages in the PDF are real 1-bit images at 600 DPI. On a phone, a 12 inch back print is a lot of pixels and can take a minute. Very large photos are scaled so the long edge is about 2200 px before the 300 DPI fit.
- Separations are a spot-color reading of a photograph. DTG or DTF still matches the original more closely.
