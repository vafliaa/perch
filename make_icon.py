from PIL import Image, ImageDraw, ImageFilter
import os, math

OUT = os.path.join(os.path.dirname(__file__), 'assets')
os.makedirs(OUT, exist_ok=True)

S = 1024
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

# soft outer shadow
shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
sd.rounded_rectangle((52, 66, S - 52, S - 46), radius=224, fill=(0, 0, 0, 150))
shadow = shadow.filter(ImageFilter.GaussianBlur(46))
img = Image.alpha_composite(img, shadow)

# rounded plate
plate = Image.new('RGBA', (S, S), (0, 0, 0, 0))
pd = ImageDraw.Draw(plate)
pd.rounded_rectangle((64, 64, S - 64, S - 64), radius=220, fill=(18, 14, 11, 255))
img = Image.alpha_composite(img, plate)

# vertical warm background gradient inside plate
grad = Image.new('RGBA', (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
for y in range(64, S - 64):
    t = (y - 64) / (S - 128)
    r = int(32 - 18 * t)
    g = int(24 - 15 * t)
    b = int(19 - 12 * t)
    gd.line([(64, y), (S - 64, y)], fill=(r, g, b, 255))
mask = Image.new('L', (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle((64, 64, S - 64, S - 64), radius=220, fill=255)
img.paste(grad, (0, 0), mask)

# warm glow behind the mark
glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
gld = ImageDraw.Draw(glow)
gld.ellipse((190, 150, 700, 660), fill=(224, 138, 95, 110))
glow = glow.filter(ImageFilter.GaussianBlur(110))
img = Image.alpha_composite(img, glow)

# pixel sun mask
sun_mask = Image.new('L', (S, S), 0)
sm = ImageDraw.Draw(sun_mask)
# each row of the pixel sun, scaled to 1024
rows = [
    (190, 382, 236),
    (162, 410, 218),
    (118, 454, 274),
    (162, 410, 220),
    (190, 382, 238),
]
# top and bottom rounded pixel steps
for x1, x2, y in [(318, 384, 238), (300, 400, 264), (276, 424, 300)]:
    pass
# simpler stepped rows
steps = [
    (318, 384, 230, 52),
    (286, 416, 282, 52),
    (250, 452, 334, 52),
    (230, 472, 386, 52),
    (250, 452, 438, 52),
    (286, 416, 490, 52),
    (318, 384, 542, 52),
]
for x1, x2, y, h in steps:
    sm.rectangle((x1, y, x2, y + h), fill=255)

sun_grad = Image.new('RGBA', (S, S), (0, 0, 0, 0))
sgd = ImageDraw.Draw(sun_grad)
for y in range(230, 594):
    t = (y - 230) / 364
    r = int(255 - 45 * t)
    g = int(201 - 80 * t)
    b = int(155 - 75 * t)
    sgd.line([(100, y), (S - 100, y)], fill=(r, g, b, 255))
img.paste(sun_grad, (0, 0), sun_mask)

# notch bite
bite = Image.new('RGBA', (S, S), (0, 0, 0, 0))
bd = ImageDraw.Draw(bite)
bd.ellipse((430, 320, 610, 500), fill=(19, 15, 12, 255))
img = Image.alpha_composite(img, bite)

# small pixel stars
pixels = [(700, 300, 18), (748, 360, 12), (668, 238, 11), (736, 232, 8), (684, 392, 8)]
for x, y, s in pixels:
    star = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    sd2 = ImageDraw.Draw(star)
    sd2.rectangle((x, y, x + s, y + s), fill=(255, 217, 184, 210))
    img = Image.alpha_composite(img, star)

# inner highlight border
border = Image.new('RGBA', (S, S), (0, 0, 0, 0))
brd = ImageDraw.Draw(border)
brd.rounded_rectangle((64, 64, S - 64, S - 64), radius=220, outline=(255, 255, 255, 26), width=3)
img = Image.alpha_composite(img, border)

# save pngs
master = img.crop((40, 40, S - 40, S - 40))
master.save(os.path.join(OUT, 'icon.png'))
for size in (256, 128, 64, 48, 32, 16):
    master.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f'icon-{size}.png'))

# tray icon: tighter crop and transparent margin
tray = master.resize((128, 128), Image.LANCZOS)
tcanvas = Image.new('RGBA', (160, 160), (0, 0, 0, 0))
tcanvas.alpha_composite(tray, (16, 16))
tcanvas.save(os.path.join(OUT, 'tray.png'))

print('icon assets written to', OUT)
