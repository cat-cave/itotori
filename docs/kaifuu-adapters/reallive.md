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
