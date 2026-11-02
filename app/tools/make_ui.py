"""Вырезает логотип Amadeus из экрана логина и делает иконку из спрайта."""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.join(HERE, "..", "assets", "ui")
SPR = os.path.join(HERE, "..", "assets", "sprites")

login = Image.open(os.path.join(UI, "login.webp")).convert("RGB")
# Прозрачность по «оранжевости» (R-B): серый фон с цифрами исчезает, логотип остаётся.
logo = login.crop((625, 125, 1290, 585)).convert("RGBA")
px = logo.load()
for y in range(logo.height):
    for x in range(logo.width):
        r, g, b, _ = px[x, y]
        px[x, y] = (r, g, b, max(0, min(255, (r - b - 25) * 4)))
logo.save(os.path.join(UI, "logo.webp"), "WEBP", quality=92)

face = Image.open(os.path.join(SPR, "CRS_JLD_d2_0.webp")).convert("RGBA")
w, h = face.size
side = int(w * 0.5)
x0, y0 = (w - side) // 2, int(h * 0.09)
icon = face.crop((x0, y0, x0 + side, y0 + side)).resize((256, 256), Image.LANCZOS)
bg = Image.new("RGBA", icon.size, (140, 20, 24, 255))
bg.alpha_composite(icon)
bg.save(os.path.join(UI, "icon.png"))
bg.save(os.path.join(UI, "icon.ico"), sizes=[(256, 256), (64, 64), (32, 32), (16, 16)])
print("ok")
