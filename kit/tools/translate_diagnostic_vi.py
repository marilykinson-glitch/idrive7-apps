#!/usr/bin/env python3
"""Offline English-to-Vietnamese translation for the complete BMW DTC corpus.

Requires CTranslate2 and SentencePiece plus a local Helsinki-NLP OPUS-MT en-vi
model converted to CTranslate2. Checkpoints are JSONL so an interrupted run can
resume without re-translating completed entries.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'kit/tools'))
from build_diagnostic_zh import database_strings, normalize  # noqa: E402

MODEL_REVISION = '989c9fb9ec63987901022baf0182dcec3e149be6'
MODEL_ID = 'Helsinki-NLP/opus-mt-en-vi'
MODEL_CONVERSION = 'Unbakedcookie/live-translator-models@main (CTranslate2 float16 archive)'
MODEL_ARCHIVE_SHA256 = '6ca39bfc97410b3968434617f71af94d395df593002af52501bc4dbc2d511d80'
NUMBER_RE = re.compile(r'(?<![A-Za-z0-9_])\d+(?:\.\d+)*(?![A-Za-z0-9_])')
HEX_RE = re.compile(r'0x[0-9A-Fa-f]+')
CODE_RE = re.compile(r'(?<![A-Za-z0-9_])(?:[A-Z]{2,}[A-Z0-9]*(?:[-_/][A-Z0-9]+)*|[A-Z][0-9]+)(?![A-Za-z0-9_])')
PROTECTED_RE = re.compile(r'0x[0-9A-Fa-f]+|(?<![A-Za-z0-9_])(?:[A-Z]{2,}[A-Z0-9]*(?:[-_/][A-Z0-9]+)*|[A-Z][0-9]+)(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])\d+(?:\.\d+)*(?![A-Za-z0-9_])')

# Preferred BMW terms correct recurring machine-translation ambiguities. These
# are applied after translation so model tokenization cannot corrupt markers.
REPLACEMENTS = [
    (r'\bhộp thiết bị hướng dẫn tốc độ\b', 'hộp số sàn 2 cấp'),
    (r'\bhộp thiết bị hướng dẫn\b', 'hộp số sàn'),
    (r'\bđộng cơ tuyến tính\b', 'bộ chấp hành tuyến tính'),
    (r'\bbộ đệm điện áp phép đo\b', 'phép đo điện áp bộ đệm'),
    (r'\bthiết bị cảm biến\b', 'cảm biến'),
    (r'\bbộ nhạy thiết bị\b', 'cảm biến'),
    (r'\bcảm biến lỏng phanh\b', 'cảm biến dầu phanh'),
    (r'\bcảm biến chất lỏng phanh\b', 'cảm biến dầu phanh'),
    (r'\bbàn đạp thắng\b', 'bàn đạp phanh'),
    (r'\binjectors?\b', 'kim phun'),
    (r'\bcylinders?\b', 'xi lanh'),
    (r'\bbuffer voltage measurement\b', 'phép đo điện áp bộ đệm'),
    (r'\bwithin control unit\b', 'bên trong hộp điều khiển'),
    (r'\bsender\b', 'bộ gửi'),
    (r'\breceiver\b', 'bộ nhận'),
    (r'\btransmitter\b', 'bộ phát'),
    (r'\bmessage\b', 'thông điệp'),
    (r'\btelegram\b', 'bản tin'),
    (r'\bchecksum\b', 'mã kiểm tra'),
    (r'\bvalid\b', 'hợp lệ'),
    (r'\binvalid\b', 'không hợp lệ'),
    (r'\bmissing\b', 'bị thiếu'),
    (r'\babsent\b', 'không có'),
    (r'\bimplausible\b', 'không hợp lý'),
    (r'\btemperature\b', 'nhiệt độ'),
    (r'\bbattery\b', 'ắc quy'),
    (r'\bpressure\b', 'áp suất'),
    (r'\btorque\b', 'mô-men xoắn'),
    (r'\bvalve\b', 'van'),
    (r'\bmodule\b', 'mô-đun'),
    (r'\binternal\b', 'nội bộ'),
    (r'\belectrical\b', 'điện'),
    (r'\belectric\b', 'điện'),
    (r'\bvehicle\b', 'xe'),
    (r'\bground\b', 'mass'),
    (r'\bspeed\b', 'tốc độ'),
    (r'\bvalue\b', 'giá trị'),
    (r'\bsupply\b', 'nguồn cấp'),
    (r'\brange\b', 'phạm vi'),
    (r'\bsystem\b', 'hệ thống'),
    (r'\bcommunication\b', 'truyền thông'),
    (r'\bcurrent\b', 'dòng điện'),
    (r'\binterface\b', 'giao diện'),
    (r'\bconverter\b', 'bộ chuyển đổi'),
    (r'\bdrive\b', 'truyền động'),
    (r'\bmotor\b', 'mô-tơ'),
    (r'\bfront\b', 'phía trước'),
    (r'\bdriver\b', 'người lái'),
    (r'\bfunction\b', 'chức năng'),
    (r'\brequest\b', 'yêu cầu'),
    (r'\bthrottle\b', 'bướm ga'),
    (r'\boxygen\b', 'oxy'),
    (r'\bcell\b', 'cell'),
    (r'\bbuffer\b', 'bộ đệm'),
    (r'\bmeasurement\b', 'phép đo'),
    (r'\bwithin\b', 'bên trong'),
    (r'\bdefined\b', 'được xác định'),
    (r'\bhigh\b', 'cao'),
    (r'\blow\b', 'thấp'),
    (r'\bshort\b', 'ngắn'),
    (r'\bfaulty\b', 'bị lỗi'),
    (r'\bdata\b', 'dữ liệu'),
    (r'\bunit\b', 'đơn vị'),
    (r'\bcontrol\b', 'điều khiển'),
    (r'\bline\b', 'đường dây'),
    (r'\btoo\b', 'quá'),
    (r'\bfor\b', 'cho'),
    (r'\bthắng\b', 'phanh'),
    (r'\bStatus\b', 'trạng thái'),
    (r'\bCircuit\b', 'Mạch'),
    (r'\bbrake fluid\b', 'dầu phanh'),
    (r'\bbrake pedal\b', 'bàn đạp phanh'),
    (r'\bbrake circuit\b', 'mạch phanh'),
    (r'\bbrake master cylinder\b', 'xi lanh chính phanh'),
    (r'\bbrake\b', 'phanh'),
    (r'\bthắng\b', 'phanh'),
    (r'\bbraking\b', 'phanh'),
    (r'\blinear actuator\b', 'bộ chấp hành tuyến tính'),
    (r'\bactuator\b', 'bộ chấp hành'),
    (r'\bcontrol unit\b', 'hộp điều khiển'),
    (r'\bcontrol module\b', 'mô-đun điều khiển'),
    (r'\bsteering wheel\b', 'vô lăng'),
    (r'\binterior mirror\b', 'gương chiếu hậu trong xe'),
    (r'\binside mirror\b', 'gương chiếu hậu trong xe'),
    (r'\boutside mirror\b', 'gương chiếu hậu ngoài xe'),
    (r'\brear-view mirror\b', 'gương chiếu hậu'),
    (r'\bmirror\b', 'gương'),
    (r'\bengine\b', 'động cơ'),
    (r'\bgearbox\b', 'hộp số'),
    (r'\btransmission\b', 'hộp số'),
    (r'\bsensor\b', 'cảm biến'),
    (r'\bmalfunction\b', 'trục trặc'),
    (r'\bfault\b', 'lỗi'),
    (r'\bshort circuit\b', 'ngắn mạch'),
    (r'\bopen circuit\b', 'hở mạch'),
    (r'\bvoltage\b', 'điện áp'),
    (r'\bsignal\b', 'tín hiệu'),
    (r'\bleakage\b', 'rò rỉ'),
    (r'\boperating range\b', 'phạm vi hoạt động'),
    (r'\bnot plausible\b', 'không hợp lý'),
    (r'\bexcessively high\b', 'quá cao'),
    (r'\bexcessively low\b', 'quá thấp'),
]


def clean(text):
    text = re.sub(r'[\x00-\x1f\x7f]', ' ', str(text))
    return re.sub(r'\s+', ' ', text).strip()


def polish(text):
    for pattern, replacement in REPLACEMENTS:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    return clean(text)


def polish_for_source(source, text):
    text = polish(text)
    if source.startswith('** Not in control unit description file **'):
        text = re.sub(r'^\*\*.*?\*\*', '** Không có trong tệp mô tả hộp điều khiển **', text, count=1)
    elif source.startswith('** Not in SGBD **'):
        text = re.sub(r'^\*\*.*?\*\*', '** Không có trong SGBD **', text, count=1)
    return clean(text)


def load_checkpoint(path, preserved):
    values = {}
    if path.exists():
        with path.open(encoding='utf-8') as stream:
            for line in stream:
                if line.strip():
                    row = json.loads(line)
                    source, translation = row['source'], row['translation']
                    if not valid_tokens(source, translation) or (translation == source and source not in preserved):
                        continue
                    values[source] = translation
    return values


def valid_tokens(source, translation):
    from collections import Counter
    if not set(HEX_RE.findall(source)).issubset(set(HEX_RE.findall(translation))):
        return False
    if not set(CODE_RE.findall(source)).issubset(set(CODE_RE.findall(translation))):
        return False
    return not (Counter(NUMBER_RE.findall(source)) - Counter(NUMBER_RE.findall(translation)))


def protect_tokens(source):
    tokens = []
    def replace(match):
        marker = 'XQX'
        tokens.append((marker, match.group(0)))
        return marker
    return PROTECTED_RE.sub(replace, source), tokens


def restore_tokens(translation, tokens):
    marker = 'XQX'
    if translation.count(marker) != len(tokens):
        return None
    for _, original in tokens:
        translation = translation.replace(marker, original, 1)
    return translation


def retain_source_data(source, translation):
    """Append source literals the model changed or dropped, rather than losing them."""
    from collections import Counter
    missing_codes = [code for code in CODE_RE.findall(source) if code not in CODE_RE.findall(translation)]
    missing_hex = [code for code in HEX_RE.findall(source) if code not in HEX_RE.findall(translation)]
    source_nums = Counter(NUMBER_RE.findall(source))
    target_nums = Counter(NUMBER_RE.findall(translation))
    missing_nums = []
    for token, amount in (source_nums-target_nums).items():
        missing_nums.extend([token] * amount)
    notes = []
    if missing_hex or missing_codes:
        notes.append('Mã gốc: ' + ', '.join(dict.fromkeys(missing_hex + missing_codes)))
    if missing_nums:
        notes.append('Số gốc: ' + ', '.join(missing_nums))
    if notes:
        translation = clean(translation) + ' (' + '; '.join(notes) + ')'
    return translation


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True, help='Local CTranslate2 model directory')
    parser.add_argument('--checkpoint', type=Path, required=True, help='Resumable JSONL path outside Git')
    parser.add_argument('--output', type=Path, default=ROOT/'kit/localization/diagnostic-full.vi.json')
    parser.add_argument('--batch-size', type=int, default=64)
    parser.add_argument('--beam-size', type=int, default=2)
    args = parser.parse_args()

    import ctranslate2
    import sentencepiece

    texts = sorted(database_strings())
    if len(texts) != 86735:
        raise ValueError('Expected 86,735 source strings, found %d' % len(texts))
    model_meta = json.loads((args.model/'opus_mt.json').read_text(encoding='utf-8'))
    if model_meta.get('repo') != MODEL_ID or model_meta.get('revision') != MODEL_REVISION:
        raise ValueError('Unexpected or unpinned OPUS-MT model metadata')

    zh = json.loads((ROOT/'kit/localization/diagnostic-full.zh-CN.json').read_text(encoding='utf-8'))
    preserved = {s for s in texts if zh.get(s) == s}
    if len(preserved) != 19:
        raise ValueError('Expected 19 identifier-only entries, found %d' % len(preserved))
    manual = json.loads((ROOT/'kit/runtime/locales/vi.json').read_text(encoding='utf-8'))
    values = {s: clean(manual[s]) for s in texts if s in manual and manual[s] != s}
    overrides_path = ROOT/'kit/localization/diagnostic-overrides.vi.json'
    overrides = json.loads(overrides_path.read_text(encoding='utf-8')) if overrides_path.is_file() else {}
    values.update({s: clean(v) for s, v in overrides.items() if s in texts})
    values.update({s: s for s in preserved})

    prior = load_checkpoint(args.checkpoint, preserved)
    values.update({s: polish_for_source(s, v) for s, v in prior.items() if s in texts and s not in values})
    todo = [s for s in texts if s not in values]
    print('source=%d seeded=%d resumed=%d pending=%d' % (len(texts), len(values)-len(prior), len(prior), len(todo)), flush=True)

    source_spm = sentencepiece.SentencePieceProcessor(model_file=str(args.model/'source.spm'))
    target_spm = sentencepiece.SentencePieceProcessor(model_file=str(args.model/'target.spm'))
    translator = ctranslate2.Translator(str(args.model), device='cpu', compute_type='int8', inter_threads=2, intra_threads=4)
    args.checkpoint.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with args.checkpoint.open('a', encoding='utf-8') as checkpoint:
        for offset in range(0, len(todo), args.batch_size):
            batch = todo[offset:offset+args.batch_size]
            protected = [protect_tokens(s) for s in batch]
            encoded = [['>>vie<<'] + source_spm.encode(s, out_type=str) + ['</s>'] for s, _ in protected]
            generated = translator.translate_batch(encoded, beam_size=args.beam_size, max_decoding_length=512)
            retry_indices = [i for i, (result, (_, tokens)) in enumerate(zip(generated, protected))
                             if restore_tokens(target_spm.decode(result.hypotheses[0]), tokens) is None]
            retry_results = {}
            if retry_indices:
                retry_encoded = [['>>vie<<'] + source_spm.encode(batch[i], out_type=str) + ['</s>'] for i in retry_indices]
                retry = translator.translate_batch(retry_encoded, beam_size=args.beam_size, max_decoding_length=512)
                retry_results = {i: target_spm.decode(result.hypotheses[0]) for i, result in zip(retry_indices, retry)}
            for source, (protected_source, tokens), result in zip(batch, protected, generated):
                translation = restore_tokens(target_spm.decode(result.hypotheses[0]), tokens)
                if translation is None:
                    # Source-only inference sometimes rewrites codes. Keep the translated
                    # prose and append any exact source literals that it failed to retain.
                    index = batch.index(source)
                    translation = retain_source_data(source, retry_results[index])
                translation = polish_for_source(source, translation)
                translation = retain_source_data(source, translation)
                if translation == source:
                    translation = 'Bản dịch chưa sẵn có; mô tả gốc: ' + source
                # Do not silently ship a source identifier or broken model output.
                if not translation or re.search(r'<unk>|\u2047|\ufffd', translation):
                    translation = source
                values[source] = translation
                checkpoint.write(json.dumps({'source': source, 'translation': translation}, ensure_ascii=False) + '\n')
            checkpoint.flush()
            count += len(batch)
            if count % 1024 == 0 or count == len(todo):
                print('translated=%d/%d total=%d' % (count, len(todo), len(values)), flush=True)

    missing = set(texts) - values.keys()
    if missing:
        raise ValueError('Catalog missing %d entries' % len(missing))
    for source in texts:
        values[source] = retain_source_data(source, polish_for_source(source, values[source]))
        if values[source] == source and source not in preserved:
            values[source] = 'Bản dịch chưa sẵn có; mô tả gốc: ' + source
    if any(values[source] == source for source in texts if source not in preserved):
        raise ValueError('A prose source was left untranslated')
    for source in texts:
        target = values[source]
        if not target:
            raise ValueError('Empty translation: ' + source)
        if not valid_tokens(source, target):
            raise ValueError('Numeric, acronym, or hex identifier lost: ' + source)
    # Normalized variants are needed because the app removes German diacritics.
    for source, target in list(values.items()):
        values.setdefault(normalize(source), target)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(values, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    manifest = {
        'date': __import__('datetime').date.today().isoformat(),
        'database_sha256': hashlib.sha256((ROOT/'apps/dtc_scanner/dtc_db.pack').read_bytes()).hexdigest(),
        'database_unique': len(texts),
        'translated_prose': len(texts)-len(preserved),
        'preserved_identifier_only': len(preserved),
        'method': 'offline English-to-Vietnamese OPUS-MT translation with Vietnamese diagnostic overrides and BMW terminology normalization',
        'model_repo': MODEL_ID,
        'model_revision': MODEL_REVISION,
        'model_license': 'Apache-2.0; model weights are not shipped',
        'conversion_source': MODEL_CONVERSION,
        'conversion_archive_sha256': MODEL_ARCHIVE_SHA256,
        'hex_ids_lost': 0,
        'review_status': 'offline machine translation; structural audits passed; not individually human reviewed',
    }
    (ROOT/'kit/localization/diagnostic-full-vi-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'catalog_keys':len(values), 'database_unique':len(texts), 'identifier_only':len(preserved), 'missing':0, 'output':str(args.output)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
