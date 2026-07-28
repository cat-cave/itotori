# Localizing a RealLive corpus

This is the operator runbook for the shipped RealLive production path. It is
for a game the operator is entitled to modify, a read-only source tree, and a
new writable build directory outside this repository. Do not put retail bytes,
extracted text, provider credentials, or produced builds in the checkout.

The working path is:

```text
extract → structure-export → wiki + localize → final accepted outputs in Postgres
        → Studio “Produce patched build” → re-extract and verify
```

`localize` writes a redacted run summary, not a translated bridge. The summary
is deliberately not a patch input. The production patchback loader instead
loads the run's final accepted outputs from Postgres, decrypts them with the
same field key, re-materializes the bridge and structure from the configured
source tree, checks source hashes and complete scope coverage, and invokes the
native Kaifuu patcher. Studio's **Produce patched build** action calls
`POST /api/patchback/produce`, the owner of that path. It returns the playable
build as a tar archive.

## 1. Prepare the local machine and private paths

Build the exact native programs the wrapper will drive, then point this shell
at them. These commands are for a development checkout; an installed build
uses its provisioned native binaries instead.

```sh
cargo build -p kaifuu-cli -p utsushi-cli
export ITOTORI_KAIFUU_BIN="${CARGO_TARGET_DIR:-target}/debug/kaifuu-cli"
export ITOTORI_UTSUSHI_BIN="${CARGO_TARGET_DIR:-target}/debug/utsushi-cli"
```

Set `GAME_ROOT` to the directory that directly contains `REALLIVEDATA/`, and
set `RUN_DIR` to a new private directory outside the repository. A containing
download/extraction directory is accepted by `extract`, but it is **not** the
value to use for `structure-export`: that command needs
`$GAME_ROOT/REALLIVEDATA/Gameexe.ini` and `$GAME_ROOT/REALLIVEDATA/Seen.txt`.

## 2. Prepare a disposable database and credentials

Use a fresh, disposable Postgres database for this run. Migrate it before
creating the wiki or localization run. `DATABASE_URL` must name that database.

For that **fresh disposable database only**, create the field-cipher key with
the same deterministic 32-byte pattern used by the live-DB tests:

```sh
export ITOTORI_FIELD_CIPHER_KEY="$(node -e 'process.stdout.write(Buffer.alloc(32, 11).toString("base64"))')"
itotori db-migrate
```

This key encrypts durable wiki, memo, and accepted-output records. Do not use
this test key for an existing or retained database: changing its key makes its
previous encrypted rows unreadable. Do not put the key on the command line or
commit it.

The OpenRouter provider key lives only in the main checkout's gitignored
`.env`; it is never copied into a worktree, run directory, config artifact, or
database. From that main checkout, load it into the current shell without
printing it:

```sh
set -a
. ./.env
set +a
```

Before starting a production localization, supply the values the production
configuration actually reads: `ITOTORI_TARGET_LOCALE`,
`ITOTORI_DRAFT_SCHEMA_HASH`, `ITOTORI_DECODE_REVISION_HASH`,
`ITOTORI_GLOSSARY_REVISION_HASH`, `ITOTORI_STYLE_REVISION_HASH`,
`ITOTORI_LOCALIZE_MAX_ATTEMPT_EXPOSURE_USD`, and
`ITOTORI_LOCALIZE_COST_CAP_USD`. The three revision values are
`sha256:<64-lowercase-hex>` commitments for the approved run inputs; both cost
values are non-negative decimal USD amounts. `OPENROUTER_API_KEY` comes from
the main-checkout `.env` step above. These are required by the production
configuration; no additional project-prefixed variable is a substitute for
them.

## 3. Extract and derive structure

Run extraction first, then derive narrative structure from the exact bridge and
the direct RealLive root:

```sh
itotori extract --engine reallive --game-root "$GAME_ROOT" --game-id "$GAME_ID" --game-version "$GAME_VERSION" --source-profile-id "$SOURCE_PROFILE_ID" --source-locale ja-JP --whole-seen --bundle-output "$RUN_DIR/bridge.json"
itotori structure-export --engine reallive --gameexe "$GAME_ROOT/REALLIVEDATA/Gameexe.ini" --seen "$GAME_ROOT/REALLIVEDATA/Seen.txt" --bridge "$RUN_DIR/bridge.json" --output "$RUN_DIR/structure.json"
```

Use `--scene`, `--scenes`, or `--unit-range` only for a deliberately scoped
run. `--whole-seen` is the safe default for encrypted archives. A decompile
report with unknown opcodes is a decode gap; do not call the run complete.

At the next stage, build the source wiki and localize the same `bridge.json` +
`structure.json` under production policy. The required identities and paths are
shown by the installed command, which is the flag authority:

```sh
itotori localize --help
```

The localization run is eligible for production patchback only when every unit
in its selected output scope has a **final** accepted output, every accepted
output belongs to the run's localization snapshot, and every source hash still
matches the re-extracted source bytes. A redacted `run-summary.json` cannot be
fed to `patch` or `patch produce`.

## 4. Produce the persistent patched build

Use Studio's **Produce patched build** action for the completed run. It calls
the production accepted-output loader described above and returns a tar of a
new, writable game tree. Keep the source tree read-only. The returned receipt
and manifest bind the source, translated bridge, native apply, and patch target
by hash.

`itotori patch produce` is also a persistent-build command, but it is the
lower-level form for an already serialized `NativePatchbackInput`; its
`--input` is not `run-summary.json`. Use its help when an owning integration
has intentionally produced that input:

```sh
itotori patch produce --help
```

## 5. Verify the real bytes

Re-extract the patched tree and compare it with the source bridge. Report the
number of changed target units, unchanged unit texts, and protected spans
preserved byte-for-byte. The first production run patched two units through this
seam; re-extraction found 27,405 of 27,407 unit texts byte-identical and every
protected span byte-exact. Those counts are evidence for that run, not a
promise that another corpus or scope will have the same counts.

## Boundaries and failure meaning

- A missing provider key, field-cipher key, migration, final accepted output,
  or matching source hash is a configuration or integrity failure, not a
  successful no-op.
- The source data does contain the script text needed by the patcher. A missing
  final accepted output is an implementation/run-state gap, not a source-data
  limitation.
- A patch receipt proves persistent-build production. Runtime replay/render
  validation is a separate step; do not claim it from a successful tar alone.

## References

- [native dependency provisioning](native-deps-provisioning.md)
- [secure provider env files](secure-external-env-file.md)
- [private corpus policy](fixtures-and-corpora.md)
- [runtime fidelity policy](utsushi-fidelity-policy.md)
