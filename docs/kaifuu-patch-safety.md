# Kaifuu Patch Safety Policy

KAIFUU-019 defines the minimum safety rules for Kaifuu patch writers,
`.kaifuu` delta application, and future engine adapters. These rules apply to
code that writes patched game assets, patch result metadata, generated
profiles, and extracted package output.

The current public implementation is the fixture adapter. It rewrites UTF-8
JSON `source.json` files and fixture `.kaifuu` deltas only. This policy also
sets requirements for future adapters that patch Shift-JIS, UTF-16LE, binary
tables, or engine-specific archives.

## Encoding

Adapters must identify the source asset encoding before patching. They must not
guess from translated text or silently rewrite an asset into a different
encoding.

| Encoding  | Required patch behavior                                                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UTF-8     | Decode as UTF-8, preserve valid scalar values, and emit UTF-8 unless the adapter readiness record names a different engine requirement. JSON outputs use UTF-8, NFC, LF, and stable pretty serialization.                                             |
| UTF-16LE  | Require BOM or adapter-specific fixture evidence before accepting the file as UTF-16LE. Preserve little-endian output and BOM policy from the input profile. Reject unpaired surrogate sequences as semantic patch failures.                          |
| Shift-JIS | Decode with the adapter's documented Shift-JIS variant. Preserve bytes for protected spans and unsupported byte ranges. If a replacement cannot be encoded in the same variant, fail the patch instead of writing mojibake or replacement characters. |

Binary patchers that operate on encoded string slots must validate encoded byte
lengths, terminators, offset tables, and protected spans before writing. A
translation that exceeds the supported byte budget must fail unless the adapter
has a tested relocation or rebuild path.

## Unicode Normalization

Bridge, profile, and patch metadata use the stable JSON normalization rule named
`utf8-nfc-lf-json-stable-v1`. Future adapters must document asset-level
normalization separately:

- Text metadata emitted by Kaifuu should be NFC unless the bridge contract says
  otherwise.
- Asset bytes should not be normalized blindly. Preserve source normalization
  when the engine treats byte identity as significant.
- If an engine requires NFD, NFKC, width folding, or another rule, the adapter
  readiness record must name the rule and include round-trip fixtures.

## Newlines

Generated Kaifuu JSON uses LF and a final newline. Text asset patchers must
preserve the asset's existing newline convention unless the adapter's fixture
policy explicitly declares normalized LF output. Mixed-newline assets are
unsafe to rewrite unless the adapter has a tested strategy for preserving line
boundaries and source hashes.

## Atomic Output

Patch writers must use same-directory temporary files and a rename into place
where feasible. In Rust code, prefer `kaifuu_core::atomic_write_text` or a
binary equivalent with the same shape:

1. Validate all inputs needed for the patch.
2. Create the output parent directory.
3. Write the complete file to a unique temporary file in the same directory.
4. Flush and sync the temporary file.
5. Rename the temporary file to the target path.
6. Best-effort sync the parent directory.
7. Remove the temporary file if writing or renaming fails.

This is a best-effort local filesystem rule. It does not claim universal
atomicity across every OS, network filesystem, antivirus hook, archive writer,
or multi-file engine rebuild. If an adapter cannot provide single-file atomic
rename semantics, it must document the limitation and fail before modifying the
original game directory.

## Output Directories And Path Traversal

Patch packages and adapter profiles must store asset paths as relative paths.
Writers must reject absolute paths, empty components, `.` components, `..`
components, Windows drive prefixes, NUL bytes, and both slash and backslash
traversal forms before joining with an output root. In Rust code, use
`kaifuu_core::safe_join_relative` for package-controlled output paths.

The caller may choose an output directory. Package-controlled asset paths may
not escape that directory. Kaifuu patch commands should write into a new output
directory whenever practical; in-place patching requires a separate readiness
record and rollback design.

## Rollback And Partial Writes

Patch writers must validate the full patch plan before writing any target file.
Validation includes source hashes, source unit keys, duplicate entries,
encoding round trips, byte budgets, protected spans, and output paths. If any
entry fails validation, the patch result is failed and no target file should be
created or overwritten.

For single-file rewrites, the atomic helper provides cleanup for temp-file
failures. For multi-file patches, adapters must stage all outputs first and
then commit them in a documented order. If a multi-file commit cannot be made
atomic, the adapter must either:

- write only to a new output directory and leave the source tree unchanged, or
- record a tested rollback plan that removes new files and preserves existing
  files on failure.

Silent partial success is forbidden. A patch result may report `passed` only
when every validated patch entry was applied exactly once and every expected
output was written. Unsupported multi-entry delta packages must fail before the
first output write; supported multi-entry delta packages must stage the complete
target tree before publishing it.

`.kaifuu` delta apply must also prove package completeness before staging. The
apply preflight derives a deterministic target manifest from the verified source
tree plus the package's changed-entry payloads and compares it with the package
target manifest before creating the output parent or staging directory.
Incomplete packages, including target-manifest changes omitted from
`changedEntries`, ignored artifact paths including descendants below
`patch-result.json` with either `/` or `\` separators, and file/dir prefix
conflicts that cannot be materialized on disk, must fail at this preflight step.

## Current Guardrails

The fixture implementation enforces a small subset of this policy:

- `write_json` and CLI stable profile writes use `atomic_write_text`.
- Fixture patching validates duplicate source keys, duplicate patch entries,
  unmatched keys, stale source hashes, and full entry application before
  writing `source.json`.
- Fixture `.kaifuu` delta application rejects path traversal, validates source
  compatibility, verifies changed-entry completeness before allocating staging,
  rejects ignored artifact paths and unmaterializable manifest path sets, and
  applies supported multi-entry packages through a staged target tree.
- Profile validation rejects unsafe asset paths in profile asset records.

Future engine adapters must extend these guardrails with encoding-specific
decoders, binary length checks, newline preservation, and engine-specific
rollback tests before claiming patch support for non-fixture formats.
