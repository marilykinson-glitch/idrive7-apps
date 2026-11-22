#!/usr/bin/env python3
"""Load and audit the committed offline Vietnamese BMW diagnostic catalog."""
import json
from pathlib import Path
import re
import sys
from collections import Counter

from build_diagnostic_zh import database_strings, normalize

ROOT = Path(__file__).resolve().parents[2]
LOCALIZATION = ROOT / 'kit/localization'
NUMBER = re.compile(r'(?<![A-Za-z0-9_])\d+(?:\.\d+)*(?![A-Za-z0-9_])')
HEX = re.compile(r'0x[0-9A-Fa-f]+')
CODE = re.compile(r'(?<![A-Za-z0-9_])(?:[A-Z]{2,}[A-Z0-9]*(?:[-_/][A-Z0-9]+)*|[A-Z][0-9]+)(?![A-Za-z0-9_])')


def catalog():
    path = LOCALIZATION / 'diagnostic-full.vi.json'
    if not path.is_file():
        raise FileNotFoundError('Missing complete Vietnamese catalog: ' + str(path))
    values = json.loads(path.read_text(encoding='utf-8'))
    texts = database_strings()
    missing = texts - values.keys()
    if missing:
        raise ValueError('Vietnamese diagnostic catalog is missing %d source strings' % len(missing))
    zh_values = json.loads((LOCALIZATION/'diagnostic-full.zh-CN.json').read_text(encoding='utf-8'))
    identifiers = {s for s in texts if zh_values.get(s) == s}
    if len(identifiers) != 19:
        raise ValueError('Expected 19 identifier-only source entries, found %d' % len(identifiers))
    for source in texts:
        target = values[source]
        if not isinstance(target, str) or not target.strip():
            raise ValueError('Empty Vietnamese translation: ' + source)
        if source not in identifiers and target == source:
            raise ValueError('Untranslated prose entry: ' + source)
        if not set(HEX.findall(source)).issubset(set(HEX.findall(target))):
            raise ValueError('Hex identifier lost: ' + source)
        if not set(CODE.findall(source)).issubset(set(CODE.findall(target))):
            raise ValueError('Control-unit acronym lost: ' + source)
        if Counter(NUMBER.findall(source)) - Counter(NUMBER.findall(target)):
            raise ValueError('Numeric literal lost: ' + source)
    # The diagnostic display normalizes German diacritics before lookup.
    for source, target in list(values.items()):
        values.setdefault(normalize(source), target)
    return values


if __name__ == '__main__':
    try:
        result = catalog()
        print('Vietnamese diagnostic catalog ready: %d keys' % len(result))
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
