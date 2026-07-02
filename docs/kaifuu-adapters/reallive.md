# RealLive Adapter Readiness Record

- Roadmap node: KAIFUU-172 (detector); successor scopes KAIFUU-173 (Scene/SEEN parser-boundary smoke), KAIFUU-174 (text inventory adapter), UTSUSHI-146 (runtime port). KAIFUU-172 establishes only the identify/inventory boundary.
- Owner: kaifuu engine-research track.
- Adapter id: `kaifuu.reallive`
- Crate or module: `kaifuu-engine-fixture` (struct `RealLiveProfileDetectorAdapter`); archive-matrix row `reallive-seen-txt` in `kaifuu-core`. A dedicated `kaifuu-reallive` crate is deferred to KAIFUU-173/174 once the parser/extractor lands.
- Engine family: RealLive (VisualArt's / Key — same VM lineage as AVG32 and Siglus, but distinct on-disk shape).
- Supported versions and variants: synthetic detector fixtures only at this slice. The detector accepts both a synthetic short-circuit (SEEN.TXT and Gameexe.ini matching the synthetic magic bytes) and a generic real-shape envelope (SEEN.TXT little-endian count + offset table fits inside file length AND Gameexe.ini contains at least one RealLive-specific key prefix). Real-game disambiguation is exercised in CI through synthetic positive + Siglus-cross / AVG32-cross negative fixtures; real RealLive titles (including the ALPHA-006 vertical Sweetie HD Remaster + Sweets) become positive evidence after KAIFUU-172 ships and are exercised at ALPHA-006.
- Explicitly excluded versions and variants:
  - AVG32 (`.PDT`-bearing or Gameexe-dat-bearing scenes) → semantic `kaifuu.unsupported_engine_variant`.
  - Siglus (`Scene.pck`/`Gameexe.dat`) → routes to the Siglus detector; co-presence with RealLive markers → `kaifuu.ambiguous_engine_variant`.
  - Encrypted SEEN.TXT or protected Gameexe variants → outside KAIFUU-172; future encrypted RealLive support is a separate node and requires a key-profile boundary review.
- Initial support boundary: **identify and inventory only**. The detector reads top-level file presence, signature bytes for SEEN.TXT (synthetic magic OR generic real-shape envelope), Gameexe.ini ASCII key-prefix hits, SEEN.GAN/.g00/.ovk/.koe/.nwk marker counts, and the Siglus/AVG32 cross-checks. No Scene/SEEN parsing, no extraction, no patching, no runtime.
- Unsupported or gated boundary: Scene/SEEN bytecode decode, `.koe`/`.nwk`/`.ovk` voice extraction, `.g00` image rebuild, Gameexe.ini patch-back, RealLive VM replay. All return `kaifuu.unsupported_layered_transform` until KAIFUU-173 / KAIFUU-174 / UTSUSHI-146 land.
- Public fixture ids:
  - `reallive-detector/positive-synthetic-triple` — synthetic SEEN.TXT envelope + synthetic Gameexe.ini + SEEN.GAN + `.g00` + `.ovk`. Expects `detected = true`, `detectedVariant = reallive-synthetic-triple`.
  - `reallive-detector/negative-siglus-overlap` — RealLive + Scene.pck + Gameexe.dat. Expects `detected = false`, `detectedVariant = ambiguous-reallive-siglus-overlap`, `kaifuu.ambiguous_engine_variant`.
  - `reallive-detector/negative-avg32-lineage` — synthetic SEEN.TXT + `.PDT` + Gameexe.ini without RealLive-specific keys. Expects `detected = false`, `detectedVariant = avg32-lineage-seen-txt`, `kaifuu.unsupported_engine_variant`.
  - `reallive-detector/negative-unknown-shape` — SEEN.TXT with non-magic bytes; empty Gameexe.ini. Expects `detected = false`, `detectedVariant = unknown-reallive-named-files`, `kaifuu.unknown_engine_variant`.
  - `reallive-detector/negative-not-reallive` — README-only fixture. Expects `detected = false`, no diagnostic (silent non-detection).
  - `reallive-detector/corrupt-signals` — SEEN.TXT truncated to 1 byte, full Gameexe.ini present. Expects `detected = false`, `detectedVariant = unknown-reallive-named-files`.
- Public fixture source class: synthetic.
- Fixture generation or source URL: shipped under `fixtures/public/reallive-detector/`. Synthetic bytes generated from public format archaeology only; the in-test `reallive_fixture_dir(...)` helper mirrors the public-fixture content for hermetic per-test coverage.
- Fixture license and attribution: synthetic, CC0-1.0. No retail bytes, no `/archive/vault/` access in KAIFUU-172 (vault-source adapter is read-only and is exercised at ALPHA-006, not at the detector node).
- Raw fixture file hashes: recorded in `fixtures/public/reallive-detector.manifest.json` and verified by `just fixtures-validate`.
- Positive fixture coverage: SEEN.TXT envelope detection (synthetic magic), SEEN.TXT envelope detection (generic real-shape), SEEN.GAN presence corroboration, Gameexe.ini RealLive-key detection, `.g00` corroboration, `.ovk`/`.koe`/`.nwk` corroboration, capability report shape, profile generation shape, deterministic profile id across runs.
- Negative fixture coverage: Siglus overlap (ambiguous), AVG32 lineage (unsupported), unknown shape (unknown-engine-variant), not-RealLive (silent non-detection), corrupt SEEN.TXT envelope (envelope-invalid → unknown), XP3-only cross-check (silent non-detection), Siglus-only cross-check (silent non-detection).
- Required round-trip artifacts: not applicable at KAIFUU-172 (detector only). Round-trip is KAIFUU-174's responsibility.
- Byte-identical or normalized equivalence rule: deferred to KAIFUU-174.
- Supported encodings and newline rules: Gameexe.ini is read as bytes (up to ~64 KiB) and matched only against ASCII key prefixes (`#GAMEEXE_VERSION`, `#REGNAME`, `#G00*`, `#KOE*`, `#SEEN*`). Shift-JIS handling is a KAIFUU-174 concern.
- Text surfaces: deferred to KAIFUU-174.
- Patch modes: none (unsupported).
- Asset inventory surfaces: top-level files only (SEEN.TXT, SEEN.GAN, Gameexe.ini). `.g00`/`.ovk`/`.koe`/`.nwk` counts are reported through the archive-matrix row and the layered-access profile metadata; per-file inventory of voice or image archives is not claimed.
- Semantic capability errors:
  - `kaifuu.ambiguous_engine_variant` (new in KAIFUU-172; see `crates/kaifuu-core/src/lib.rs` SemanticErrorCode catalog and §9.1 of the implementation plan).
  - `kaifuu.unsupported_engine_variant` (new in KAIFUU-172).
  - `kaifuu.unknown_engine_variant` (existing — used for SEEN-shaped but invalid envelope, or named markers without sufficient evidence).
  - `kaifuu.unsupported_layered_transform` (existing — used for extract/patch/verify attempts on identify-only adapter, mirroring Siglus's pattern).
  - `kaifuu.missing_capability.container` / `kaifuu.missing_capability.patch_back` (existing — used in the `patch` failure list to make the unsupported claim concrete).
- Reference implementations and docs:
  - Haeleth's RealLive / RLDEV site (`https://dev.haeleth.net/rldev.shtml`) — research anchor for format archaeology; **license posture**: research-only, no expression copied, no opcode tables imported.
  - RLDEV source tarball — research-only, no expression copied; behavior-only clean-room.
  - rlvm (`https://github.com/eglaysher/rlvm`) — research anchor; **license posture: GPLv3+, incompatible with itotori's link/derivation posture. Behavior-only clean-room. No code copied, no headers included, no Cargo dependency.** See "rlvm clean-room worker checklist" below.
- License review decisions:
  - RLDEV / Haeleth site → `behavior-only-clean-room`.
  - rlvm → `behavior-only-clean-room`; explicit "do not copy / do not link" note in both the crate-level module comment of `kaifuu-engine-fixture` and the per-row comment of `detect_reallive` in `kaifuu-core`.
  - Format observations against the ALPHA-006 vault title → derived from publicly observable file layout; logged as `private-local-only` aggregate evidence at the ALPHA-006 vertical, not encoded into KAIFUU-172 code.
- Parser spike status: not applicable (no parsing in KAIFUU-172). Parser spike begins under KAIFUU-173.
- Private corpus labels and aggregate stats: Sweetie HD Remaster + Sweets fandisc — labels and aggregate file-count stats only; raw filenames, scene contents, and `.koe` bytes never leave private-local.
- Key profile requirements: none for the alpha-vertical title's SEEN.TXT / Gameexe.ini path. `.ovk`/`.koe` voice obfuscation is a KAIFUU-174 / KAIFUU-064 concern.
- Helper requirements: **none**. Per the playbook's per-game evidence-first rule, KAIFUU-172 ships as pure static detection. If a future claimed game proves static detection insufficient, that's a separate node — not part of KAIFUU-172.
- Remote helper status: not used; not planned for the detector.
- Local validation commands:
  - `cargo test -p kaifuu-core`
  - `cargo test -p kaifuu-engine-fixture`
  - `cargo test -p kaifuu-cli`
  - `cargo run -p kaifuu-cli -- detect fixtures/public/reallive-detector/positive-synthetic-triple --output .tmp/reallive/detect-positive.json`
  - `cargo run -p kaifuu-cli -- detect fixtures/public/reallive-detector/negative-siglus-overlap --output .tmp/reallive/detect-ambiguous.json`
  - `cargo run -p kaifuu-cli -- detect fixtures/public/reallive-detector/negative-avg32-lineage --output .tmp/reallive/detect-avg32.json`
  - `cargo run -p kaifuu-cli -- detect fixtures/public/reallive-detector/negative-unknown-shape --output .tmp/reallive/detect-unknown.json`
  - `cargo run -p kaifuu-cli -- capabilities --output .tmp/reallive/capabilities.json`
  - `just fixtures-validate`
- CI validation commands: same as local, gated by `just check` / `just ci-kaifuu` / `just test`.
- Known gaps and proposed P2/P3 follow-ups:
  - KAIFUU-173 — Scene/SEEN parser-boundary smoke.
  - KAIFUU-174 — text inventory adapter (Scene/SEEN/Gameexe text slots, protected markup, asset references, patch-back).
  - UTSUSHI-146 — native RealLive runtime port (rlvm research anchor).
  - Future encrypted RealLive variants — separate node; not in the alpha set.
  - Real-game false-negative discovery for very early RealLive titles (Kanon-era, e.g. titles that omit `#GAMEEXE_VERSION` and ship only `#REGNAME` plus `.g00` corroborators) — reopened as a new node only after ALPHA-006 surfaces concrete evidence.

## rlvm clean-room worker checklist

This checklist is **load-bearing** for both the implementation worker and the
auditor. rlvm's license (GPLv3+) is incompatible with itotori's permissive
posture **if linked or derived**. The implementation must remain
behavior-only / clean-room. The auditor uses this list verbatim.

- [x] No `git submodule`, no Cargo dep, no vendored `rlvm` / RLDEV code. Verified by `grep rlvm Cargo.toml Cargo.lock crates/*/Cargo.toml` returning zero matches.
- [x] No copied opcode tables, no copied struct layouts, no copied lookup constants from rlvm. Constants (magic byte values, key names, extension lists) come from public format archaeology and observable shape only.
- [x] Module-level provenance comment is present and accurate (top of `crates/kaifuu-engine-fixture/src/lib.rs` plus inline block above `RealLiveProfileDetectorAdapter` and above `detect_reallive` in `kaifuu-core`).
- [x] No `Command::new("rlvm")`, no `std::process::Command` invocation of any foreign tool from the detector or matrix row.
- [x] Detector tests pass on a host with **no** rlvm installed. The detector exercises only filesystem I/O and a small in-memory FSM; no helper binary is launched.
- [x] Synthetic fixtures contain no copyrighted RealLive bytes — no real scenes, no real Gameexe.ini values from any owned title. The synthetic SEEN.TXT envelope uses the placeholder magic `SEEN\x01` plus a 1-entry table; the synthetic Gameexe.ini begins with `# RealLive Gameexe.ini fixture` and includes only documented key prefixes.
- [ ] If a future worker reads rlvm to confirm a hypothesis, the readiness record's "Reference implementations and docs" entry records that fact with the file path that was consulted and the hypothesis that was confirmed, **without** importing rlvm's expression. (No such read was performed during the KAIFUU-172 implementation slice; the box is left unchecked as a hand-off marker for future contributors.)

## KAIFUU-173 parser-boundary smoke addendum

- Roadmap node: KAIFUU-173 (Scene/SEEN parser-boundary smoke).
- Crate or module: `kaifuu-reallive` (new workspace member at `crates/kaifuu-reallive/`). Library-only — no `EngineAdapter` impl. Public surface: `parse_archive`, `parse_scene`, AST types (`Scene`, `Instruction`, `StringSlot`, `ParseOutcome`, `ParseDiagnostic`), bounded `NamedOpcode` catalogue, and the `semantic_error_code_for_parser_diagnostic` mapping helper.
- Initial support boundary (parser scope): smoke — single fixture-safe scene per archive, eight named opcodes (`TextDisplay`, `SetSpeaker`, `Choice`, `SetVar`, `Jump`, `Return`, `ClearScreen`, `Pause`), and a documented synthetic instruction shape (opener `0x23`, opcode byte, operand-count byte, then `i`/`s`/`l` operand tags). Unrecognized opener bytes and opcodes emit `kaifuu.reallive.unrecognized_instruction` warnings paired with an `Unrecognized` AST node carrying the raw opener — never silent skip.
- Unsupported or gated boundary at this slice: real-game variability beyond the synthetic fixture (per-scene headers, real-game-only operand shapes, the long tail of RealLive opcodes); Shift-JIS decode (KAIFUU-174 codec stage); encrypted SEEN.TXT (future node); patch-back (KAIFUU-174); jump resolution / scene-graph linking / expression evaluation / VM execution (UTSUSHI-146); CLI inventory subcommand (KAIFUU-174). All emit `kaifuu.unsupported_layered_transform` or stay outside the parser surface entirely.
- Public fixture ids: `smoke-scene-001`, `truncated-scene-001`, `unknown-opcode-001` (crate-local under `crates/kaifuu-reallive/tests/fixtures/`; **not** promoted to `fixtures/public/manifest.schema.json` per §9.2 of the plan — KAIFUU-174 may promote them when bridge-bundle goldens land).
- Public fixture source class: synthetic.
- Fixture generation or source URL: bytes are authored from public format archaeology (Haeleth's RLDEV documentation) plus the documented in-crate bytecode shape; reproduced by `cargo run -p kaifuu-reallive --example regenerate_fixtures`. Tests assert the on-disk bytes match the in-test synthetic builder so drift is caught at CI time.
- Fixture license and attribution: synthetic, CC0-1.0. No retail bytes, no `/archive/vault/` access in KAIFUU-173.
- Semantic capability errors (parser-local, new in KAIFUU-173):
  - `kaifuu.reallive.invalid_archive_envelope` (Fatal; maps to `kaifuu.unknown_engine_variant` at the KAIFUU-174 adapter boundary).
  - `kaifuu.reallive.truncated_scene` (Fatal; maps to `kaifuu.unknown_engine_variant`).
  - `kaifuu.reallive.truncated_instruction` (Fatal; maps to `kaifuu.unsupported_layered_transform`).
  - `kaifuu.reallive.unrecognized_instruction` (Warning; recoverable — surfaces in inventory only).
  - `kaifuu.reallive.unrecognized_operand_shape` (Warning; recoverable).
  - `kaifuu.reallive.invalid_string_slot` (Warning; maps to `kaifuu.unsupported_layered_transform`).
  - `kaifuu.reallive.out_of_profile_input` (Fatal; maps to `kaifuu.unsupported_engine_variant`).
- Parser spike status: completed under KAIFUU-173. Spike outcome rolled directly into the smoke fixtures (no separate spike artifact).
- Local validation commands:
  - `cargo test -p kaifuu-reallive`
  - `cargo test -p kaifuu-core` (no regression; the parser does not modify the core surface)
  - `cargo fmt --check`
  - `cargo clippy -p kaifuu-reallive --all-targets -- -D warnings`
  - `just check`
- CI validation commands: same as local.
- Known gaps (P2/P3 follow-ups):
  - KAIFUU-174 — text inventory adapter (Scene/SEEN/Gameexe text slots, Shift-JIS decode, protected markup, asset references, patch-back, `EncodedStringSlot` projection from the parser AST).
  - UTSUSHI-146 — native RealLive runtime port (opcode execution semantics, jump resolution, VM port).
  - Real-game opcode-coverage discovery at ALPHA-006 — expansion of the named-opcode catalogue follows the per-game evidence-first rule (each new opcode requires a paired synthetic fixture).
  - Offset-map / logical-id layer for patch-back-stability (the byte-position-derived string-slot ids in this slice are intentionally physical-position ids; the logical layer is KAIFUU-174's offset-map scope).

### KAIFUU-173 rlvm clean-room worker checklist

- [x] No `git submodule`, no Cargo dep, no vendored `rlvm` / RLDEV code in `crates/kaifuu-reallive`. Verified by `grep rlvm Cargo.toml Cargo.lock crates/*/Cargo.toml` returning zero matches.
- [x] No copied opcode tables, lookup constants, or struct layouts in `crates/kaifuu-reallive`. The eight-opcode catalogue and the `i`/`s`/`l` operand-tag set are authored from public RLDEV documentation plus synthetic-fixture bytes; byte values were chosen for fixture readability, not copied from rlvm.
- [x] Crate-level provenance comment is present at the top of `crates/kaifuu-reallive/src/lib.rs` and is mirrored as the module preamble across `archive.rs`, `ast.rs`, `diagnostics.rs`, `opcodes.rs`, `parser.rs`, `strings.rs`.
- [x] No `Command::new`, no foreign tool invocation, no helper boundary in this crate. The parser is a pure function over `&[u8]`.
- [x] Tests pass on a host with no rlvm installed. The crate's only dep is `kaifuu-core` plus serde/thiserror.
- [x] Synthetic fixtures under `crates/kaifuu-reallive/tests/fixtures/` contain no copyrighted RealLive bytes. Every byte is authored from public docs and reproduced by the in-tree regenerator.
- [ ] If a future worker reads rlvm to confirm a hypothesis, the readiness record's "Reference implementations and docs" entry records that fact with the file path that was consulted and the hypothesis that was confirmed, **without** importing rlvm's expression. (No such read was performed during the KAIFUU-173 implementation slice; the box is left unchecked as a hand-off marker for future contributors.)

## KAIFUU-174 text inventory adapter addendum

- Roadmap node: KAIFUU-174.
- Crate or module: `crates/kaifuu-reallive` (new `encoding.rs`, `protected_spans.rs`, `inventory.rs`, `gameexe.rs`, `patchback.rs` modules) and `crates/kaifuu-engine-fixture` (`RealLiveProfileDetectorAdapter` trait impl extended; adapter id `kaifuu.reallive` unchanged).
- Initial support boundary: Scene/SEEN dialogue / speaker / choice slot extraction and length-preserving patch-back, plus Gameexe.ini user-visible key (`#TITLE`, `#WINTITLE`) BridgeUnits and asset-reference catalogue (`#G00*`, `#KOE*`, `#SEEN*`, `#NWK*`, `#OVK*`, `#REGNAME`, `#GAMEEXE_VERSION`).
- Unsupported / gated boundary: length-changing patch-back (offset-table rewrite + jump-target recalculation deferred to a future node; emits `kaifuu.reallive.patchback_offset_overflow` Fatal), encrypted SEEN.TXT, `.g00` image-overlay text patching, `.koe` / `.ovk` / `.nwk` voice extraction, RealLive runtime / VM replay (UTSUSHI-146).
- Public fixture ids: `bridge-inventory-001`, `protected-spans-001`, `patchback-identity-001`, `patchback-length-preserving-001`, `patchback-overflow-001`, `unsupported-text-shape-001` (crate-local under `crates/kaifuu-reallive/tests/fixtures/`).
- Fixture license: synthetic, CC0-1.0. Every byte is reproduced by the per-test synthetic builder; the on-disk bytes are an audit aid.
- Supported encodings: Shift-JIS (decode + encode via `encoding_rs`).
- Text surfaces: `dialogue`, `speaker_name`, `choice_label`, `metadata_text` (Gameexe.ini).
- Patch modes: length-preserving slot replacement only. The `SlotEditLengthPolicy::FixedBudget` variant is wired through the API but always rejected with `kaifuu.reallive.patchback_unsupported_length_policy` Fatal at this slice.
- Asset inventory surfaces: top-level files (carry forward from KAIFUU-172) plus per-StringSlot asset refs (`.g00`, `.koe`, `.ovk`, `.nwk` by extension) and per-Gameexe-key asset refs (documented catalogue keys only).
- Semantic capability errors (parser-local namespace, mapped at adapter boundary into `kaifuu_core::SemanticErrorCode`):
  - `kaifuu.reallive.shift_jis_decode_failure` (Warning).
  - `kaifuu.reallive.protected_span.unknown_control` (Warning).
  - `kaifuu.reallive.inventory.unattributed_dialogue` (Warning).
  - `kaifuu.reallive.inventory.unknown_asset_extension` (Warning).
  - `kaifuu.reallive.inventory.unknown_gameexe_key` (Warning).
  - `kaifuu.reallive.unsupported_text_shape` (Warning).
  - `kaifuu.reallive.patchback_offset_overflow` (Fatal; length-changing edits).
  - `kaifuu.reallive.patchback_shift_jis_encode_failure` (Fatal; encoder hit `had_unmappable_characters`).
  - `kaifuu.reallive.patchback_unsupported_length_policy` (Fatal; `FixedBudget` requested).
  - `kaifuu.reallive.patchback_parser_regression` (Fatal; re-parse self-check failed).
  - `kaifuu.reallive.patchback_unknown_slot_id` (Fatal; edit references an unknown slot id).
  - `kaifuu.reallive.patchback_stale_source_hash` (Fatal; expected source hash mismatched).
  - `kaifuu.reallive.patchback_protected_span_lost` (Fatal; edited text dropped a protected span).
- Reference implementations and docs:
  - Haeleth's RLDEV documentation (`https://dev.haeleth.net/rldev.shtml`) — `behavior-only-clean-room`. Used to derive the bounded protected-span catalogue and the bounded Gameexe.ini key catalogue.
  - rlvm (`https://github.com/eglaysher/rlvm`) — `behavior-only-clean-room`. Not linked, not derived.
  - `encoding_rs` workspace dep (MIT/Apache-2.0). WHATWG-spec Shift-JIS; not a copy of rlvm or RLDEV code.
- Parser spike status: completed under KAIFUU-173.
- Local validation commands:
  - `cargo test -p kaifuu-reallive`
  - `cargo test -p kaifuu-engine-fixture`
  - `cargo test -p kaifuu-core`
  - `cargo test -p kaifuu-cli`
  - `cargo fmt --check`
  - `cargo clippy -p kaifuu-reallive -p kaifuu-engine-fixture --all-targets -- -D warnings`
- Known gaps (P2/P3 follow-ups):
  - ~~Length-changing patch-back (offset-table rewrite + jump-target recalculation).~~ **DELIVERED** by the bundle-driven `apply_translated_bundle` driver — see the KAIFUU-211 length-changing addendum below. The `reallive-patchback-length-changing` node proved it on Sweetie HD (longer + shorter bodies, offset table rewritten, all 91 goto pointers of scene 8509 recalculated to boundary-landing offsets, zero-unknown re-decompile). The KAIFUU-174 slot API's `SlotEditLengthPolicy::FixedBudget` Fatal is that older matrix surface only; the canonical patch path is length-changing.
  - UTSUSHI-146 — RealLive runtime / VM port.
  - Encrypted SEEN.TXT (key-profile boundary review).
  - `.g00` image-overlay text patching, `.koe` / `.ovk` / `.nwk` voice handling.
  - Real-game Sweetie HD protected-span catalogue expansion (ALPHA-006 evidence-first).
  - Public-fixture-manifest promotion of the new bridge-inventory / patchback fixtures (crate-local at this slice).

### KAIFUU-174 rlvm clean-room worker checklist

- [x] No `git submodule`, no Cargo dep on rlvm/RLDEV, no vendored rlvm/RLDEV code in `crates/kaifuu-reallive` or `crates/kaifuu-engine-fixture`.
- [x] No copied opcode tables, control-byte tables, Gameexe.ini key tables, or struct layouts. The protected-span catalogue and Gameexe key catalogue are authored from public RLDEV documentation plus synthetic-fixture bytes.
- [x] Crate-level provenance comment in `crates/kaifuu-reallive/src/lib.rs` extended with the KAIFUU-174 paragraph. Per-module preambles updated in `encoding.rs`, `protected_spans.rs`, `inventory.rs`, `gameexe.rs`, `patchback.rs`.
- [x] No `Command::new`, no foreign tool invocation, no helper boundary in the new code. The inventory and patch-back planners are pure functions over `&[u8]`; the adapter owns the filesystem I/O.
- [x] Tests pass on a host with no rlvm installed. New deps are `encoding_rs`, `sha2`, `thiserror`, `uuid` — all permissive.
- [x] Synthetic fixtures under `crates/kaifuu-reallive/tests/fixtures/` contain no copyrighted bytes. Every byte is reproduced by the in-tree builder; on-disk and builder output are asserted to match.
- [ ] If a future worker reads rlvm to confirm a hypothesis at ALPHA-006 (Sweetie HD evidence work), the readiness record records that fact with the file path consulted and the hypothesis confirmed, **without** importing rlvm's expression. (No such read was performed during the KAIFUU-174 implementation slice.)

## KAIFUU-211 length-changing patch-back addendum (`reallive-patchback-length-changing`)

- Crate or module: `crates/kaifuu-reallive/src/patchback/bundle_driven.rs` (`apply_translated_bundle` — the canonical real-bytes patch driver) + `crates/kaifuu-reallive/src/opcode.rs` (`collect_goto_pointer_sites` / `GotoPointerSite`).
- Capability: a translated text body that CHANGES byte length (longer or shorter than the source) is now supported end-to-end. The English-localization common case — where a translation is rarely the same byte length as the Japanese source — no longer requires a length-preserving edit.
- How it works (the two shifts a length change forces):
  1. **Scene offset table rewrite.** The 10,000-slot Seen.txt directory is fully re-emitted: every populated scene's `(byte_offset, byte_len)` is recomputed as scenes after an edited scene slide forward/back to accommodate the new size. Unmodified scenes keep their bytes verbatim. (This was already present in the bundle-driven driver.)
  2. **Jump-target recalculation.** RealLive control-flow commands (`goto`/`goto_if`/`goto_unless`/`goto_on`/`goto_case`/`gosub*`/`gosub_with`, plus the cross-scene `farcall` module `0x05`/`0x06` variants) carry trailing `i32 LE` pointers whose value is the **absolute byte offset** of the jump destination within the same decompressed scene bytecode. `collect_goto_pointer_sites` walks the scene off the single-source-of-truth element decoder and captures each pointer's `(pointer_offset, target)`. For each text splice `[s, e)` → `new_bytes` (delta `= len(new) - (e - s)`), every pointer target `T` is re-based by the cumulative delta of the splices that precede it (`T' = T + Σ delta_i` over splices with `e_i <= T`). A target that lands strictly inside an edited body (`s < T < e`) is not recalculable and surfaces `kaifuu.reallive.patchback_goto_target_unresolvable` Fatal rather than a silent mis-patch. Corrected values are written in place at the pre-splice pointer offsets; the goto pointers live in Command bodies, disjoint from the Textout / choice bodies being spliced, so the subsequent splices carry the corrected pointer bytes to their new homes verbatim.
- Encrypted-at-rest (`xor_2`, Sweetie HD `compiler_version 110002`): recalculation runs on the DECRYPTED plaintext bytecode (the layer the interpreter executes and where pointer values are real offsets), then the edited scene is re-encrypted before recompression — unchanged from the existing round-trip.
- New error code: `kaifuu.reallive.patchback_goto_target_unresolvable` (Fatal; a jump destination fell strictly inside an edited text body).
- Proof (real bytes, `ITOTORI_REAL_GAME_ROOT=/scratch/itotori-research/sweetie-hd`): `crates/kaifuu-reallive/tests/patchback_real_bytes.rs::length_changing_patch_recalculates_goto_targets_on_real_scene` patches Sweetie HD scene 8509 (72 dialogue units, **91 goto pointers**, all destinations after the first dialogue) with both a LONGER body (scene bytecode 11189→28681 bytes) and a SHORTER body (11189→5497 bytes). For each direction it asserts: the archive re-parses with the same 198-scene directory; the patched scene re-decompiles with **zero** unknown and **zero** generic opcodes and partitioning framing (no MalformedExpression); and every one of the 91 pointers was re-based to a NEW offset that still lands on an element boundary AND still targets the SAME logical element (same ordinal + opcode label) — i.e. a jump to opcode X still points to opcode X, never into the middle of a command.
- Jump-target correctness rigor: the empirical anchor is that across the ENTIRE Sweetie HD archive every goto target lands exactly on a decoded element boundary (verified during scoping) — confirming the `i32` pointers are absolute scene-bytecode byte offsets. The test's boundary-landing + same-ordinal assertions are the strict proof.
