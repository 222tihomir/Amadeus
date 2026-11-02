"""Готовит корпус телефона и кадры логотипа из текстур игры (phone.dds).

Использование: python tools/make_phone.py [путь_к_phone.dds]
Результат: assets/ui/phone.webp (экран вырезан прозрачным), assets/ui/phone.json (границы экрана),
           assets/ui/logo_anim/NN.webp (кадры сборки логотипа), assets/ui/screen_bg.webp.
"""
import json
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else r"C:\zapret-discord-youtube-1.10.3\system\phone.dds"
UI = os.path.join(HERE, "..", "assets", "ui")

atlas = Image.open(SRC).convert("RGBA")

# ── корпус: левая часть атласа ──
box = atlas.getchannel("A").crop((0, 0, 800, 1200)).getbbox()
phone = atlas.crop(box)
W, H = phone.size

# Экран — тёмный прямоугольник. Идём от центра к краям, пока пиксели тёмные: это его границы.
px = phone.load()
dark = lambda p: p[3] > 250 and max(p[:3]) < 45  # noqa: E731


def edge(x, y, dx, dy):
    while 0 <= x + dx < W and 0 <= y + dy < H and dark(px[x + dx, y + dy]):
        x, y = x + dx, y + dy
    return x, y


rows = [int(H * f) for f in (0.3, 0.5, 0.7)]
cols = [int(W * f) for f in (0.25, 0.4, 0.6)]  # в стороне от динамика и кнопки «домой»
sx0 = max(edge(W // 2, y, -1, 0)[0] for y in rows)
sx1 = min(edge(W // 2, y, 1, 0)[0] for y in rows) + 1
sy0 = max(edge(x, H // 2, 0, -1)[1] for x in cols)
sy1 = min(edge(x, H // 2, 0, 1)[1] for x in cols) + 1
mask = Image.new("L", phone.size, 0)
ImageDraw.Draw(mask).rectangle((sx0, sy0, sx1 - 1, sy1 - 1), fill=255)
alpha = phone.getchannel("A")
alpha.paste(0, mask=mask)
phone.putalpha(alpha)

scale = 0.75
out = phone.resize((round(W * scale), round(H * scale)), Image.LANCZOS)
out.save(os.path.join(UI, "phone.webp"), "WEBP", quality=92)
geom = {
    "width": out.width, "height": out.height,
    # границы экрана в долях от размера картинки
    "screen": {"left": sx0 / W, "top": sy0 / H, "right": 1 - sx1 / W, "bottom": 1 - sy1 / H},
}
with open(os.path.join(UI, "phone.json"), "w", encoding="utf-8") as f:
    json.dump(geom, f, indent=1)
print("phone", out.size, geom["screen"])

# ── фон экрана (градиент) ──
bg_box = atlas.getchannel("A").crop((880, 0, 1360, 780)).getbbox()
if bg_box:
    bg = atlas.crop((880 + bg_box[0], bg_box[1], 880 + bg_box[2], bg_box[3]))
    bg.save(os.path.join(UI, "screen_bg.webp"), "WEBP", quality=90)
    print("screen_bg", bg.size)

# ── кадры сборки логотипа: сетка справа (7 столбцов) ──
frames_dir = os.path.join(UI, "logo_anim")
os.makedirs(frames_dir, exist_ok=True)
grid = atlas.crop((1360, 0, 3072, 1536))
a = grid.getchannel("A")
cols, cell_w, cell_h = 7, (3072 - 1360) // 7, 1536 // 6
n = 0
for r in range(6):
    for c in range(cols):
        cell = grid.crop((c * cell_w, r * cell_h, (c + 1) * cell_w, (r + 1) * cell_h))
        opaque = sum(1 for v in cell.getchannel("A").getdata() if v > 40)
        if opaque < 30:  # пустые ячейки и одиночные пиксели
            continue
        cell.save(os.path.join(frames_dir, f"{n:02d}.webp"), "WEBP", quality=90)
        n += 1
print("logo frames", n, (cell_w, cell_h))
