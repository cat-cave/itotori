# Localizing a RealLive corpus

This is the operator runbook for the currently shipped RealLive surfaces. It
deliberately distinguishes working commands from interfaces that are present in
design notes but not exposed by the current CLI. Do not infer an end-to-end
success from a command that merely exits zero.

The current front door is a sequence of separate commands:

```text
extract → structure-export → wiki build → localize → patch / validate
```

`localize-game` does not exist. `itotori --help` lists the top-level commands;
the checked source parsers and native `--help` are the flag authority.

## Before touching private bytes

Use a read-only source tree and a private run directory outside the repository.
Before every real-byte run, rebuild the two native binaries and make the CLI
use those builds. This avoids drawing conclusions from an old extractor or
runtime binary.

```sh
cargo build --release -p kaifuu-cli -p utsushi-cli
export ITOTORI_KAIFUU_BIN="${CARGO_TARGET_DIR:-target}/release/kaifuu-cli"
export ITOTORI_UTSUSHI_BIN="${CARGO_TARGET_DIR:-target}/release/utsushi-cli"

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

Replace `--whole-seen` with `--scene <0..65535>` for one scene. The alternate
source is `--vault-canonical-id <id>`; it and `--game-root` are mutually
exclusive. `--decompile-report-output <path>` is optional.

The current parser has no `--scenes` or `--unit-range` implementation, and the
current bridge schema has no extraction `sourceScope` field. Do not include
those tokens: unknown flags are not generally rejected, so an invocation can
appear successful while using only the recognized scope. Inspect the command
line and the resulting bridge before treating a slice as bounded.

Whole-archive extraction is also the safe default for encrypted archives: the
decoder can recover supported cross-scene encryption only after it sees the
archive. If a decompile report records unknown opcodes, treat it as a decode
gap; do not continue as if the bridge were complete.

## Structure, bible, and drafting

Build structure from the bridge and the source's actual engine files:

```sh
itotori structure-export --engine reallive \
  --gameexe <game-root>/REALLIVEDATA/Gameexe.ini \
  --seen <game-root>/REALLIVEDATA/Seen.txt \
  --bridge <run-dir>/bridge.json \
  --output <run-dir>/structure.json
```

`--entry-scene <n>` selects a non-default entry point; `--max-scenes <n>`
fails rather than silently truncating the archive. Then build the source bible:

```sh
itotori wiki build \
  --structure <run-dir>/structure.json --bridge <run-dir>/bridge.json \
  --source-locale <locale> --run-mode production \
  --output <run-dir>/wiki-summary.json
```

`wiki build` accepts `--concurrency <positive-integer>`, `--roles <a,b,...>`,
and `--portrait-sources <json>`. Production and pilot policy require the
wiki-first bible. Only `test-dev` permits `localize --ablation`.

Run the localizer with durable run identities and the two roots it owns:

```sh
itotori localize \
  --project-id <id> --run-id <id> --locale-branch-id <id> \
  --target-locale <bcp-47> \
  --source-root <read-only-game-root> --build-root <writable-build-root> \
  --run-mode production \
  --structure <run-dir>/structure.json --bridge <run-dir>/bridge.json \
  --output-scope dialogue-only --output <run-dir>/run-summary.json
```

Supply the project, run, and locale-branch identities; the target locale; the
read-only source and writable build roots; the run mode; and the preceding
structure and bridge artifacts. While provisioning that scope, `localize`
derives the engine family from structure, and the source revision, source
locale, bridge identity, extractor, and source-bundle hash from the bridge. Do
not redundantly supply those derived values.

Optional localizer flags are `--context-scope`, `--whole-scene-max-units`,
`--ablation`, and `--lease-owner-id`. Output scopes are `dialogue-only`,
`dialogue-and-choices`, `dialogue-choices-ui`, and `all`.

Important: `run-summary.json` is a redacted summary, not a translated bridge
bundle and not input to `itotori patch`. The direct patch command requires a
translated BridgeBundle v0.2. `itotori patch produce` can build from a complete
`NativePatchbackInput` (fact snapshot, accepted outputs, scope, locales, and
raw bridge), but the current public CLI does not export that input from a
`localize` run. Therefore this repository does not currently provide a
standalone CLI-only localize-to-patch handoff. Keep the run summary as evidence
and obtain the accepted-output patch input from the owning integration; do not
substitute the summary file.

## Patching and validation

When you have a translated bridge bundle, patch into a new writable target:

```sh
itotori patch \
  --source <read-only-game-root> --target <empty-output-root> \
  --bundle <translated-bridge.json> --scope dialogue-only
```

The patcher discovers the engine from `--source`; it does not take `--engine`.
`--scope` is exactly `dialogue-only` or `dialogue+choices`; `--force` permits
an existing non-empty target. The target must be outside the source. For this
engine the target is a sparse overlay containing the patched `Seen.txt`, not a
copied playable game tree.

Validate patched bytes against the original, full source tree:

```sh
itotori validate --engine reallive \
  --seen <output-root>/REALLIVEDATA/Seen.txt --scene <n> \
  --gameexe <game-root>/REALLIVEDATA/Gameexe.ini \
  --game-dir <game-root>/REALLIVEDATA \
  --replay-log <run-dir>/replay.json \
  --artifact-root <run-dir>/render \
  --render-output <run-dir>/render-report.json
```

`validate` first replay-validates and then renders. Optional flags are
`--redaction on|off`, `--print-textlines`, `--source-seen`, `--bg-asset`,
`--private-artifact-root`, `--run-id`, `--expect-text-contains`, `--width`,
and `--height`.

Rendering needs the full extracted tree. A minimal root or sparse patch target
can yield an empty-looking frame that resembles a decoder bug. Supply
`--game-dir` as the directory containing the real `g00/` directory, normally
`REALLIVEDATA`; the wrapper derives `<game-dir>/g00`. When calling the native
player or runtime directly, `--g00-dir` must point at the `g00` directory
itself, never its parent.

The public render artifact is redacted by default and is evidence tier E2.
It demonstrates observed rendered text, not pixel-exact retail-renderer
fidelity. A browser player session is a separate long-lived native process:
start it with a complete descriptor, advance or choose through that same
session, and close it when finished. Do not emulate it with cached frames.

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

- The documented scope expansion (`--scenes`, `--unit-range`) and bridge
  `sourceScope` are not present in this checkout's parsers or bridge schema.
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
