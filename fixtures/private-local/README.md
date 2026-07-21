# Private-local path lane

`fixtures/private-local/` is the **path-only** lane for owned-game corpora.
Bodies (retail archives, `www/` trees, keys, decrypted text) are **never
committed**. The directory contents are git-ignored; only this contract README
is tracked.

## Layout

```txt
fixtures/private-local/<id>/
  …operator-local owned game tree (git-ignored)…
```

`<id>` is a logical corpus id chosen by the operator (lowercase
`[a-z0-9._-]` preferred). Put the RPG Maker MV/MZ game's `www/` root (or a
project root that contains `www/data/`) at that path, or point the CLI at any
local directory that holds the same layout.

## MV/MZ readiness report

```sh
# Emit the redacted, aggregate-only readiness summary to stdout (or --output).
cargo run -p kaifuu-cli -- rpg-maker readiness-report --game fixtures/private-local/<id>
```

(`kaifuu rpgmaker readiness-report` is an accepted alias.)

The command scans real local bytes and emits JSON whose top-level keys are
**exactly**:

| Key                          | Meaning                                                  |
| ---------------------------- | -------------------------------------------------------- |
| `spec`                       | Fixed report spec/version id                             |
| `assetSuffixHistogram`       | File counts by lowercase suffix (`json`, `rpgmvp`, …)    |
| `systemJsonHasEncryptionKey` | Boolean: non-empty `encryptionKey` in `data/System.json` |
| `mapTextSurfaceCounts`       | Map event-command text-surface counts by role            |
| `helperRequirements`         | Fixed helper tokens (`none` / `asset_encryption_key`)    |
| `aggregateDataHashSha256`    | One SHA-256 over all `data/*.json` bodies (sorted)       |

### Redaction contract

The report surface must **never** contain:

- project filenames or basenames
- full or relative filesystem paths
- `System.json.encryptionKey` key bytes (presence is boolean only)
- map dialogue / choice / comment text
- per-file content hashes (only the single aggregate data hash)

Absence of any private-local tree never fails public CI. Operators seed their
own owned games under this path; tests use synthetic trees and do not require
retail bytes.
