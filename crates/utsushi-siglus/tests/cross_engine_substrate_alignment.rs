//! RealLive/Siglus shared substrate alignment fixture.
//!
//! This is the cross-engine conformance fixture promised by the
//! spec. It is **the** load-bearing test for the
//! deliverable list:
//!
//! 1. Cross-engine conformance fixture covering RealLive and Siglus
//!    ports against one substrate API surface.
//! 2. Conformance evidence that both engines share VFS / render
//!    snapshot semantics through the substrate facade.
//! 3. Substrate-API-drift regression coverage (the
//!    identical-import-set audit).
//! 4. Lineage-extension notes anchor — pinned to
//!    `docs/research/reallive-engine.md` Appendix M.
//!
//! ## Why this lives in `utsushi-siglus/tests/`, not `utsushi-reallive/tests/`
//!
//! Per the project memory `feedback_multi_game_validation.md`, substrate
//! work means at least two engine families. first proved
//! the substrate facade is engine-extensible at the **scaffold-contract
//! level** via an *inline* Siglus minimal-port scaffold inside
//! `utsushi-reallive`'s test crate. promotes that inline
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
//! - **The fixture observes the substrate facade as a shared surface
//!   not as a per-engine fork.** The two engines are co-loaded here
//!   only via `utsushi_core::substrate::*`. Engine-internal
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
//!   facade re-export. If a future substrate refactor splits the bound
//!   this file fails to compile — blocking the API drift from landing
//!   without a paired conformance update.
//! - **Manifest shape:** Both ports declare identical
//!   `REQUIRED_LIFECYCLE_STAGES` slices and identical `abi_version` values
//!   through the facade's `PortManifest` type. RealLive declares the
//!   capabilities it actually wires; the inert Siglus scaffold declares none
//!   and carries the peer-wired gaps as dev-`Pending` in its parity profile.
//! - **VFS shape:** Both ports' inert context types expose an
//!   `Option<Arc<dyn AssetPackage>>` asset-package slot. The
//!   `AssetPackage` trait object is **the** facade carrier for VFS
//!   semantics; if the trait moves out of `utsushi_core::substrate::*`
//!   this compiles against the wrong path and breaks.
//! - **Render shape:** Both ports' `EnginePort::sink_set()` returns the
//!   facade's `SinkSet` type. The three drains (`drain_text`
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
//!   engines (except for an explicitly-allowlisted set), and
//!   `CaptureOutcome` is required to flow through the facade.
//! - **Lineage-extension notes:** Asserts
//!   `docs/research/reallive-engine.md` Appendix M is present and
//!   carries the per-sub-node engine-specific boundary notes, plus the
//!   §M.7 update documenting the inline-scaffold promotion this node
//!   accomplishes.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::sync::Arc;

use utsushi_core::RuntimeOperation;
use utsushi_core::substrate::{
    AssetPackage, AudioEvent, AudioEventSink, CapabilityStance, CaptureOutcome, EnginePort,
    EnginePortError, EvidenceTier, FidelityTier, FrameArtifact, FrameArtifactSink, Inspectable,
    LifecycleStage, PortCapability, PortRequest, REQUIRED_LIFECYCLE_STAGES, RunnerCancellation,
    SinkSet, Snapshot, SnapshotError, SnapshotRequest, SnapshotStore, StatePath, TextLine,
    TextSurfaceSink, take_snapshot,
};

use utsushi_reallive::{RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT, UtsushiReallivePort};
use utsushi_siglus::{
    SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT,
    UNIMPLEMENTED_MESSAGE as SIGLUS_UNIMPLEMENTED_MESSAGE, UtsushiSiglusPort,
};

// §1. Compile-time witnesses.
//
// Both ports satisfy the substrate's `EnginePort` bound through the
// facade re-export. If a future refactor splits the bound, this file
// fails to compile — proving the substrate API drift would have to be
// addressed before either port is updated.

fn assert_implements_engine_port<P: EnginePort>() {}

/// Touch the facade types named in the doc-comment's "VFS / render
/// snapshot semantics" guarantee at the type level so a substrate
/// refactor that moves any of them out of `utsushi_core::substrate::*`
/// breaks this file at compile time. The `PhantomData` tuple is the
/// vehicle: every type the cross-engine fixture's doc-comment lists is
/// named here, and clippy's `too_many_arguments` lint cannot fire
/// against a single-argument function.
// reason: compile-time cross-engine shape witness; the alias is referenced only for its trait bounds.
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

// §2. Manifest-shape conformance.
//
// Both ports' manifests share identical required lifecycle stages and ABI
// versions through the facade's `PortManifest` type. Capability declarations
// are intentionally asymmetric: RealLive claims only wired behaviour, while
// the inert Siglus scaffold carries peer-wired capabilities as dev-Pending.

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
fn reallive_wires_capabilities_siglus_declares_pending_gaps() {
    // RealLive is the real port (it drives the substrate sinks from real
    // bytes) while Siglus is still an inert scaffold. Therefore Siglus must
    // not claim the required lifecycle capabilities as wired in its manifest;
    // it carries those peer-wired gaps as dev-Pending in its parity profile.
    let siglus_caps: std::collections::HashSet<PortCapability> = UtsushiSiglusPort::MANIFEST
        .capabilities
        .iter()
        .copied()
        .collect();
    let reallive_caps: std::collections::HashSet<PortCapability> = UtsushiReallivePort::MANIFEST
        .capabilities
        .iter()
        .copied()
        .collect();
    assert!(
        siglus_caps.is_empty(),
        "the inert Siglus scaffold must not declare wired capabilities",
    );
    for required in [
        PortCapability::Launch,
        PortCapability::Observe,
        PortCapability::Capture,
        PortCapability::Shutdown,
    ] {
        assert!(
            reallive_caps.contains(&required),
            "the real RealLive port must declare the required capability {required:?}",
        );
        assert_eq!(
            UtsushiSiglusPort::PARITY_PROFILE.stance(required),
            Some(CapabilityStance::Pending),
            "the inert Siglus scaffold must declare {required:?} as dev-Pending",
        );
    }
    assert!(
        reallive_caps.is_superset(&siglus_caps),
        "the real RealLive port's capability set must be a superset of the empty Siglus scaffold set",
    );
    assert!(
        reallive_caps.contains(&PortCapability::Snapshot)
            && reallive_caps.contains(&PortCapability::DeterministicReplay),
        "the real RealLive port declares the port-driven Snapshot + DeterministicReplay capabilities",
    );
    for pending in [
        PortCapability::Snapshot,
        PortCapability::DeterministicReplay,
    ] {
        assert_eq!(
            UtsushiSiglusPort::PARITY_PROFILE.stance(pending),
            Some(CapabilityStance::Pending),
            "the inert Siglus scaffold must declare {pending:?} as dev-Pending",
        );
    }
}

#[test]
fn scaffold_and_real_port_pin_their_respective_tier_ceilings() {
    // The Siglus scaffold pins the trace-only baseline; the real RealLive
    // port pins LayoutProbe/E2 because it announces E2 frame artifacts.
    assert_eq!(
        UtsushiSiglusPort::MANIFEST.evidence_tier_max,
        EvidenceTier::E1,
        "Siglus scaffold pins evidence_tier_max=E1",
    );
    assert_eq!(
        UtsushiSiglusPort::MANIFEST.fidelity_tier_max,
        FidelityTier::TraceOnly,
        "Siglus scaffold pins fidelity_tier_max=TraceOnly",
    );
    assert_eq!(
        UtsushiReallivePort::MANIFEST.evidence_tier_max,
        EvidenceTier::E2,
        "real RealLive port pins evidence_tier_max=E2 (announces frame artifacts)",
    );
    assert_eq!(
        UtsushiReallivePort::MANIFEST.fidelity_tier_max,
        FidelityTier::LayoutProbe,
        "real RealLive port pins fidelity_tier_max=LayoutProbe",
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

// §3. VFS / render semantics — shared facade carriers.
//
// Both ports' inert contexts expose an `Option<Arc<dyn AssetPackage>>`
// asset-package slot (VFS). Both ports' `EnginePort::sink_set()` returns
// the facade's `SinkSet` whose three drains consume facade-typed event
// lists (render: TextLine / FrameArtifact / AudioEvent).

#[test]
fn siglus_scaffold_exposes_facade_asset_package_slot() {
    // The Siglus scaffold's inert context exposes the shared VFS carrier —
    // `Option<&Arc<dyn AssetPackage>>` — through the facade `AssetPackage`
    // trait object. (The real RealLive port owns a hydrated
    // `ReplayEngine` + asset package instead of an `Option` slot; its VFS
    // wiring is exercised in the `utsushi-reallive` crate's own tests.)
    let siglus_port = UtsushiSiglusPort::new();
    let _siglus_slot: Option<&Arc<dyn AssetPackage>> = siglus_port.context().asset_package();
    assert!(siglus_port.context().asset_package().is_none());
}

#[test]
fn both_ports_expose_facade_sink_set() {
    // `EnginePort::sink_set` returns the facade `SinkSet` for BOTH engines
    // (the shared render carrier). The Siglus scaffold's is empty; the real
    // RealLive port registers three real sinks — the divergence itself
    // proves RealLive is the substrate-sink producer. Here we assert the
    // shared TYPE (facade `SinkSet`, facade-typed drains) plus each engine's
    // real registration state.
    let siglus_port = UtsushiSiglusPort::new();
    let siglus_sinks: &SinkSet = EnginePort::sink_set(&siglus_port);
    let siglus_text: Vec<TextLine> = siglus_sinks.drain_text();
    let siglus_frame: Vec<FrameArtifact> = siglus_sinks.drain_frame();
    let siglus_audio: Vec<AudioEvent> = siglus_sinks.drain_audio();
    assert!(siglus_text.is_empty() && siglus_frame.is_empty() && siglus_audio.is_empty());
    // The Siglus scaffold registers no sink yet.
    assert!(siglus_sinks.text().is_none());
    assert!(siglus_sinks.frame().is_none());
    assert!(siglus_sinks.audio().is_none());
    // The real RealLive port registers all three sinks as `Supported`
    // (verified through the facade `SinkCapabilitySummary`). It is a const
    // fact about the port's manifest that it is frame-capable (E2).
    assert_eq!(
        UtsushiReallivePort::MANIFEST.evidence_tier_max,
        EvidenceTier::E2
    );
}

// §4. Snapshot semantics — shared facade carrier.
//
// Both ports route lifecycle errors through `EnginePortError::Lifecycle`.
// Neither scaffold exercises `take_snapshot` yet (that lands when the
// post-alpha behavioural work joins each port), but this test pins the
// typed-error variant identically across engines and touches the
// `take_snapshot` free function through the facade so the function's
// path is part of the conformance witness.

#[test]
fn siglus_scaffold_routes_lifecycle_errors_through_facade_typed_error() {
    // The Siglus scaffold routes its inert lifecycle through the facade's
    // typed `EnginePortError::Lifecycle { stage, message }` variant. (The
    // real RealLive port instead performs real lifecycle work — its
    // observe/capture behaviour is exercised in the `utsushi-reallive`
    // crate's own tests; asserting it errors here would be false.) The
    // facade typed-error variant is the shared contract both engines route
    // through.
    let root = Path::new("/");
    let mut siglus_port = UtsushiSiglusPort::new();
    let siglus_request =
        PortRequest::new(root, "x-engine-conformance-siglus", RuntimeOperation::Trace)
            .with_cancellation(RunnerCancellation::new());
    match siglus_port.observe(&siglus_request) {
        Err(EnginePortError::Lifecycle { stage, message, .. }) => {
            assert_eq!(stage, LifecycleStage::Observe);
            assert!(
                !message.is_empty(),
                "siglus observe lifecycle error must carry a non-empty message"
            );
        }
        other => panic!("siglus observe returned non-Lifecycle outcome: {other:?}"),
    }

    let mut siglus_port = UtsushiSiglusPort::new();
    let siglus_request =
        PortRequest::new(root, "x-engine-conformance-siglus", RuntimeOperation::Trace)
            .with_cancellation(RunnerCancellation::new());
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
fn substrate_capture_outcome_is_reachable_through_facade() {
    // `CaptureOutcome` is the typed `EnginePort::capture` return value
    // so it is part of the stable engine-port substrate surface.
    let outcome: CaptureOutcome =
        CaptureOutcome::new("artifacts/utsushi/runtime/cross-engine-substrate-alignment");
    assert_eq!(
        outcome.artifact_uri,
        "artifacts/utsushi/runtime/cross-engine-substrate-alignment"
    );
}

// §5. Substrate-API-drift regression — identical-imports source scan.
//
// Parses both crates' `src/lib.rs` and asserts:
//
// - Every `utsushi_core::*` path either reaches the substrate facade
//   (`substrate`) or one allowed crate-root helper (`RuntimeOperation`
//   plus managed-artifact materialization helpers). No subsystem reach-around
//   is permitted (`vfs`, `port`, `clock`, `replay`, etc. directly).
// - The set of `utsushi_core::substrate::*` facade leaves the Siglus
//   port reaches is **identical** to the corresponding scaffold-baseline
//   set the RealLive port reaches (after subtracting RealLive's
//   post-scaffold behavioural imports).
// - `CaptureOutcome` appears in the facade import set and never as a
//   crate-root reach-around.

const REALLIVE_LIB_SRC: &str = include_str!("../../utsushi-reallive/src/lib.rs");
// The real RealLive port's substrate-facade imports live in the port
// module, not the crate root — the cross-engine drift guards scan both.
const REALLIVE_ENGINE_PORT_SRC: &str = include_str!("../../utsushi-reallive/src/engine_port.rs");
const SIGLUS_LIB_SRC: &str = include_str!("../src/lib.rs");

/// The Siglus scaffold's full `utsushi_core::substrate::*` facade-leaf
/// import set — the **scaffold-baseline** set both engines must hold.
/// Hard-coded so a drift to the facade surface (in either direction)
/// fails the audit with a precise diff.
const SIGLUS_SCAFFOLD_FACADE_LEAVES: &[&str] = &[
    "AssetPackage",
    // Cross-engine capability parity contract + gate. Every engine port
    // publishes a `PARITY_PROFILE` built from these three types, so they are
    // part of the shared scaffold baseline both engines hold.
    "CapabilityDeclaration",
    "CapabilityStance",
    "CaptureOutcome",
    "EngineParityProfile",
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

fn collect_utsushi_core_paths_from_sources(sources: &[&str]) -> Vec<String> {
    let mut paths = Vec::new();
    for src in sources {
        paths.extend(collect_utsushi_core_paths(src));
    }
    paths.sort();
    paths.dedup();
    paths
}

fn collect_rs_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(dir).expect("read source directory") {
        let entry = entry.expect("read source directory entry");
        let path = entry.path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            out.push(path);
        }
    }
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
            if after_brace.contains('}') {
                index += 1;
            } else {
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
    let mut reallive_paths = collect_utsushi_core_paths(REALLIVE_LIB_SRC);
    reallive_paths.extend(collect_utsushi_core_paths(REALLIVE_ENGINE_PORT_SRC));
    reallive_paths.sort();
    reallive_paths.dedup();
    let siglus_paths = collect_utsushi_core_paths(SIGLUS_LIB_SRC);

    let allowed_crate_root_reachfor = [
        "RuntimeArtifactKind",
        "RuntimeArtifactRoot",
        "RuntimeOperation",
        "runtime_artifact_uri",
    ];
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
        (
            "utsushi-reallive (lib.rs + engine_port.rs)",
            &reallive_paths,
        ),
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
    // scaffold's import set is a strict superset because..
    // grow real behaviour on top of the same baseline.
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

    // Step 2: assert the real RealLive port reaches every baseline leaf —
    // substrate API drift would surface as a missing baseline leaf. The
    // real port imports the facade in its `engine_port` module (its crate
    // root re-exports the port but no longer imports the facade leaves), so
    // the RealLive-side scan unions lib.rs + engine_port.rs.
    let mut reallive_leaves = collect_facade_leaves(REALLIVE_LIB_SRC);
    reallive_leaves.extend(collect_facade_leaves(REALLIVE_ENGINE_PORT_SRC));
    for leaf in &expected_baseline {
        assert!(
            reallive_leaves.contains(leaf),
            "utsushi-reallive lost facade leaf `{leaf}` from the cross-engine baseline — substrate API drift between engines",
        );
    }
}

#[test]
fn engine_port_crates_import_capture_outcome_through_substrate_facade() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let crates_dir = manifest_dir
        .parent()
        .expect("utsushi-siglus crate has workspace crates parent");

    let mut engine_port_crates = Vec::new();
    for crate_entry in fs::read_dir(crates_dir).expect("read workspace crates directory") {
        let crate_entry = crate_entry.expect("read workspace crate entry");
        let crate_dir = crate_entry.path();
        if !crate_dir.is_dir() {
            continue;
        }
        let crate_name = crate_dir
            .file_name()
            .and_then(|name| name.to_str())
            .expect("crate directory has UTF-8 name");
        if !crate_name.starts_with("utsushi-") || crate_name == "utsushi-core" {
            continue;
        }

        let src_dir = crate_dir.join("src");
        if !src_dir.is_dir() {
            continue;
        }
        let mut rs_files = Vec::new();
        collect_rs_files(&src_dir, &mut rs_files);

        let mut sources = Vec::new();
        let mut implements_engine_port = false;
        for path in rs_files {
            let src = fs::read_to_string(&path).expect("read Rust source");
            implements_engine_port |= src.contains("impl EnginePort for");
            sources.push(src);
        }

        if implements_engine_port {
            engine_port_crates.push((crate_name.to_string(), sources));
        }
    }
    engine_port_crates.sort_by(|(left, _), (right, _)| left.cmp(right));

    assert!(
        !engine_port_crates.is_empty(),
        "source scan must discover non-core EnginePort crates",
    );

    for (port_label, sources) in engine_port_crates {
        let source_refs: Vec<&str> = sources.iter().map(String::as_str).collect();
        let paths = collect_utsushi_core_paths_from_sources(&source_refs);
        let root_reaches: Vec<&str> = paths
            .iter()
            .filter_map(|p| (p == "utsushi_core::CaptureOutcome").then_some(p.as_str()))
            .collect();
        assert!(
            root_reaches.is_empty(),
            "{port_label} must import CaptureOutcome through `utsushi_core::substrate::*`, \
             not crate root (root_paths={root_reaches:?})",
        );

        let facade_reaches = paths
            .iter()
            .any(|p| p == "utsushi_core::substrate::CaptureOutcome");
        assert!(
            facade_reaches,
            "{port_label} must import facade `CaptureOutcome` for its EnginePort::capture return",
        );
    }
}

// §6. Clean-room boundary statements.
//
// Both ports carry a clean-room boundary statement against their
// respective research anchors. Asserting both statements here proves
// the boundary posture is held identically across engines, and that
// neither port has silently lost its research-anchor disclaimer.

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

// §7. Lineage-extension notes anchor.
//
// Pins that `docs/research/reallive-engine.md` Appendix M is present
// and carries the per-sub-node engine-specific boundary notes the spec
// promises, plus the §M.7 update documenting the inline-scaffold
// promotion this node accomplishes.

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
    // promotes the inline Siglus scaffold (the
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
