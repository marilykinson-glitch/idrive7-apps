#!/usr/bin/env python3
"""Bake the digit templates vietmap-signs reads the centre screen's speed sign with (Pillow required).

python3 kit/tools/bake_sign_templates.py

Writes kit/vietmap-signs/digit-templates.json: the digits 0-9 of a few bold sans faces (the sign's
digits on CarPlay and Android Auto are drawn in one like them), each cropped to its ink and scaled
to TW x TH (ink 255), base64, with the ink's width / height. The reader matches a digit against all
of them and takes the best.
"""
import base64
import json
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'vietmap-signs', 'digit-templates.json')
TW, TH = 24, 32
FONTS = [
    ('Inter Bold', '/usr/share/fonts/opentype/inter/Inter-Bold.otf'),
    ('Inter SemiBold', '/usr/share/fonts/opentype/inter/Inter-SemiBold.otf'),
    ('Liberation Sans Bold', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'),
    ('DejaVu Sans Bold', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'),
    ('DejaVu Sans Condensed Bold', '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf'),
]


def glyph(font, d):
    img = Image.new('L', (200, 200), 0)
    ImageDraw.Draw(img).text((40, 20), d, font=font, fill=255)
    box = img.getbbox()
    ink = img.crop(box)
    return ink.resize((TW, TH), Image.BILINEAR), box[2] - box[0], box[3] - box[1]


def main():
    faces = []
    for name, path in FONTS:
        if not os.path.exists(path):
            print('skipped (not here):', name)
            continue
        font = ImageFont.truetype(path, 120)
        digits = {}
        for d in '0123456789':
            g, w, h = glyph(font, d)
            digits[d] = {'aspect': round(w / h, 4), 'data': base64.b64encode(g.tobytes()).decode('ascii')}
        faces.append({'name': name, 'digits': digits})
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        json.dump({'w': TW, 'h': TH, 'faces': faces}, f, separators=(',', ':'))
        f.write('\n')
    print('%s: %d faces, %d bytes' % (os.path.relpath(OUT), len(faces), os.path.getsize(OUT)))


if __name__ == '__main__':
    main()
