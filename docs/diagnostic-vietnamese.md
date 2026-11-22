# Vietnamese BMW diagnostic descriptions

The Vietnamese `MGU Diagnostics` and `Fault Scanner` builds include a complete
lookup catalog for the bundled BMW diagnostic text database. This changes only
display text. It does not change diagnostic requests, fault clearing, database
contents, app IDs, or the vehicle connection flow.

## Coverage and review status

- Database SHA-256: `206da522f83c48539eb9ac0ee02d7c859a7080b0b1c50cf76df05451a3930c55`.
- 86,735 unique strings: 86,716 translated prose entries and 19 identifier-only
  entries kept verbatim. This covers this exact database version, not every BMW
  fault code or every database that might be installed on another vehicle.
- Translation runs locally, without a translation API, using Helsinki-NLP
  OPUS-MT English-to-Vietnamese at revision
  `989c9fb9ec63987901022baf0182dcec3e149be6`. The CTranslate2-converted model
  and SentencePiece files are used only by the offline generation tool; model
  weights are not included in the app package. The downloaded conversion
  archive SHA-256 is
  `6ca39bfc97410b3968434617f71af94d395df593002af52501bc4dbc2d511d80`.
- Common BMW terms are normalized and numeric literals and hexadecimal IDs are
  protected during inference. The catalog build rejects missing entries,
  untranslated prose, and lost numeric or hexadecimal tokens.
- The translations are machine generated and have not received individual
  human review. They can contain incorrect technical meaning or awkward wording.
  Do not use a translated fault description as a substitute for a BMW repair
  procedure or a qualified diagnosis.
- Unknown descriptions fall back to the original source text.

## Build

Normal app builds use the committed catalog and do not need the model or network:

```sh
python kit/tools/build_diagnostic_vi.py
python kit/tools/build.py --language vi mgu_diagnostics
python kit/tools/build.py --language vi dtc_scanner
```

To regenerate the catalog, install CTranslate2 and SentencePiece in a local
Python environment, download the pinned converted OPUS-MT model outside the
repository, then run `kit/tools/translate_diagnostic_vi.py` with `--model`,
`--checkpoint`, and `--output`. Checkpoints may be resumed and should be kept
outside Git. The model weights and checkpoints must not be committed.

The catalog and model provenance are recorded in
`kit/localization/diagnostic-full-vi-manifest.json`.
