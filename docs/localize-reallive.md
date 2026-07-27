# Localizing a RealLive corpus

This is the operator runbook for the currently shipped RealLive surfaces. It
deliberately distinguishes working commands from interfaces that are present in
design notes but not exposed by the current CLI. Do not infer an end-to-end
success from a command that merely exits zero.

The observed, runnable front door currently ends after structure export:

```text
extract → structure-export
```

`localize-game` does not exist. Use `itotori <command> --help` before a run for
that command's required flags; the checked source parsers remain the authority.

## Before touching private bytes

Use a read-only source tree and a private run directory outside the repository.
Before every real-byte run, rebuild the two native binaries and make the CLI
use those builds. This avoids drawing conclusions from an old extractor or
runtime binary.

```sh
cargo build -p kaifuu-cli -p utsushi-cli
export ITOTORI_KAIFUU_BIN="${CARGO_TARGET_DIR:-target}/debug/kaifuu-cli"
export ITOTORI_UTSUSHI_BIN="${CARGO_TARGET_DIR:-target}/debug/utsushi-cli"

just doctor
```

For a live draft, also configure the database, an OpenRouter key, and the
required run configuration. `itotori init` writes the local configuration and
`itotori db-migrate` applies the schema. A missing provider key fails loudly;
there is no fake-provider fallback.

The private-manifest library has a single `ITOTORI_REAL_CORPUS_ROOT` setting,
but the installed `itotori extract` command does not currently expose registry
lookup. For the command flow below, provide `--game-root` directly (or the
legacy `ITOTORI_REAL_GAME_ROOT` fallback). Do not invent a registry flag or
per-engine environment variable for a live run.

## Extract

The RealLive extractor requires identity metadata, an output path, a source,
and exactly one supported scope:

```sh
itotori extract --engine reallive \
  --game-root <read-only-game-root> \
  --game-id <id> --game-version <version> \
  --source-profile-id <profile> --source-locale <locale> \
  --whole-seen --bundle-output <run-dir>/bridge.json
```

Use `--scene <0..65535>` for one scene, `--scenes <N,N,...>` for a selected
set, or `--unit-range <START:END>` for an archive-order unit interval (end
exclusive). Each scoped bridge carries a bound `sourceScope`; the subsequent
structure export preserves it, so localize can consume a small run without
mistaking it for a whole archive. The alternate source is
`--vault-canonical-id <id>`; it and `--game-root` are mutually exclusive.
`--decompile-report-output <path>` is optional.

Whole-archive extraction is also the safe default for encrypted archives: the
decoder can recover supported cross-scene encryption only after it sees the
archive. If a decompile report records unknown opcodes, treat it as a decode
gap; do not continue as if the bridge were complete.

## Structure export

Build structure from the bridge and the source's actual engine files:

```sh
itotori structure-export --engine reallive \
  --gameexe <game-root>/REALLIVEDATA/Gameexe.ini \
  --seen <game-root>/REALLIVEDATA/Seen.txt \
  --bridge <run-dir>/bridge.json \
  --output <run-dir>/structure.json
```

`--entry-scene <n>` selects a non-default entry point; `--max-scenes <n>`
fails rather than silently truncating the archive.

## The current stop: encrypted live state and patch handoff

After a successful extract and structure export, both `wiki build` and
`localize` refuse before work begins unless Postgres has been migrated and the
existing `ITOTORI_FIELD_CIPHER_KEY` is set to a base64-encoded 256-bit key. The
key is an operator-provisioned secret for durable encrypted records; do not put
it on the command line, print it, or commit it.

This checkout has not produced a localized bridge or patch from the public CLI
on a real corpus. Even if the live wiki/localize prerequisites are supplied,
`localize` writes a redacted run summary rather than the translated BridgeBundle
that `patch` accepts. The CLI does not export the required accepted-output
`NativePatchbackInput` either. This is an implementation gap, not a limitation
of the source data. Obtain that input from the owning integration; do not pass
`run-summary.json` to `itotori patch` or claim the archive-to-patch route works.

## Real-byte gates

`just ci` is synthetic and is not real-byte evidence. Use
`just ci-real-bytes` for the strict staged-corpus lane, or
`just real-bytes-oracle` for the periodic full oracle. Both must fail when a
required corpus is absent; the first diagnostic to check is whether the lane
ran zero tests. A zero-test success is a coverage failure, not a pass.

Do not commit source bytes, extracted text, private manifests, screenshots, or
private render output. Keep roots and reports local, and use aggregate hashes
and counts for shareable evidence.

## Known boundaries

- The corpus-manifest registry exists as an internal validation surface, but is
  not a selector on the installed extract command.
- The localizer's summary cannot be patched directly; no CLI export currently
  bridges its durable accepted outputs to `patch produce` input.

These are implementation gaps, not source-data limitations. Report them with
the command, binary revision, and output artifact rather than guessing a flag
or fabricating an end-to-end success.

## References

- [native dependency provisioning](native-deps-provisioning.md)
- [private corpus policy](fixtures-and-corpora.md)
- [real-byte oracle](real-bytes-periodic-oracle.md)
- [runtime fidelity policy](utsushi-fidelity-policy.md)
