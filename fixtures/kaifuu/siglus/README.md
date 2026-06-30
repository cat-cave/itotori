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
