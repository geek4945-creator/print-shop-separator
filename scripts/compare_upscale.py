"""Before/after crops: Lanczos vs realesr-general-x4v3 on the sample logo."""

import numpy as np
import onnxruntime as ort
from PIL import Image

SRC = "/home/ubuntu/.cursor/projects/workspace/uploads/source-original_649f.jpg"
MODEL = "/workspace/public/models/realesr-general-x4v3.onnx"
OUT = "/tmp/upscale-compare"
BOX = (1480, 640, 1720, 880)  # front wheel / spokes


def lanczos(im, scale):
    return im.resize((im.width * scale, im.height * scale), Image.Resampling.LANCZOS)


def esrgan(im):
    arr = np.asarray(im, np.float32) / 255.0
    inp = arr.transpose(2, 0, 1)[None]
    sess = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])
    out = sess.run(None, {"input": inp})[0][0]
    rgb = np.clip(out.transpose(1, 2, 0) * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(rgb, "RGB")


def side_by_side(images, labels):
    w = sum(im.width for im in images)
    h = max(im.height for im in images) + 28
    canvas = Image.new("RGB", (w, h), (18, 18, 20))
    x = 0
    for im in images:
        canvas.paste(im, (x, 28))
        x += im.width
    return canvas


def main():
    import os

    os.makedirs(OUT, exist_ok=True)
    src = Image.open(SRC).convert("RGB")
    crop = src.crop(BOX)
    crop.save(f"{OUT}/source-crop.png")
    near = lanczos(crop, 4)
    near.save(f"{OUT}/lanczos-4x.png")
    print("running esrgan", crop.size, flush=True)
    sharp = esrgan(crop)
    sharp.save(f"{OUT}/esrgan-4x.png")
    # What the phone path keeps: 4x then down toward ~1.5x of the source crop.
    phone = sharp.resize((crop.width * 2, crop.height * 2), Image.Resampling.LANCZOS)
    lanczos2 = lanczos(crop, 2)
    pair = side_by_side([lanczos2, phone], ["lanczos", "esrgan"])
    pair.save(f"{OUT}/before-after-2x.png")
    # A tighter spoke crop from the 4x results.
    spoke = (40 * 4, 30 * 4, 160 * 4, 150 * 4)
    side_by_side(
        [near.crop(spoke).resize((360, 360), Image.Resampling.NEAREST), sharp.crop(spoke).resize((360, 360), Image.Resampling.NEAREST)],
        ["lanczos", "esrgan"],
    ).save(f"{OUT}/spokes.png")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
