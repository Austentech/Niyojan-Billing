"""Analyze and process the Niyojan Corporation logo.

Reads the uploaded 2000x2000 logo (mark on the left, wordmark on the right),
splits it into the standalone mark and the full lockup, and writes optimized
assets into public/brand without altering the logo artwork itself (pure crop +
resize only).
"""
from PIL import Image

SRC = "/home/z/my-project/upload/6.png"
OUT = "/home/z/my-project/public/brand"

img = Image.open(SRC).convert("RGB")
W, H = img.size
print("source:", img.size)

# Column-wise "ink" density: count pixels that are not near-white per column.
gray = img.convert("L")
px = gray.load()
TH = 245  # near-white threshold
col_ink = []
for x in range(W):
    c = 0
    for y in range(0, H, 4):  # sample every 4th row for speed
        if px[x, y] < TH:
            c += 1
    col_ink.append(c)

# Find overall content bounds
ink_cols = [x for x, c in enumerate(col_ink) if c > 0]
left, right = min(ink_cols), max(ink_cols)
print("content columns:", left, right)

# Find the largest horizontal white gap inside the content to split mark/wordmark
gap_start, gap_len = None, 0
run = 0
for x in range(left, right + 1):
    if col_ink[x] == 0:
        run += 1
        if run > gap_len:
            gap_len = run
            gap_start = x - run + 1
    else:
        run = 0
print("largest gap:", gap_start, "len:", gap_len)

split = gap_start + gap_len // 2

# Row bounds for each part
def row_bounds(x0, x1):
    top, bottom = None, None
    for y in range(H):
        row_has = any(px[x, y] < TH for x in range(x0, x1, 8))
        if row_has:
            if top is None:
                top = y
            bottom = y
    return top, bottom

mark_top, mark_bottom = row_bounds(left, split)
print("mark rows:", mark_top, mark_bottom)

# Mark: crop with small padding, keep white background (logo is light-bg asset)
pad = int((right - left) * 0.015) + 6
mark = img.crop((max(0, left - pad), max(0, mark_top - pad),
                 min(W, split - 6), min(H, mark_bottom + pad)))
mark_w = mark.size[0]
# Square-ish canvas with white background so it displays cleanly everywhere
side = max(mark.size)
sq = Image.new("RGB", (side, side), (255, 255, 255))
sq.paste(mark, ((side - mark.size[0]) // 2, (side - mark.size[1]) // 2))
sq = sq.resize((512, 512), Image.LANCZOS)
sq.save(f"{OUT}/logo-mark.png", optimize=True)
print("mark:", sq.size)

# Full lockup: content area + balanced padding, white background
full_top, full_bottom = row_bounds(left, right)
pad_x = int((right - left) * 0.03)
pad_y = int((full_bottom - full_top) * 0.06)
full = img.crop((max(0, left - pad_x), max(0, full_top - pad_y),
                 min(W, right + pad_x), min(H, full_bottom + pad_y)))
fw, fh = full.size
scale = 1000 / fw
full = full.resize((1000, int(fh * scale)), Image.LANCZOS)
full.save(f"{OUT}/logo-full.png", optimize=True)
print("full:", full.size)

import os
for f in ("logo-mark.png", "logo-full.png"):
    p = f"{OUT}/{f}"
    print(f, os.path.getsize(p) // 1024, "KB")
