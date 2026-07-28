# Siglus fixtures (KAIFUU-069 static-key, KAIFUU-070 known-key smoke)

## KAIFUU-015 — synthetic profile-proof composition

`synthetic-profile.json` drives `kaifuu siglus profile-proof --fixture
fixtures/kaifuu/siglus/synthetic-profile.json --out <report.json>`, which
COMPOSES four already-built Siglus slices into one honestly-scoped, redacted
proof report over a **synthetic** profile:

- the **detector** slice (`SiglusProfileDetectorAdapter`) over
  `fixtures/public/kaifuu-encrypted-matrix/raw/siglus` → detector evidence;
- the **key-boundary** slice (KAIFUU-070 known-key `secretRef`, surfaced through
  the parser-boundary key-refs) → key-profile id;
- the **parser-boundary** slice
  (`run_siglus_known_key_parser_boundary_smoke`) → parser-profile id + outcome;
- the **redacted validation** slice (KAIFUU-105 compat-profile validator over
  `../compat-profile/siglus.extract.tuple.json`) → capability-level honesty.

The report records detector evidence, key-profile id, parser-profile id,
capability level, and a redaction summary. **Honest scope:** it claims **no**
broad commercial Siglus compatibility — the real Scene.pck/Gameexe.dat
decrypt/extract/repack core is `NotImplemented`, so the capability level is
capped at `known-key-extract` and `broadCommercialClaim` is always `false`.
Before the artifact is written it is **deep-scanned** (KAIFUU-036/094): a seeded
raw key, helper dump, private path, or decrypted private text makes the command
fail loud and persist nothing.

## KAIFUU-070 — known-key Scene/Gameexe extract-patch-verify smoke

`siglus-knownkey-smoke.json` drives a **narrow, honestly-scoped** known-key
smoke (`kaifuu_siglus::run_known_key_smoke_from_fixture`): for one declared
profile it extracts profiled `Scene`/`Gameexe` text + metadata, applies a
trivial translated patch, and verifies the round-trip. It is **NOT** broad
Siglus support — the real `Scene.pck`/`Gameexe.dat` constant-256-XOR-table +
per-game second-layer strip and proprietary-LZSS codec stay skeleton stubs
(siglus-04/siglus-06).

- **Profiled synthetic, no retail bytes.** The `synthetic-stub` container
  sources materialise a clearly-fake `Scene`/`Gameexe` container in-process,
  masked with a clearly-fake constant known key (`KSIG-SMOKE-KEY01`). The
  optional `{ "local-file": { "path": "…" } }` source reads scoped local bytes
  in-process (never shelled out to); the committed fixture uses `synthetic-stub`.
- **Known key stays redacted.** The raw key lives only in a module-private,
  zeroize-on-drop, `Debug`-redacting holder — never serialized, logged, or
  written to disk. The report carries the structured `secretRef`
  (`local-secret:siglus-secondary-key`, shared with the KAIFUU-069 key) + a
  one-way sha256 commitment + the key length; no extracted or translated text
  (only sha256 digests).
- **Out-of-profile is typed not-implemented.** A container flagged with the
  out-of-profile proprietary-LZSS compression is refused with
  `kaifuu.siglus.known_key_smoke.out_of_profile_compression_not_implemented`,
  never a silent pass.

---

# Siglus static-key helper fixtures (KAIFUU-069)

Fixtures for `kaifuu siglus static-key --fixture
fixtures/kaifuu/siglus/siglus-static-key.json`, the in-process Siglus
static-key discovery adapter.

## No retail bytes

There are **no committed executable or `Gameexe.dat` binaries** here. Every
scenario is materialised in-process by the synthetic _fixture stub helper_
(`kaifuu_core::build_siglus_static_key_stub`) from clearly-fake in-module
constants — no retail game bytes, no real keys, no extracted scripts, no
helper dumps, no private paths. The synthetic key is `SIGLUSXORKEY0123` and the
`Gameexe.dat` known-plaintext header is the synthetic magic
`SIGLUS_GAMEEXE_PROFILE_V1`.

## Manifest

`siglus-static-key.json` drives one entry per scenario. Each entry names a
`stub` scenario (public CI) — or, for a scoped local run, `executable` +
`gameexe` paths the adapter reads in-process (never shelled out). It declares
the structured `secretRef` to publish and the `expected` outcome the validator
confirms against the evidence.

| Entry                             | Stub                                  | Expected outcome       |
| --------------------------------- | ------------------------------------- | ---------------------- |
| `static-key-valid`                | `valid`                               | `validated`            |
| `static-key-wrong-key`            | `wrong_key`                           | `validation_failed`    |
| `static-key-unsupported-packer`   | `unsupported_packer`                  | `unsupported_packer`   |
| `static-key-protected-executable` | `protected_executable`                | `protected_executable` |
| `static-key-no-key-region`        | `key_region_missing`                  | `key_region_not_found` |
| `static-key-helper-mismatch`      | `valid` + non-static `declaredHelper` | `helper_mismatch`      |

## Validate before consume

A `secretRef` is published as a consumable key-ref **only** for the
`validated` entry, whose recovered candidate reproduced the `Gameexe.dat`
known-plaintext header. Every other entry publishes no key-ref and carries a
structured finding. The report records secret-refs + proof hashes (sha256
commitments / counts) only — never raw key bytes.
