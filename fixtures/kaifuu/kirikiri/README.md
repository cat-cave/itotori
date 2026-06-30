# KiriKiri XP3 profile-proof fixtures (KAIFUU-038)

Fixtures for the `kaifuu xp3 profile-proof` command. Plain XP3 is the
**only** variant for which detect / extract / patch-back is a claimed
capability. Encrypted, helper-required, and protected-executable cases
are routing diagnostics — the command emits a redacted proof report and
makes no extract or patch-back claim for them.

## Archives

All `.xp3` archives are synthetic, fixture-only byte strings that
exercise the KAIFUU-095 detector routing without retail game bytes,
extracted scripts, screenshots, audio, fonts, video, helper dumps,
private paths, or private keys. The plain archive is byte-identical to
`fixtures/public/kaifuu-encrypted-matrix/xp3-profiles/plain/data.xp3`.

| Archive                    | Variant                             |
| -------------------------- | ----------------------------------- |
| `plain.xp3`                | plain XP3 (claimed-support concern) |
| `encrypted.xp3`            | encrypted XP3 (routing only)        |
| `helper-required.xp3`      | helper-required XP3 (routing only)  |
| `protected-executable.bin` | unsupported protected executable    |

## Fixtures

| Fixture                                 | Expected classification            | Patch capability |
| --------------------------------------- | ---------------------------------- | ---------------- |
| `xp3-profile.json`                      | `plain`                            | `patch_back`     |
| `xp3-encrypted-profile.json`            | `encrypted`                        | `unsupported`    |
| `xp3-helper-required-profile.json`      | `helper_required`                  | `unsupported`    |
| `xp3-protected-executable-profile.json` | `unsupported_protected_executable` | `unsupported`    |

## Capability profile (KAIFUU-054)

`xp3-capability-profile.json` is the aggregate **capability-profile manifest**
consumed by `kaifuu xp3 capability-profile --fixture
fixtures/kaifuu/kirikiri/xp3-capability-profile.json`. It is **generated** —
never hand-authored — from the detector proof fixtures above, the KAIFUU-085
key/helper results, the crypt-profile routing taxonomy, and the archive bytes.
Each entry's capability tuple is recomputed from that evidence; the manifest's
declared `expected` block only drives structured validation findings.

THE LINE is mechanical, not prose: only **plain** XP3 enters the `claimed`
tier (detect + extract + patch-back). Encrypted, helper-required,
protected-executable, and universal-dump entries are `research`-tier routing
diagnostics that can never advertise a patch-back claim. Plaintext `.ks`
(`plain-script.ks`) is the `null_container` special case, explicitly **not**
the commercial KiriKiri baseline.

| Entry                         | Variant                | Support tier     |
| ----------------------------- | ---------------------- | ---------------- |
| `plaintext-ks-null-container` | `plaintext_ks`         | `null_container` |
| `plain-xp3`                   | `plain_xp3`            | `claimed`        |
| `encrypted-xp3`               | `encrypted_xp3`        | `research`       |
| `helper-required-xp3`         | `helper_required_xp3`  | `research`       |
| `protected-executable`        | `protected_executable` | `research`       |
| `universal-dump`              | `universal_dump`       | `research`       |

The generated report carries only counts and hashes (never raw archive bytes,
keys, helper dumps, decrypted text, private archive names, or local paths). The
validator emits structured findings — never a panic — on bad detector evidence,
helper-requirement / keyRef-state / archive-hash mismatches, a patch-capability
tuple mismatch, or a non-plain variant declaring a patch claim.

## Negative fixtures

Negative fixtures under `negative/` intentionally trip blocking
diagnostics so the proof command surfaces a failed `status` without
claiming extract or patch-back:

| Negative fixture                     | Expected diagnostic                     |
| ------------------------------------ | --------------------------------------- |
| `xp3-missing-crypt-profile.json`     | `xp3.crypt_profile.missing` (P0)        |
| `xp3-unknown-encryption-plugin.json` | `xp3.crypt_profile.unknown_plugin` (P0) |
| `xp3-leaked-archive-path.json`       | `xp3.archive_path.leaked` (P0)          |

## Plain XP3 read/write smoke (KAIFUU-071)

`plain-xp3.json` is the fixture consumed by `kaifuu xp3 plain-smoke --fixture
fixtures/kaifuu/kirikiri/plain-xp3.json --out artifacts/kaifuu/plain-xp3-smoke.json`.
It points at the shared `plain.xp3` archive (file table, one compressed member,
directory-style member ids, and a non-text `image/title.png` asset) and declares
the expected member ids, sizes, compression state, per-member payload hashes,
and counts. The command inventories the archive through
`read_plain_xp3_inventory` and deterministically rebuilds it through
`read_plain_xp3_archive` + `encode_xp3` (the shared reader/writer path), proving
a **byte-identical** rebuild (or a documented manifest-equivalence fallback).
The report carries member hashes, member table offsets, compression state, and
the output hash — counts/hashes/in-archive member ids only, never archive bytes
or local paths. It needs no encryption key and no private corpus.

The two negative archives are deterministic, synthetic plain-XP3 byte strings
(reproduced byte-for-byte by the `kaifuu-core` `plain_xp3_smoke` regression
tests). Each must fail **before any rebuild byte** is produced:

| Negative fixture (under `negative/`)        | Failure kind               | Cites                                  |
| ------------------------------------------- | -------------------------- | -------------------------------------- |
| `plain-xp3-malformed-table.xp3`             | `malformed_table`          | `kaifuu.plain_xp3_smoke.malformed_table` (overrun file-table index) |
| `plain-xp3-unsupported-member-flags.xp3`    | `unsupported_member_flags` | member id `scenario/flagged.ks` (segment flag `0x4` outside the supported set) |
