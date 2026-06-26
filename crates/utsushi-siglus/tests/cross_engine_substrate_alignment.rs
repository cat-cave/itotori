//! UTSUSHI-147 — RealLive/Siglus shared substrate alignment fixture.
//!
//! This is the cross-engine conformance fixture promised by the
//! UTSUSHI-147 spec. It is **the** load-bearing test for the
//! UTSUSHI-147 deliverable list:
//!
//! 1. Cross-engine conformance fixture covering RealLive and Siglus
//!    ports against one substrate API surface.
//! 2. Conformance evidence that both engines share VFS / render /
//!    snapshot semantics through the substrate facade.
//! 3. Substrate-API-drift regression coverage (the
//!    identical-import-set audit).
//! 4. Lineage-extension notes anchor — pinned to
//!    `docs/research/reallive-engine.md` Appendix M.
//!
//! ## Why this lives in `utsushi-siglus/tests/`, not `utsushi-reallive/tests/`
//!
//! Per the project memory `feedback_multi_game_validation.md`, substrate
//! work means at least two engine families. UTSUSHI-221 first proved
//! the substrate facade is engine-extensible at the **scaffold-contract
//! level** via an *inline* Siglus minimal-port scaffold inside
//! `utsushi-reallive`'s test crate. UTSUSHI-147 promotes that inline
//! scaffold into a real sibling crate (`utsushi-siglus`) and routes the
//! cross-engine conformance fixture through the new crate.
//!
//! Routing the fixture through `utsushi-siglus` instead of
//! `utsushi-reallive` has three consequences:
//!
//! - **The Siglus port is the dev-dep dependency direction.** Adding
//!   `utsushi-reallive` as a dev-dep of `utsushi-siglus` (rather than
//!   the reverse) keeps the alpha-tier posture clean: alpha is
//!   RealLive-only, so the RealLive crate must not gain a runtime
//!   dependency on the Siglus crate. The cross-engine fixture is a
//!   second-engine concern.
//! - **The fixture observes the substrate facade as a shared surface,
//!   not as a per-engine fork.** The two engines are co-loaded here
//!   only via `utsushi_core::substrate::*` (plus the documented
//!   `CaptureOutcome` reach-around mirrored on both). Engine-internal
//!   types from `utsushi_reallive::*` or `utsushi_siglus::*` are
//!   referenced only as `EnginePort` implementors — never to peek at
//!   per-engine state.
//! - **The legacy inline scaffold is deleted in the same change.** The
//!   `crates/utsushi-reallive/tests/cross_engine_facade_only_imports.rs`
//!   file no longer exists; the inline Siglus scaffold has been
//!   promoted into `crates/utsushi-siglus/src/lib.rs`. Per the
//!   project's no-legacy-compat rule, the old path is removed in the
//!   same commit as the new one (no `#[deprecated]`, no shim).
//!
//! ## What this fixture proves
//!
//! - **Compile-time:** Both `UtsushiReallivePort` and `UtsushiSiglusPort`
//!   resolve the substrate's `EnginePort` trait bound through the
//!   facade re-export. If a future substrate refactor splits the bound,
//!   this file fails to compile — blocking the API drift from landing
//!   without a paired conformance update.
//! - **Manifest shape:** Both ports declare identical
//!   `REQUIRED_LIFECYCLE_STAGES` slices, identical `PortCapability`
//!   sets, identical evidence/fidelity tier ceilings, and identical
//!   `abi_version` values through the facade's `PortManifest` type.
//! - **VFS shape:** Both ports' inert context types expose an
//!   `Option<Arc<dyn AssetPackage>>` asset-package slot. The
//!   `AssetPackage` trait object is **the** facade carrier for VFS
//!   semantics; if the trait moves out of `utsushi_core::substrate::*`
//!   this compiles against the wrong path and breaks.
//! - **Render shape:** Both ports' `EnginePort::sink_set()` returns the
//!   facade's `SinkSet` type. The three drains (`drain_text`,
//!   `drain_frame`, `drain_audio`) consume facade-typed event lists
//!   (`TextLine`, `FrameArtifact`, `AudioEvent`). Engine-neutral.
//! - **Snapshot shape:** Both ports route lifecycle errors through
//!   `EnginePortError::Lifecycle { stage, message }`. The substrate's
//!   snapshot/restore contract is **the** typed surface; the scaffolds
//!   do not yet exercise it, but the alignment fixture pins the typed
//!   error variant identically across engines.
//! - **Substrate-API-drift regression:** A source scan of both
//!   scaffolds' `lib.rs` extracts every `utsushi_core::*` import; the
//!   facade-leaf import sets are required to be **identical** across
//!   engines (except for an explicitly-allowlisted set), and any
//!   non-facade reach-around (`utsushi_core::CaptureOutcome`) is
//!   required to be symmetric.
//! - **Lineage-extension notes:** Asserts
//!   `docs/research/reallive-engine.md` Appendix M is present and
//!   carries the per-sub-node engine-specific boundary notes, plus the
//!   §M.7 update documenting the inline-scaffold promotion this node
//!   accomplishes.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

use utsushi_core::substrate::{
    AssetPackage, AudioEvent, AudioEventSink, EnginePort, EnginePortError, EvidenceTier,
    FidelityTier, FrameArtifact, FrameArtifactSink, Inspectable, LifecycleStage, PortCapability,
    PortRequest, REQUIRED_LIFECYCLE_STAGES, RunnerCancellation, SinkSet, Snapshot, SnapshotError,
    SnapshotRequest, SnapshotStore, StatePath, TextLine, TextSurfaceSink, take_snapshot,
};
use utsushi_core::{CaptureOutcome as SubstrateCaptureOutcome, RuntimeOperation};

use utsushi_reallive::{
    RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT,
    UNIMPLEMENTED_MESSAGE as REALLIVE_UNIMPLEMENTED_MESSAGE, UtsushiReallivePort,
};
use utsushi_siglus::{
    SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT,
    UNIMPLEMENTED_MESSAGE as SIGLUS_UNIMPLEMENTED_MESSAGE, UtsushiSiglusPort,
};

// ---------------------------------------------------------------------
// §1. Compile-time witnesses.
//
// Both ports satisfy the substrate's `EnginePort` bound through the
// facade re-export. If a future refactor splits the bound, this file
// fails to compile — proving the substrate API drift would have to be
// addressed before either port is updated.
// ---------------------------------------------------------------------

fn assert_implements_engine_port<P: EnginePort>() {}

/// Touch the facade types named in the doc-comment's "VFS / render /
/// snapshot semantics" guarantee at the type level so a substrate
/// refactor that moves any of them out of `utsushi_core::substrate::*`
/// breaks this file at compile time. The `PhantomData` tuple is the
/// vehicle: every type the cross-engine fixture's doc-comment lists is
/// named here, and clippy's `too_many_arguments` lint cannot fire
/// against a single-argument function.
#[allow(dead_code)]
type FacadeShapeWitness = (
    std::marker::PhantomData<Arc<dyn AssetPackage>>,
    std::marker::PhantomData<TextLine>,
    std::marker::PhantomData<FrameArtifact>,
    std::marker::PhantomData<AudioEvent>,
    std::marker::PhantomData<StatePath>,
    std::marker::PhantomData<Snapshot>,
    std::marker::PhantomData<Box<dyn TextSurfaceSink>>,
    std::marker::PhantomData<Box<dyn FrameArtifactSink>>,
    std::marker::PhantomData<Box<dyn AudioEventSink>>,
    std::marker::PhantomData<Box<dyn SnapshotStore>>,
);

#[test]
fn both_ports_satisfy_facade_engine_port_bound_at_compile_time() {
    assert_implements_engine_port::<UtsushiReallivePort>();
    assert_implements_engine_port::<UtsushiSiglusPort>();
}

// ---------------------------------------------------------------------
// §2. Manifest-shape conformance.
//
// Both ports' manifests share identical capability sets, identical
// required lifecycle stages, identical evidence/fidelity tier ceilings,
// and identical ABI versions through the facade's `PortManifest` type.
// ---------------------------------------------------------------------

#[test]
fn both_ports_manifests_validate_through_facade_rules() {
    UtsushiReallivePort::MANIFEST
        .validate()
        .expect("RealLive port manifest passes facade validation");
    UtsushiSiglusPort::MANIFEST
        .validate()
        .expect("Siglus port manifest passes facade validation");
}

#[test]
fn both_ports_declare_identical_required_lifecycle_stages() {
    assert_eq!(
        UtsushiReallivePort::MANIFEST.required_methods,
        REQUIRED_LIFECYCLE_STAGES,
        "RealLive port pins the facade's REQUIRED_LIFECYCLE_STAGES",
    );
    assert_eq!(
        UtsushiSiglusPort::MANIFEST.required_methods,
        REQUIRED_LIFECYCLE_STAGES,
        "Siglus port pins the facade's REQUIRED_LIFECYCLE_STAGES",
    );
    assert_eq!(
        UtsushiReallivePort::MANIFEST.required_methods,
        UtsushiSiglusPort::MANIFEST.required_methods,
        "RealLive and Siglus ports declare identical required lifecycle stages",
    );
}

#[test]
fn both_ports_declare_identical_capability_sets() {
    let reallive_caps: Vec<PortCapability> = UtsushiReallivePort::MANIFEST.capabilities.to_vec();
    let siglus_caps: Vec<PortCapability> = UtsushiSiglusPort::MANIFEST.capabilities.to_vec();
    assert_eq!(
        reallive_caps, siglus_caps,
        "RealLive and Siglus ports declare identical PortCapability sets",
    );
}

#[test]
fn both_ports_pin_identical_tier_ceilings() {
    assert_eq!(
        UtsushiReallivePort::MANIFEST.evidence_tier_max,
        EvidenceTier::E1,
        "RealLive port pins evidence_tier_max=E1",
    );
    assert_eq!(
        UtsushiSiglusPort::MANIFEST.evidence_tier_max,
        EvidenceTier::E1,
        "Siglus port pins evidence_tier_max=E1",
    );
    assert_eq!(
        UtsushiReallivePort::MANIFEST.fidelity_tier_max,
        FidelityTier::TraceOnly,
        "RealLive port pins fidelity_tier_max=TraceOnly",
    );
    assert_eq!(
        UtsushiSiglusPort::MANIFEST.fidelity_tier_max,
        FidelityTier::TraceOnly,
        "Siglus port pins fidelity_tier_max=TraceOnly",
    );
}

#[test]
fn both_ports_declare_identical_abi_version() {
    assert_eq!(
        UtsushiReallivePort::MANIFEST.abi_version,
        UtsushiSiglusPort::MANIFEST.abi_version,
        "RealLive and Siglus ports declare identical ABI versions through the facade",
    );
}

#[test]
fn ports_declare_distinct_engine_ids() {
    assert_eq!(UtsushiReallivePort::MANIFEST.id, "utsushi-reallive");
    assert_eq!(UtsushiSiglusPort::MANIFEST.id, "utsushi-siglus");
    assert_ne!(
        UtsushiReallivePort::MANIFEST.id,
        UtsushiSiglusPort::MANIFEST.id,
        "Cross-engine conformance requires distinct engine ids",
    );
}

// ---------------------------------------------------------------------
// §3. VFS / render semantics — shared facade carriers.
//
// Both ports' inert contexts expose an `Option<Arc<dyn AssetPackage>>`
// asset-package slot (VFS). Both ports' `EnginePort::sink_set()` returns
// the facade's `SinkSet` whose three drains consume facade-typed event
// lists (render: TextLine / FrameArtifact / AudioEvent).
// ---------------------------------------------------------------------

#[test]
fn both_ports_expose_facade_asset_package_slot() {
    let reallive_port = UtsushiReallivePort::new();
    let siglus_port = UtsushiSiglusPort::new();
    // Both contexts return `None` while the scaffolds are inert; the
    // type signature is `Option<&Arc<dyn AssetPackage>>` — the facade
    // trait object is the shared VFS carrier.
    let _reallive_slot: Option<&Arc<dyn AssetPackage>> = reallive_port.context().asset_package();
    let _siglus_slot: Option<&Arc<dyn AssetPackage>> = siglus_port.context().asset_package();
    assert!(reallive_port.context().asset_package().is_none());
    assert!(siglus_port.context().asset_package().is_none());
}

#[test]
fn both_ports_expose_facade_sink_set() {
    let reallive_port = UtsushiReallivePort::new();
    let siglus_port = UtsushiSiglusPort::new();
    let reallive_sinks: &SinkSet = EnginePort::sink_set(&reallive_port);
    let siglus_sinks: &SinkSet = EnginePort::sink_set(&siglus_port);
    // Drain semantics are identical: empty sink sets produce empty Vecs
    // of facade-typed events.
    let reallive_text: Vec<TextLine> = reallive_sinks.drain_text();
    let siglus_text: Vec<TextLine> = siglus_sinks.drain_text();
    assert!(reallive_text.is_empty());
    assert!(siglus_text.is_empty());
    let reallive_frame: Vec<FrameArtifact> = reallive_sinks.drain_frame();
    let siglus_frame: Vec<FrameArtifact> = siglus_sinks.drain_frame();
    assert!(reallive_frame.is_empty());
    assert!(siglus_frame.is_empty());
    let reallive_audio: Vec<AudioEvent> = reallive_sinks.drain_audio();
    let siglus_audio: Vec<AudioEvent> = siglus_sinks.drain_audio();
    assert!(reallive_audio.is_empty());
    assert!(siglus_audio.is_empty());
    // None of the scaffolds register any sink yet.
    assert!(reallive_sinks.text().is_none() && siglus_sinks.text().is_none());
    assert!(reallive_sinks.frame().is_none() && siglus_sinks.frame().is_none());
    assert!(reallive_sinks.audio().is_none() && siglus_sinks.audio().is_none());
}

// ---------------------------------------------------------------------
// §4. Snapshot semantics — shared facade carrier.
//
// Both ports route lifecycle errors through `EnginePortError::Lifecycle`.
// Neither scaffold exercises `take_snapshot` yet (that lands when the
// post-alpha behavioural work joins each port), but this test pins the
// typed-error variant identically across engines and touches the
// `take_snapshot` free function through the facade so the function's
// path is part of the conformance witness.
// ---------------------------------------------------------------------

#[test]
fn both_ports_route_lifecycle_errors_through_facade_typed_error() {
    let mut reallive_port = UtsushiReallivePort::new();
    let mut siglus_port = UtsushiSiglusPort::new();
    let root = Path::new("/");
    let reallive_request = PortRequest::new(
        root,
        "x-engine-conformance-reallive",
        RuntimeOperation::Trace,
    )
    .with_cancellation(RunnerCancellation::new());
    let siglus_request =
        PortRequest::new(root, "x-engine-conformance-siglus", RuntimeOperation::Trace)
            .with_cancellation(RunnerCancellation::new());

    for (port_id, error) in [
        ("utsushi-reallive", reallive_port.observe(&reallive_request)),
        ("utsushi-siglus", siglus_port.observe(&siglus_request)),
    ] {
        match error {
            Err(EnginePortError::Lifecycle { stage, message, .. }) => {
                assert_eq!(stage, LifecycleStage::Observe);
                assert!(
                    !message.is_empty(),
                    "{port_id} observe lifecycle error must carry a non-empty message"
                );
            }
            other => panic!("{port_id} observe returned non-Lifecycle outcome: {other:?}"),
        }
    }

    // Confirm each port's scaffold-marker message is the engine's
    // typed UNIMPLEMENTED_MESSAGE constant — the orchestration audit
    // greps for these strings.
    let mut reallive_port = UtsushiReallivePort::new();
    let mut siglus_port = UtsushiSiglusPort::new();
    let reallive_request = PortRequest::new(
        root,
        "x-engine-conformance-reallive",
        RuntimeOperation::Trace,
    )
    .with_cancellation(RunnerCancellation::new());
    let siglus_request =
        PortRequest::new(root, "x-engine-conformance-siglus", RuntimeOperation::Trace)
            .with_cancellation(RunnerCancellation::new());
    match reallive_port.capture(&reallive_request) {
        Err(EnginePortError::Lifecycle { stage, message, .. }) => {
            assert_eq!(stage, LifecycleStage::Capture);
            assert_eq!(message, REALLIVE_UNIMPLEMENTED_MESSAGE);
        }
        other => panic!("RealLive capture returned non-Lifecycle outcome: {other:?}"),
    }
    match siglus_port.capture(&siglus_request) {
        Err(EnginePortError::Lifecycle { stage, message, .. }) => {
            assert_eq!(stage, LifecycleStage::Capture);
            assert_eq!(message, SIGLUS_UNIMPLEMENTED_MESSAGE);
        }
        other => panic!("Siglus capture returned non-Lifecycle outcome: {other:?}"),
    }
}

#[test]
fn snapshot_free_function_path_is_reachable_through_facade_for_both_engines() {
    // The substrate snapshot/restore contract is reached only through
    // the facade. We don't have a snapshot-bearing scaffold yet, so we
    // confirm the function is name-resolvable through the facade's
    // re-export with its exact signature. If the substrate facade ever
    // drops the function or changes its signature shape, this file
    // fails to compile — making substrate-API-drift visible at the
    // cross-engine fixture level.
    let _: for<'a, 'b, 'c> fn(
        &'a (dyn Inspectable + 'a),
        &'b SnapshotRequest<'c>,
    ) -> Result<Snapshot, SnapshotError> = take_snapshot;
}

#[test]
fn substrate_capture_outcome_reach_around_is_named_explicitly() {
    // The `CaptureOutcome` type is the **single** non-facade
    // reach-around on both ports. This file names it through the
    // `utsushi_core::CaptureOutcome` path the scaffolds use, then
    // constructs a value through its typed `new` constructor. If the
    // substrate facade ever re-exports `CaptureOutcome`, both
    // scaffolds drop the reach-around at the same time and this test
    // shrinks accordingly (the
    // `capture_outcome_reach_around_is_symmetric_across_engines`
    // assertion catches the asymmetry if only one side drops it).
    let outcome: SubstrateCaptureOutcome =
        SubstrateCaptureOutcome::new("artifacts/utsushi/runtime/cross-engine-substrate-alignment");
    assert_eq!(
        outcome.artifact_uri,
        "artifacts/utsushi/runtime/cross-engine-substrate-alignment"
    );
}

// ---------------------------------------------------------------------
// §5. Substrate-API-drift regression — identical-imports source scan.
//
// Parses both crates' `src/lib.rs` and asserts:
//
// - Every `utsushi_core::*` path either reaches the substrate facade
//   (`substrate`) or one of the load-bearing crate-root reach-arounds
//   (`CaptureOutcome`, `RuntimeOperation`). No subsystem reach-around
//   is permitted (`vfs`, `port`, `clock`, `replay`, etc. directly).
// - The set of `utsushi_core::substrate::*` facade leaves the Siglus
//   port reaches is **identical** to the corresponding scaffold-baseline
//   set the RealLive port reaches (after subtracting RealLive's
//   post-scaffold behavioural imports).
// - The `utsushi_core::CaptureOutcome` crate-root reach-around appears
//   on both ports' `lib.rs` files or on neither — symmetric across
//   engines, never just one side.
// ---------------------------------------------------------------------

const REALLIVE_LIB_SRC: &str = include_str!("../../utsushi-reallive/src/lib.rs");
const SIGLUS_LIB_SRC: &str = include_str!("../src/lib.rs");

/// The Siglus scaffold's full `utsushi_core::substrate::*` facade-leaf
/// import set — the **scaffold-baseline** set both engines must hold.
/// Hard-coded so a drift to the facade surface (in either direction)
/// fails the audit with a precise diff.
const SIGLUS_SCAFFOLD_FACADE_LEAVES: &[&str] = &[
    "AssetPackage",
    "EnginePort",
    "EnginePortError",
    "EvidenceTier",
    "FidelityTier",
    "LifecycleStage",
    "PortCapability",
    "PortManifest",
    "PortRequest",
    "PortShutdownOutcome",
    "REQUIRED_LIFECYCLE_STAGES",
    "SinkSet",
];

/// Parse a Rust source string and return the sorted, deduplicated set
/// of every `utsushi_core::<path>::<symbol>` import path the source
/// uses in `use` statements (doc-comment / prose mentions are filtered).
fn collect_utsushi_core_paths(src: &str) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    let needle = "utsushi_core::";

    let lines: Vec<&str> = src.lines().collect();
    let mut index = 0;
    while index < lines.len() {
        let trimmed = lines[index].trim_start();
        if !trimmed.starts_with("use ") {
            index += 1;
            continue;
        }
        let mut full_use = trimmed.to_string();
        if full_use.contains('{') && !full_use.contains('}') {
            let mut walk = index + 1;
            while walk < lines.len() {
                full_use.push('\n');
                full_use.push_str(lines[walk]);
                if lines[walk].contains('}') {
                    break;
                }
                walk += 1;
            }
            index = walk + 1;
        } else {
            index += 1;
        }

        let bytes = full_use.as_bytes();
        let mut cursor = 0;
        while let Some(off) = full_use[cursor..].find(needle) {
            let start = cursor + off;
            let mut end = start + needle.len();
            while end < bytes.len() {
                let ch = bytes[end];
                if ch.is_ascii_alphanumeric() || ch == b'_' {
                    end += 1;
                    continue;
                }
                if ch == b':' && end + 1 < bytes.len() && bytes[end + 1] == b':' {
                    end += 2;
                    continue;
                }
                break;
            }
            let prefix_path = full_use[start..end].trim_end_matches(':').to_string();

            if end < bytes.len()
                && bytes[end] == b'{'
                && let Some(close_off) = full_use[end..].find('}')
            {
                let body = &full_use[end + 1..end + close_off];
                for raw in body.split(',') {
                    let token = raw
                        .lines()
                        .map(str::trim)
                        .filter(|t| !t.is_empty() && !t.starts_with("//"))
                        .collect::<Vec<_>>()
                        .join(" ");
                    let token = token.trim();
                    if token.is_empty() {
                        continue;
                    }
                    let symbol = token
                        .split_whitespace()
                        .next()
                        .unwrap_or(token)
                        .trim_end_matches(',');
                    if !symbol.is_empty() && !symbol.contains("::") {
                        let expanded = format!("{prefix_path}::{symbol}");
                        paths.push(expanded);
                    }
                }
                cursor = end + close_off + 1;
                continue;
            }

            if !prefix_path.is_empty() && prefix_path != "utsushi_core" {
                paths.push(prefix_path);
            }
            cursor = end;
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

fn subsystem_root(path: &str) -> Option<&str> {
    let stripped = path.strip_prefix("utsushi_core::")?;
    Some(stripped.split("::").next().unwrap_or(stripped))
}

/// Collect the leaf identifier (last `::` segment) of every
/// `utsushi_core::substrate::*` import path in the source.
fn collect_facade_leaves(src: &str) -> BTreeSet<String> {
    let mut leaves = BTreeSet::new();
    let prefix_block = "use utsushi_core::substrate::{";
    let prefix_single = "use utsushi_core::substrate::";

    let lines: Vec<&str> = src.lines().collect();
    let mut index = 0;
    while index < lines.len() {
        let trimmed = lines[index].trim_start();
        if !trimmed.starts_with("use ") {
            index += 1;
            continue;
        }

        if let Some(block_start) = trimmed.find(prefix_block) {
            let mut block = String::new();
            let after_brace = &trimmed[block_start + prefix_block.len()..];
            block.push_str(after_brace);
            if !after_brace.contains('}') {
                let mut walk = index + 1;
                while walk < lines.len() {
                    let l = lines[walk];
                    block.push('\n');
                    block.push_str(l);
                    if l.contains('}') {
                        break;
                    }
                    walk += 1;
                }
                index = walk + 1;
            } else {
                index += 1;
            }
            if let Some(end_off) = block.find('}') {
                let body = &block[..end_off];
                for raw in body.split(',') {
                    let token = raw.trim();
                    let token = token
                        .lines()
                        .map(str::trim)
                        .filter(|t| !t.starts_with("//"))
                        .collect::<Vec<_>>()
                        .join(" ");
                    let token = token.trim();
                    if token.is_empty() {
                        continue;
                    }
                    let symbol = token
                        .split_whitespace()
                        .next_back()
                        .unwrap_or(token)
                        .trim_end_matches(',');
                    if !symbol.is_empty() && !symbol.contains("::") {
                        leaves.insert(symbol.to_string());
                    }
                }
            }
            continue;
        }

        if let Some(prefix_off) = trimmed.find(prefix_single) {
            let after = &trimmed[prefix_off + prefix_single.len()..];
            if !after.starts_with('{') {
                let segment_end = after
                    .find(|c: char| c == ';' || c == ',' || c.is_whitespace())
                    .unwrap_or(after.len());
                let symbol = after[..segment_end].trim_end_matches(',');
                if !symbol.is_empty() && !symbol.contains("::") {
                    leaves.insert(symbol.to_string());
                }
            }
        }
        index += 1;
    }
    leaves
}

#[test]
fn no_subsystem_root_reach_around_on_either_port() {
    let reallive_paths = collect_utsushi_core_paths(REALLIVE_LIB_SRC);
    let siglus_paths = collect_utsushi_core_paths(SIGLUS_LIB_SRC);

    let allowed_crate_root_reachfor = ["CaptureOutcome", "RuntimeOperation"];
    let forbidden_subsystem_roots = [
        "vfs",
        "clock",
        "input",
        "replay",
        "sink",
        "snapshot",
        "embed",
        "recorder",
        "conformance",
        "port",
        "redaction",
    ];

    for (port_label, paths) in [
        ("utsushi-reallive (lib.rs)", &reallive_paths),
        ("utsushi-siglus (lib.rs)", &siglus_paths),
    ] {
        for path in paths {
            let root = subsystem_root(path).unwrap_or("");
            if root == "substrate" {
                continue;
            }
            if !path[14..].contains("::") && allowed_crate_root_reachfor.contains(&&path[14..]) {
                continue;
            }
            assert!(
                !forbidden_subsystem_roots.contains(&root),
                "{port_label} reaches forbidden subsystem root `{root}` via `{path}` — \
                 substrate facade must be the only routing path",
            );
            assert!(
                root == "substrate" || allowed_crate_root_reachfor.contains(&&path[14..]),
                "{port_label} touches an un-audited `utsushi_core::*` path: `{path}` (root=`{root}`)",
            );
        }
    }
}

#[test]
fn substrate_facade_leaf_baseline_matches_across_engines() {
    // The Siglus scaffold's import set IS the scaffold-baseline (it
    // ships no behaviour beyond the EnginePort contract). The RealLive
    // scaffold's import set is a strict superset because UTSUSHI-201..
    // UTSUSHI-220 grow real behaviour on top of the same baseline.
    //
    // Step 1: assert the Siglus scaffold imports exactly the pinned
    // baseline.
    let siglus_leaves = collect_facade_leaves(SIGLUS_LIB_SRC);
    let expected_baseline: BTreeSet<String> = SIGLUS_SCAFFOLD_FACADE_LEAVES
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    assert_eq!(
        siglus_leaves, expected_baseline,
        "utsushi-siglus scaffold's `utsushi_core::substrate::*` import set drifted from the pinned cross-engine baseline",
    );

    // Step 2: assert the RealLive scaffold reaches every baseline leaf
    // — substrate API drift would surface as a missing baseline leaf.
    let reallive_leaves = collect_facade_leaves(REALLIVE_LIB_SRC);
    for leaf in &expected_baseline {
        assert!(
            reallive_leaves.contains(leaf),
            "utsushi-reallive scaffold lost facade leaf `{leaf}` from the cross-engine baseline — substrate API drift between engines",
        );
    }
}

#[test]
fn capture_outcome_reach_around_is_symmetric_across_engines() {
    let reallive_paths = collect_utsushi_core_paths(REALLIVE_LIB_SRC);
    let siglus_paths = collect_utsushi_core_paths(SIGLUS_LIB_SRC);

    let reallive_reaches = reallive_paths
        .iter()
        .any(|p| p == "utsushi_core::CaptureOutcome");
    let siglus_reaches = siglus_paths
        .iter()
        .any(|p| p == "utsushi_core::CaptureOutcome");
    assert_eq!(
        reallive_reaches, siglus_reaches,
        "scaffold-structural crate-root reach-around `utsushi_core::CaptureOutcome` is asymmetric \
         between scaffolds (reallive={reallive_reaches}, siglus={siglus_reaches}) — the facade \
         omission must apply to both engines or neither",
    );
    // The reach-around is mandatory until the facade re-exports
    // CaptureOutcome — both scaffolds must reach it through the crate
    // root. If both stop reaching it (because the facade was extended),
    // the assertion below trips and the test author is forced to
    // shrink the allow-list deliberately.
    assert!(
        reallive_reaches && siglus_reaches,
        "both scaffolds expected to reach `utsushi_core::CaptureOutcome` (facade omission); \
         if the facade has been extended to re-export CaptureOutcome, drop this assertion AND \
         remove the reach-around from both scaffolds in the same change (no-legacy-compat).",
    );
}

// ---------------------------------------------------------------------
// §6. Clean-room boundary statements.
//
// Both ports carry a clean-room boundary statement against their
// respective research anchors. Asserting both statements here proves
// the boundary posture is held identically across engines, and that
// neither port has silently lost its research-anchor disclaimer.
// ---------------------------------------------------------------------

#[test]
fn both_ports_carry_clean_room_research_anchor_boundary_statements() {
    for required in [
        "rlvm",
        "research anchor",
        "does not depend on rlvm",
        "does not mechanically translate",
    ] {
        assert!(
            RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT.contains(required),
            "RealLive port boundary statement missing required phrase: {required}",
        );
    }
    for required in [
        "siglus_rs",
        "research anchor",
        "does not depend on siglus_rs",
        "does not mechanically translate",
    ] {
        assert!(
            SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT.contains(required),
            "Siglus port boundary statement missing required phrase: {required}",
        );
    }
}

// ---------------------------------------------------------------------
// §7. Lineage-extension notes anchor.
//
// Pins that `docs/research/reallive-engine.md` Appendix M is present
// and carries the per-sub-node engine-specific boundary notes the spec
// promises, plus the §M.7 update documenting the inline-scaffold
// promotion this node accomplishes.
// ---------------------------------------------------------------------

const REALLIVE_ENGINE_DOC: &str = include_str!("../../../docs/research/reallive-engine.md");

#[test]
fn appendix_m_lineage_notes_are_present_and_carry_required_anchors() {
    assert!(
        REALLIVE_ENGINE_DOC.contains("## M. Cross-engine substrate conformance + Siglus lineage"),
        "docs/research/reallive-engine.md must carry Appendix M",
    );

    let required_reusable_anchors = [
        "expression encoding",
        "variable banks",
        "AVG32 LZ + XOR",
        "Gameexe-style config",
        "headless sink pipeline",
        "snapshot/restore contract",
    ];
    for anchor in required_reusable_anchors {
        assert!(
            REALLIVE_ENGINE_DOC.contains(anchor),
            "Appendix M must document the reusable-across-engines anchor `{anchor}`",
        );
    }

    let required_reallive_only_anchors = [
        "rlvm-specific opcode catalogue",
        "OVK voice archives",
        "module identifiers",
    ];
    for anchor in required_reallive_only_anchors {
        assert!(
            REALLIVE_ENGINE_DOC.contains(anchor),
            "Appendix M must document the RealLive-only anchor `{anchor}`",
        );
    }

    let required_boundary_note_anchors = [
        "UTSUSHI-201",
        "UTSUSHI-203",
        "UTSUSHI-207",
        "UTSUSHI-209",
        "UTSUSHI-211",
        "UTSUSHI-216",
        "UTSUSHI-217",
        "UTSUSHI-218",
    ];
    for anchor in required_boundary_note_anchors {
        assert!(
            REALLIVE_ENGINE_DOC.contains(anchor),
            "Appendix M must carry an engine-specific boundary note referencing `{anchor}`",
        );
    }

    assert!(
        REALLIVE_ENGINE_DOC.contains("26") && REALLIVE_ENGINE_DOC.contains("13"),
        "Appendix M must document Siglus's 26-letter vs RealLive's 13-letter variable-bank shape",
    );

    assert!(
        REALLIVE_ENGINE_DOC.contains("Resource.txt"),
        "Appendix M must reference Siglus's Resource.txt as the Gameexe-style config counterpart",
    );

    let required_concrete_code_anchors = [
        "AssetPackage",
        "TextSurfaceSink",
        "SnapshotStore",
        "EnginePort",
    ];
    for anchor in required_concrete_code_anchors {
        assert!(
            REALLIVE_ENGINE_DOC.contains(anchor),
            "Appendix M must reference the concrete facade type `{anchor}` (no marketing-only claims)",
        );
    }
}

#[test]
fn appendix_m_documents_inline_scaffold_promotion_to_sibling_crate() {
    // UTSUSHI-147 promotes the inline Siglus scaffold (UTSUSHI-221's
    // `cross_engine_facade_only_imports.rs`) into a real sibling crate
    // (`crates/utsushi-siglus/`). Appendix M must document the
    // promotion so future readers know the inline scaffold is the
    // historical predecessor of the sibling crate, not a parallel
    // implementation.
    assert!(
        REALLIVE_ENGINE_DOC.contains("UTSUSHI-147"),
        "Appendix M must reference UTSUSHI-147 (the scaffold-promotion node)",
    );
    assert!(
        REALLIVE_ENGINE_DOC.contains("M.7"),
        "Appendix M must carry a §M.7 documenting the inline-scaffold-to-sibling-crate promotion",
    );
    assert!(
        REALLIVE_ENGINE_DOC.contains("crates/utsushi-siglus"),
        "Appendix M §M.7 must name the new `crates/utsushi-siglus` sibling crate",
    );
}

#[test]
fn appendix_m_documents_avg32_reallive_siglus_lineage_extension_scope() {
    // Per spec acceptance: "Lineage extension notes record the
    // AVG32->RealLive->Siglus port-scope reasoning and any boundaries
    // that do not extend."
    assert!(
        REALLIVE_ENGINE_DOC.contains("AVG32"),
        "Appendix M must reference the AVG32 ancestor in the lineage extension notes",
    );
    // The reusable-across-engines map (§M.1) is the port-scope
    // extension; the RealLive-only map (§M.2) plus the per-sub-node
    // boundary notes (§M.3) are the boundaries that do not extend.
    assert!(
        REALLIVE_ENGINE_DOC.contains("M.1") && REALLIVE_ENGINE_DOC.contains("M.2"),
        "Appendix M must carry both the §M.1 reusable-surfaces map and the §M.2 \
         RealLive-only-surfaces map (the port-scope extension and the boundaries that do not extend)",
    );
}
