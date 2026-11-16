import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { describeColor, extractChannels } from "./separate.js";

function blocks(colors, size = 20) {
  const w = size * colors.length;
  const h = size;
  const rgba = new Uint8ClampedArray(w * h * 4);
  colors.forEach((color, index) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * w + index * size + x) * 4;
        rgba[i] = color[0];
        rgba[i + 1] = color[1];
        rgba[i + 2] = color[2];
        rgba[i + 3] = 255;
      }
    }
  });
  return { rgba, w, h, size };
}

function meanOnBlock(cov, w, block, size) {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      sum += cov[y * w + block * size + x];
      count++;
    }
  }
  return sum / count;
}

test("describeColor names known swatches", () => {
  const cases = [
    [[220, 20, 30], "Red"],
    [[20, 170, 40], "Green"],
    [[20, 40, 200], "Blue"],
    [[40, 170, 165], "Teal"],
    [[15, 15, 15], "Black"],
    [[140, 140, 145], "Gray / Silver"],
    [[245, 245, 245], "White"],
    [[255, 140, 0], "Orange"],
    [[250, 220, 0], "Yellow"],
    [[180, 30, 170], "Magenta"],
    [[90, 20, 180], "Purple"],
  ];
  for (const [rgb, short] of cases) {
    const named = describeColor(...rgb);
    assert.equal(named.short, short, `${rgb} named ${named.short}`);
  }
});

test("multi-color art gets distinct ink names and plates", async () => {
  const colors = [
    [220, 20, 30],
    [20, 170, 40],
    [20, 40, 200],
    [40, 170, 165],
    [15, 15, 15],
    [140, 140, 145],
    [245, 245, 245],
  ];
  const image = blocks(colors);
  const { channels } = await extractChannels(image.rgba, image.w, image.h, "back", {
    inkCount: "auto",
    darkGarment: true,
  });
  const shorts = channels.map((channel) => channel.short);
  assert.ok(!shorts.every((name) => /teal/i.test(name)), `all teal: ${shorts.join(", ")}`);
  for (const expected of ["Red", "Green", "Blue", "Teal", "Black", "Gray"]) {
    assert.ok(
      shorts.some((name) => name.toLowerCase().includes(expected.toLowerCase())),
      `${expected} missing from ${shorts.join(", ")}`,
    );
  }
  assert.ok(shorts.some((name) => /underbase|white/i.test(name)));
  const colorChannels = channels.filter((channel) => channel.key !== "underbase");
  for (let i = 0; i < colors.length; i++) {
    const named = describeColor(...colors[i]);
    if (/white/i.test(named.short)) continue;
    const plate = colorChannels.find((channel) => channel.short.toLowerCase().includes(named.short.toLowerCase().split(" ")[0]));
    assert.ok(plate, `no plate for ${named.short}`);
    const own = meanOnBlock(plate.coverage, image.w, i, image.size);
    for (const other of colorChannels) {
      if (other === plate) continue;
      const foreign = meanOnBlock(other.coverage, image.w, i, image.size);
      assert.ok(own > foreign + 40, `${named.short} plate ${own.toFixed(0)} vs ${other.short} ${foreign.toFixed(0)}`);
    }
  }
});

test("a red field is not labeled teal", async () => {
  const image = blocks([[210, 16, 24]]);
  const { channels } = await extractChannels(image.rgba, image.w, image.h, "front", {
    inkCount: "auto",
    darkGarment: true,
  });
  const shorts = channels.map((channel) => channel.short);
  assert.ok(shorts.some((name) => /red/i.test(name)), shorts.join(", "));
  assert.ok(!shorts.some((name) => /^teal$/i.test(name)), shorts.join(", "));
});

test("Harley source, when present, keeps teal as one ink among others", async (t) => {
  const path = "/home/ubuntu/.cursor/projects/workspace/uploads/source-original_649f.jpg";
  if (!existsSync(path)) {
    t.skip("Metal Art by Stu source image is not in this checkout");
    return;
  }
  const jpeg = await import("jpeg-js");
  const { readFileSync } = await import("node:fs");
  const raw = jpeg.default.decode(readFileSync(path), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
  const { channels } = await extractChannels(raw.data, raw.width, raw.height, "back", {
    inkCount: "auto",
    darkGarment: true,
  });
  const shorts = channels.map((channel) => channel.short);
  assert.ok(shorts.some((name) => /teal/i.test(name)), shorts.join(", "));
  assert.ok(!shorts.every((name) => /teal/i.test(name)), shorts.join(", "));
});
