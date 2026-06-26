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

## Negative fixtures

Negative fixtures under `negative/` intentionally trip blocking
diagnostics so the proof command surfaces a failed `status` without
claiming extract or patch-back:

| Negative fixture                     | Expected diagnostic                     |
| ------------------------------------ | --------------------------------------- |
| `xp3-missing-crypt-profile.json`     | `xp3.crypt_profile.missing` (P0)        |
| `xp3-unknown-encryption-plugin.json` | `xp3.crypt_profile.unknown_plugin` (P0) |
| `xp3-leaked-archive-path.json`       | `xp3.archive_path.leaked` (P0)          |
