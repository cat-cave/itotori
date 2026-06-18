# Kaifuu Archive And Encryption Detection Matrix

KAIFUU-034 adds a core-owned detection matrix to the normal
`kaifuu detect` report. The matrix is a triage surface, not an adapter support
claim. It lets Kaifuu identify archive, encryption, protection, key, helper,
and unknown-variant signals before a real engine adapter exists.

The top-level detection report preserves the `gameDir` field for schema
stability, but its value is redacted so absolute local paths and private game
titles are not serialized.

The JSON report field is `archiveDetection`:

```json
{
  "schemaVersion": "0.1.0",
  "status": "matched",
  "evidencePolicy": "aggregate-only; no raw keys, helper dumps, decrypted text, local paths, or private source filenames are serialized",
  "rows": []
}
```

Each row contains:

- `rowId`: stable detector row id.
- `engineFamily`: normalized engine-family label.
- `detected`: whether aggregate evidence matched the row.
- `detectedVariant`: profiled variant label.
- `signals`: one or more of `encrypted`, `packed`, `protected`,
  `missing_key`, `helper_required`, or `unknown_variant`.
- `evidence`: aggregate pattern/count records only. Evidence uses patterns
  such as `*.xp3`, `Scene.pck`, `data/System.json encryption fields`, or
  `BURIKO ARC20 header`; it does not serialize concrete private filenames.
- `requirements`: file or secret requirements that a future adapter/helper
  would need. Secret requirements use placeholders and never raw keys.
- `diagnostics`: stable semantic codes with `requiredCapability`,
  `supportBoundary`, and `remediation`.
- `capabilities`: detection capability plus explicit unsupported extraction
  and patching when a packed or encrypted input is detected.

## Detector Rows

| Row id                             | Engine family   | Primary evidence                                                                                  | Signals reported when matched                                                                                                                                             |
| ---------------------------------- | --------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kirikiri-xp3`                     | KiriKiri/XP3    | `*.xp3`, XP3 magic, synthetic encrypted XP3 mark                                                  | `packed`; encrypted fixture marks add `encrypted`, `missing_key`, `helper_required`                                                                                       |
| `siglus-scene-pck`                 | SiglusEngine    | `Scene.pck`, `Gameexe.dat` aggregate presence                                                     | `packed`, `encrypted`, `missing_key`, `helper_required`                                                                                                                   |
| `rpg-maker-mv-mz-encrypted-assets` | RPG Maker MV/MZ | `*.rpgmvp`, `*.rpgmvm`, `*.rpgmvo`, `*.png_`, `*.m4a_`, `*.ogg_`, `System.json` encryption fields | `encrypted`; concrete media-key requirements can add `missing_key`; redacted candidate and bad-key cases are reported through requirements and diagnostics                |
| `wolf-rpg-editor-archives`         | Wolf RPG Editor | `*.wolf`, WOLF header, synthetic protection mark                                                  | `packed`, `encrypted`, `missing_key`, `helper_required`; protection marks add `protected`                                                                                 |
| `bgi-ethornell-containers`         | BGI/Ethornell   | `BURIKO ARC20` header                                                                             | `packed`, `unknown_variant`; encrypted/compressed marks add `encrypted` plus crypto-capability or layered-transform diagnostics until a concrete key requirement is known |
| `renpy-packed-inputs`              | Ren'Py          | `*.rpa`, `*.rpyc` aggregate counts                                                                | `packed`                                                                                                                                                                  |
| `unknown-archive-variant`          | Unknown         | Unprofiled archive-like extension counts                                                          | `unknown_variant`                                                                                                                                                         |

The matrix intentionally uses synthetic marker strings only for public tests
where real encryption/protection markers are not redistributable. Private-local
corpora can strengthen readiness through aggregate reports, but they must not
publish raw keys, helper dumps, decrypted text, local paths, or source
filenames.

## Semantic Diagnostics

Matrix diagnostics reuse Kaifuu capability codes:

- `kaifuu.unsupported_variant.encrypted`
- `kaifuu.unsupported_variant.packed`
- `kaifuu.protected_executable_unsupported`
- `kaifuu.missing_key_material`
- `kaifuu.invalid_key_material`
- `kaifuu.helper_unavailable`
- `kaifuu.unknown_engine_variant`
- `kaifuu.missing_capability.crypto`
- `kaifuu.unsupported_layered_transform`

These diagnostics block support overclaims. A row can say "this looks packed"
or "this requires key/helper evidence" without saying Kaifuu can unpack,
decrypt, decompile, patch, or rebuild that input.

RPG Maker MV/MZ encrypted asset detection distinguishes four key states:

- A concrete encrypted media surface with no usable key material reports a
  secret requirement plus `missing_key` and `kaifuu.missing_key_material`.
- A key candidate found in `System.json` or equivalent metadata is recorded as a
  redacted candidate reference in `requirements`; raw key bytes are never
  serialized in `signals`, `evidence`, or `diagnostics`.
- Present but malformed, wrong-length, or validation-failed key material reports
  bad-key diagnostics while preserving the concrete secret requirement.
- Unsupported surfaces, such as plugin-owned asset transforms or unknown media
  suffixes, report unsupported surface or layered-transform diagnostics instead
  of pretending the only problem is a missing key.

BGI/Ethornell encrypted or compressed containers must not emit
`missing_key_material` merely because bytes appear transformed. Until a concrete
variant proves a key is required, those rows should report an unknown variant,
missing crypto capability, or unsupported layered transform.
