#!/usr/bin/env python3
"""Bake the Vietnamese glyph atlases from the Inter font (Pillow required).

python3 kit/tools/bake_vietnamese.py [folder with Inter-Regular.otf and Inter-Bold.otf]

Writes kit/localization/fonts/vietnamese.json and vietnamese-bold.json, which Vietnamese builds
(build.py --language vi) ship; fonts.js draws a line in them when it has Vietnamese letters, so the
whole line is one font. The glyphs are condensed horizontally to sit closer to the kit's Ubuntu
width 85. Every Vietnamese letter is baked (upper and lower case, all tones), plus the kit's
TEXT and whatever else the catalog uses. The generated atlases are committed; normal builds need no
Pillow or font.
"""
import base64
import hashlib
import importlib.util
import json
import sys
import unicodedata
import zlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SIZES = (24, 48)
CONDENSE = 0.92
OUT = ROOT / 'kit/localization/fonts'


def vietnamese_letters():
    vowels = 'aăâeêioôơuưy'
    tones = ['', '̀', '́', '̉', '̃', '̣']
    out = set('đĐ')
    for v in vowels:
        for t in tones:
            ch = unicodedata.normalize('NFC', v + t)
            out.update([ch, ch.upper()])
    return out


def bake(path, size, charset):
    font = ImageFont.truetype(str(path), size)
    ascent, descent = font.getmetrics()
    imgs = []
    for ch in charset:
        try:
            bbox = font.getbbox(ch, anchor='ls')
        except Exception:
            continue
        adv = font.getlength(ch) * CONDENSE
        w, h = max(0, bbox[2] - bbox[0]), max(0, bbox[3] - bbox[1])
        im = None
        if w and h:
            im = Image.new('L', (w, h), 0)
            ImageDraw.Draw(im).text((-bbox[0], -bbox[1]), ch, font=font, fill=255, anchor='ls')
            im = im.resize((max(1, round(w * CONDENSE)), h), Image.LANCZOS)
        imgs.append((ch, im, (round(bbox[0] * CONDENSE), bbox[1]), adv))
    W = 1024
    x = y = rowh = 0
    place = {}
    for ch, im, _, _ in imgs:
        if im is None:
            place[ch] = (0, 0, 0, 0)
            continue
        if x + im.width > W:
            x, y, rowh = 0, y + rowh + 1, 0
        place[ch] = (x, y, im.width, im.height)
        x += im.width + 1
        rowh = max(rowh, im.height)
    H = y + rowh + 1
    atlas = Image.new('L', (W, H), 0)
    glyphs = {}
    for ch, im, (ox, oy), adv in imgs:
        px, py, pw, ph = place[ch]
        if im is not None:
            atlas.paste(im, (px, py))
        glyphs[ord(ch)] = [px, py, pw, ph, ox, oy, round(adv, 2)]
    return {'size': size, 'ascent': ascent, 'descent': descent, 'atlasW': W, 'atlasH': H,
            'alpha': base64.b64encode(zlib.compress(atlas.tobytes(), 9)).decode(), 'glyphs': glyphs}


def main():
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/usr/share/fonts/opentype/inter')
    spec = importlib.util.spec_from_file_location('bake_fonts', HERE / 'bake_fonts.py')
    baker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(baker)
    words = json.loads((ROOT / 'kit/runtime/locales/vi.json').read_text(encoding='utf-8'))
    text = baker.TEXT + ''.join(words.values())
    chars = set(text) | set(text.upper()) | set(text.lower()) | vietnamese_letters()
    chars = ''.join(sorted(c for c in chars if c.isprintable()))
    for family, file in (('vietnamese', 'Inter-Regular.otf'), ('vietnamese-bold', 'Inter-Bold.otf')):
        path = folder / file
        if not path.is_file():
            raise SystemExit('%s not found; pass the folder with Inter-Regular.otf and Inter-Bold.otf' % path)
        sizes = [bake(path, s, chars) for s in SIZES]
        if sum(s['atlasH'] for s in sizes) > 2048:
            raise SystemExit(family + ' atlases exceed their GPU budget')
        key = hashlib.sha256(json.dumps(sizes, separators=(',', ':')).encode()).hexdigest()[:16]
        data = {'family': family, 'source': 'Inter %s (SIL Open Font License 1.1, OFL-Inter.txt)' % file, 'cacheKey': key, 'sizes': sizes}
        out = OUT / (family + '.json')
        out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
        print('%s: %d glyphs, %s px atlases, %d bytes' % (family, len(chars), [s['atlasH'] for s in sizes], out.stat().st_size))


if __name__ == '__main__':
    main()
