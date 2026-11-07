#!/usr/bin/env python3
"""Bake the digits of the speed-limit sign drawn by vietmap-signs (kit/vietmap-signs) from Inter Bold
(Pillow required).

python3 kit/tools/bake_sign_digits.py [path to Inter-Bold.otf]

Writes kit/vietmap-signs/digits.json: the digits 0-9 as 8-bit coverage masks at one height, each
deflated and base64-encoded, with the font's advance and the ink's offset, so the helper (Node 8, no
canvas) scales and draws them itself. Inter is under the SIL Open Font License
(kit/vietmap-signs/OFL-Inter.txt).
"""
import base64
import json
import os
import sys
import zlib

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'vietmap-signs', 'digits.json')
FONT = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/opentype/inter/Inter-Bold.otf'
PX = 160          # the font size the masks are drawn at


def main():
    font = ImageFont.truetype(FONT, PX)
    ascent, descent = font.getmetrics()
    # every digit in one box: the top of the tallest ink to the baseline
    boxes = {d: font.getbbox(d) for d in '0123456789'}
    top = min(b[1] for b in boxes.values())
    bottom = max(b[3] for b in boxes.values())
    h = bottom - top
    glyphs = {}
    for d in '0123456789':
        l, t, r, b = boxes[d]
        w = r - l
        img = Image.new('L', (w, h), 0)
        ImageDraw.Draw(img).text((-l, -top), d, font=font, fill=255)
        glyphs[d] = {
            'w': w,
            'adv': round(font.getlength(d), 2),
            'left': l,
            'data': base64.b64encode(zlib.compress(img.tobytes(), 9)).decode('ascii'),
        }
    out = {
        'font': 'Inter Bold (SIL Open Font License 1.1, OFL-Inter.txt)',
        'size': PX,
        'height': h,
        'glyphs': glyphs,
    }
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out, f, separators=(',', ':'))
        f.write('\n')
    print('%s: height %d, %d bytes' % (os.path.relpath(OUT), h, os.path.getsize(OUT)))


if __name__ == '__main__':
    main()
