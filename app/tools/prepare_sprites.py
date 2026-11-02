"""Конвертирует исходные PNG Курису в лёгкие webp для приложения.

Использование: python tools/prepare_sprites.py [папка_с_png] [масштаб]
Имена: CRS_<A|B|J><L|M|S><поза>_t64_d<эмоция>_<рот>.png
"""
import os
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "..", "restored")
SCALE = float(sys.argv[2]) if len(sys.argv) > 2 else 0.6
DST = os.path.join(HERE, "..", "assets", "sprites")
os.makedirs(DST, exist_ok=True)

done = 0
for name in sorted(os.listdir(SRC)):
    if not name.lower().endswith(".png"):
        continue
    out = os.path.join(DST, name[:-4].replace("_t64", "") + ".webp")
    if os.path.exists(out):
        continue
    im = Image.open(os.path.join(SRC, name)).convert("RGBA")
    im = im.resize((round(im.width * SCALE), round(im.height * SCALE)), Image.LANCZOS)
    im.save(out, "WEBP", quality=90, method=5)
    done += 1
print(f"converted {done} sprites -> {os.path.normpath(DST)}")
