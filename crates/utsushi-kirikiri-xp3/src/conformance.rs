//! UTSUSHI-181 — `utsushi-kirikiri-xp3` **conformance manifest**.
//!
//! Builds the engine-neutral [`utsushi_core::port::impl_map::ImplementationMap`]
//! that wires this port through the substrate facade: it declares the engine
//! family (KiriKiri/KAG), the native/browser TJS runtime-delegation posture
//! (an `Unsupported` subsystem — the Rust port implements no KAG/TJS opcode
//! dispatch), and the one thing this port genuinely covers (`Supported`:
//! emitting a clean-room attestation + passing substrate conformance).
//!
//! The map validates + promotes via
//! [`utsushi_core::port::impl_map::validate_and_promote`], and links to the
//! port's [`crate::KirikiriXp3EnginePort::MANIFEST`] via
//! [`utsushi_core::port::impl_map::validate_against_manifest`] (port-id match +
//! engine-family manifest-prefix match). Together those two checks are what
//! "the port is registered through the conformance manifest" means here —
//! there is no global mutable port registry; registration is the manifest ⇄
//! impl-map binding, validated structurally.

use utsushi_core::port::impl_map::{
    CaptureMethod, EngineFamily, ExpectedOutcome, FixtureClassification, FixtureKind, FixtureRef,
    IMPL_MAP_SCHEMA_VERSION, ImplementationMap, PortId, ReferenceBehavior, Status, Subsystem,
    SubsystemId, SubsystemStatus, UnsupportedReason, ValidationCommand, ValidationCommandId,
    sha256_hex,
};

use crate::{CLEAN_ROOM_ATTESTATION_STATEMENT, PORT_ID};

/// Deterministic RFC3339 generation instant (the schema requires RFC3339; the
/// substrate never calls `SystemTime::now()`).
const GENERATED_AT: &str = "2026-07-05T00:00:00Z";

/// Validation command id: the substrate-conformance test that exercises this
/// port's covered subsystem.
const CMD_CONFORMANCE: &str = "kirikiri-xp3-substrate-conformance";

/// A synthetic-inline fixture placeholder. Honest: this port has no retail
/// fixture because it dispatches nothing; the "fixture" is an inline
/// descriptor whose hash commits to its canonical id so the map is
/// reproducible.
fn synthetic_inline_fixture(fixture_id: &str, descriptor: &str) -> FixtureRef {
    FixtureRef {
        id: fixture_id.to_string(),
        classification: FixtureClassification::SyntheticInline,
        kind: FixtureKind::SyntheticInline,
        kind_notes: None,
        hash: sha256_hex(descriptor.as_bytes()),
        byte_count: 0,
    }
}

/// Build the `utsushi-kirikiri-xp3` implementation map in `Draft` status.
///
/// Callers run [`utsushi_core::port::impl_map::validate_and_promote`] to
/// validate + promote to `Validated` (which stamps the audit disclaimer).
pub fn build_kirikiri_xp3_impl_map() -> ImplementationMap {
    ImplementationMap {
        schema_version: IMPL_MAP_SCHEMA_VERSION.to_string(),
        port_id: PortId::new(PORT_ID),
        // The KAG plaintext (.ks) path lives inside the XP3 container but is
        // executed by the KiriKiri/KAG TJS runtime; the `kirikiri-kag`
        // discriminant (manifest prefix `utsushi-kirikiri`) is a prefix of this
        // port's id (`utsushi-kirikiri-xp3`), so `validate_against_manifest`
        // accepts the pairing. The `-xp3` half of the scope (the container the
        // plaintext members arrive in) is recorded in the notes below.
        engine_family: EngineFamily::KirikiriKag,
        engine_family_notes: Some(
            "Covers the KiriKiri/KAG plaintext (.ks) path carried by the XP3 container: KAG script \
             plus TJS is executed by the native KiriKiri2/KirikiriZ shell (or a browser \
             reimplementation). The single `kirikiri-kag` discriminant is used because its manifest \
             prefix (`utsushi-kirikiri`) is a prefix of this port's id; the `-xp3` half of the scope \
             (the plain XP3 the plaintext members are extracted from by the byte owner) is carried \
             here, not in a separate crate."
                .to_string(),
        ),
        subsystems: vec![
            // What this port genuinely covers, exercised by the conformance
            // test: emitting a clean-room attestation + a valid manifest that
            // binds to this map. Supported is honest here — the test passes.
            Subsystem {
                id: SubsystemId::new("clean-room-attestation-and-substrate-conformance"),
                name: "Clean-room attestation + substrate-facade conformance".to_string(),
                status: SubsystemStatus::Supported,
                fixture_ref: synthetic_inline_fixture(
                    "kirikiri-xp3-clean-room-attestation",
                    CLEAN_ROOM_ATTESTATION_STATEMENT,
                ),
                validation_command_id: ValidationCommandId::new(CMD_CONFORMANCE),
                capabilities: vec![
                    "clean-room-attestation".to_string(),
                    "substrate-conformance".to_string(),
                    "manifest-impl-map-binding".to_string(),
                ],
                notes: "The only Supported subsystem. Proves the port emits a from-scratch \
                        clean-room attestation for the KAG plaintext path and that its PortManifest \
                        binds to this implementation map (validate_against_manifest)."
                    .to_string(),
            },
            // The KAG/TJS command runtime itself: NOT implemented in Rust by
            // design. The native/browser KiriKiri TJS engine dispatches every
            // KAG tag, so this port has zero opcode handlers. Declared
            // Unsupported with a semantic code, never Supported/Partial.
            Subsystem {
                id: SubsystemId::new("kag-tjs-command-runtime"),
                name: "KAG/TJS command runtime (native/browser KiriKiri)".to_string(),
                status: SubsystemStatus::Unsupported {
                    reason: UnsupportedReason::SemanticCode(
                        "utsushi.kirikiri_xp3.executed_by_native_or_browser_tjs_runtime".to_string(),
                    ),
                },
                fixture_ref: synthetic_inline_fixture(
                    "kirikiri-xp3-tjs-runtime-delegation",
                    "native/browser KiriKiri TJS is the KAG runtime; zero Rust opcode handlers",
                ),
                validation_command_id: ValidationCommandId::new(CMD_CONFORMANCE),
                capabilities: vec![
                    "native-kirikiri-runtime".to_string(),
                    "browser-kirikiri-runtime".to_string(),
                    "zero-opcode-handlers".to_string(),
                ],
                notes: "The native KiriKiri2/KirikiriZ (or a browser reimplementation) TJS engine \
                        executes every KAG tag. This port implements no opcode dispatch in Rust \
                        (OPCODE_HANDLER_COUNT == 0) — the delegation is by design, not a deferral."
                    .to_string(),
            },
        ],
        validation_commands: vec![ValidationCommand {
            id: ValidationCommandId::new(CMD_CONFORMANCE),
            command: "cargo test -p utsushi-kirikiri-xp3 --test substrate_conformance".to_string(),
            expected_outcome: ExpectedOutcome::Pass,
            caption: "Runs the substrate-facade conformance test: the port resolves the facade \
                      EnginePort bound, its manifest validates, the impl map validates + binds to \
                      the manifest, zero opcode handlers, and the clean-room attestation is present."
                .to_string(),
        }],
        reference_behavior: ReferenceBehavior {
            engine_runtime: "native KiriKiri2/KirikiriZ (or a browser reimplementation) TJS runtime \
                             (the TJS engine IS the KAG runtime; no Rust opcode interpreter)"
                .to_string(),
            observable_signal: "The port declares zero opcode handlers and emits a clean-room \
                                attestation; its PortManifest validates and its ImplementationMap \
                                validates + binds to the manifest via validate_against_manifest. \
                                Any drift in those structural facts falsifies the conformance claim."
                .to_string(),
            // No external oracle: this port drives no runtime, so there is
            // nothing to diff against a reference engine. The validator
            // surfaces a NoReferenceComparison warning (non-blocking).
            capture_method: CaptureMethod::NoReferenceComparison,
        },
        status: Status::Draft,
        status_disclaimer: None,
        generated_at: GENERATED_AT.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use utsushi_core::port::impl_map::{validate, validate_against_manifest, validate_and_promote};

    #[test]
    fn impl_map_validates_and_promotes() {
        let mut map = build_kirikiri_xp3_impl_map();
        validate_and_promote(&mut map).expect("impl map validates");
        assert_eq!(map.status, Status::Validated);
        assert!(map.status_disclaimer.is_some(), "disclaimer stamped");
    }

    #[test]
    fn impl_map_binds_to_the_port_manifest() {
        // "Registered through the conformance manifest": the map's port-id
        // matches the manifest id and the engine-family prefix matches.
        let map = build_kirikiri_xp3_impl_map();
        validate(&map).expect("impl map is structurally valid");
        validate_against_manifest(&map, &crate::KirikiriXp3EnginePort::MANIFEST)
            .expect("impl map binds to the port manifest");
    }

    #[test]
    fn impl_map_declares_no_rust_opcode_runtime() {
        let map = build_kirikiri_xp3_impl_map();
        let runtime = map
            .subsystems
            .iter()
            .find(|subsystem| subsystem.id.as_str() == "kag-tjs-command-runtime")
            .expect("the KAG/TJS command-runtime subsystem is declared");
        assert!(
            matches!(runtime.status, SubsystemStatus::Unsupported { .. }),
            "the KAG/TJS command runtime must be Unsupported in Rust (the TJS runtime runs it)"
        );
    }
}
