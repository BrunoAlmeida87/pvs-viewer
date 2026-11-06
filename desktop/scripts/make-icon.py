"""Draws the app icon (same design as viewer/icon.svg) into build/icon.png and build/icon.ico.
Usage: python scripts/make-icon.py   (needs Pillow)"""
import math
import os

from PIL import Image, ImageDraw

S = 1024  # drawn at 1024 px, saved smaller (smooth edges)
k = S / 64


def P(x, y):
    return (x * k, y * k)


img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
# rounded square with a diagonal blue gradient
grad = Image.new("RGBA", (S, S))
gd = ImageDraw.Draw(grad)
a, b = (0x3B, 0x82, 0xF6), (0x1E, 0x3A, 0x8A)
for i in range(2 * S):
    t = i / (2 * S)
    c = tuple(int(a[j] + (b[j] - a[j]) * t) for j in range(3))
    gd.line([(i, 0), (0, i)], fill=c + (255,), width=2)
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([2 * k, 2 * k, 62 * k, 62 * k], radius=14 * k, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
w = int(3.2 * k)
top, right, bot, left, mid, peak = P(32, 11), P(50, 21.4), P(32, 52.6), P(14, 42.2), P(32, 31.8), P(14, 21.4)
r2 = P(50, 42.2)
# lighter top face
face = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(face).polygon([mid, right, top, peak], fill=(255, 255, 255, 56))
img = Image.alpha_composite(img, face)
d = ImageDraw.Draw(img)
outline = [top, right, r2, bot, left, peak, top]
d.line(outline, fill="white", width=w, joint="curve")
for p in (right, bot, peak):
    d.line([mid, p], fill="white", width=w)
for p in outline + [mid]:
    d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill="white")
# orange dot
cx, cy, r = 46 * k, 46 * k, 7 * k
d.ellipse([cx - r - 1.2 * k, cy - r - 1.2 * k, cx + r + 1.2 * k, cy + r + 1.2 * k], fill="white")
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(0xF9, 0x73, 0x16, 255))

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build")
os.makedirs(out, exist_ok=True)
img.resize((512, 512), Image.LANCZOS).save(os.path.join(out, "icon.png"))
img.resize((256, 256), Image.LANCZOS).save(os.path.join(out, "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("ícone gravado em", os.path.abspath(out))
