//! UTSUSHI-034 — Siglus VM **implementation map**.
//!
//! Names the concrete Siglus VM subsystems as follow-ups **without claiming
//! broad compatibility**. Built on the engine-neutral
//! [`utsushi_core::port::impl_map`] schema, whose `Research` / `Partial`
//! statuses are the honest-scope mechanism: they carry no support claim, and the
//! validator stamps the [`STATUS_VALIDATED_DISCLAIMER`] so a `Validated` map is
//! never mistaken for alpha-readiness.
//!
//! The single subsystem this smoke actually exercises
//! (`synthetic-text-trace-vm-smoke`) is recorded as **`Partial`** with explicit
//! limitations (synthetic opcode set, no real bytecode). Every real Siglus VM
//! subsystem is recorded as **`Research`** with cited evidence refs — never as
//! `Supported`.
//!
//! See `docs/utsushi-siglus-vm-provenance.md` §4 for the prose mirror.

use utsushi_core::port::impl_map::sha256_hex;
use utsushi_core::port::impl_map::{
    CaptureMethod, EngineFamily, EvidenceKind, EvidenceRef, ExpectedOutcome, FixtureClassification,
    FixtureKind, FixtureRef, IMPL_MAP_SCHEMA_VERSION, ImplementationMap, PortId, ReferenceBehavior,
    Status, Subsystem, SubsystemId, SubsystemStatus, ValidationCommand, ValidationCommandId,
};

/// Port id shared with the engine-port scaffold's manifest.
const VM_IMPL_MAP_PORT_ID: &str = "utsushi-siglus";

/// Deterministic RFC3339 generation instant (the schema requires RFC3339; the
/// substrate never calls `SystemTime::now()`).
const VM_IMPL_MAP_GENERATED_AT: &str = "2026-07-04T00:00:00Z";

/// Validation command id: the smoke test that exercises the covered subsystem.
const CMD_SMOKE: &str = "vm-trace-smoke";
/// Validation command id: the deferred (not-yet-runnable) follow-up recipe.
const CMD_DEFERRED: &str = "siglus-vm-subsystem-deferred";

/// A synthetic-inline fixture placeholder for a subsystem. Honest: no retail
/// fixture exists yet; the "fixture" is an inline descriptor whose hash commits
/// to the subsystem's canonical id so the map is reproducible.
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

/// A Research subsystem: a real Siglus VM subsystem named as a follow-up, cited
/// against the provenance doc and the studied reference anchor, and carrying NO
/// support claim.
fn research_subsystem(id: &str, name: &str, capabilities: &[&str], notes: &str) -> Subsystem {
    Subsystem {
        id: SubsystemId::new(id),
        name: name.to_string(),
        status: SubsystemStatus::Research {
            evidence_refs: vec![
                EvidenceRef {
                    kind: EvidenceKind::Doc,
                    locator: "docs/utsushi-siglus-vm-provenance.md".to_string(),
                    caption:
                        "Clean-room provenance + follow-up scope for this Siglus VM subsystem."
                            .to_string(),
                },
                EvidenceRef {
                    kind: EvidenceKind::ReferenceImplAnchor,
                    locator: "https://github.com/xmoezzz/siglus_rs".to_string(),
                    caption:
                        "siglus_rs (MPL-2.0) studied as a research anchor only; not vendored, \
                              linked, or translated."
                            .to_string(),
                },
            ],
        },
        fixture_ref: synthetic_inline_fixture(&format!("{id}-descriptor"), id),
        validation_command_id: ValidationCommandId::new(CMD_DEFERRED),
        capabilities: capabilities.iter().map(|tag| (*tag).to_string()).collect(),
        notes: notes.to_string(),
    }
}

/// Build the Siglus VM implementation map in `Draft` status. Callers run
/// [`utsushi_core::port::impl_map::validate_and_promote`] to validate + promote
/// to `Validated` (which stamps the audit disclaimer).
pub fn build_siglus_vm_impl_map() -> ImplementationMap {
    let smoke_fixture = synthetic_inline_fixture(
        "siglus-vm-trace-smoke-program",
        "utsushi-siglus-vm synthetic text-trace program v0.1.0",
    );

    ImplementationMap {
        schema_version: IMPL_MAP_SCHEMA_VERSION.to_string(),
        port_id: PortId::new(VM_IMPL_MAP_PORT_ID),
        engine_family: EngineFamily::Siglus,
        engine_family_notes: None,
        subsystems: vec![
            // The ONE subsystem this smoke actually exercises — Partial, never
            // Supported, with the synthetic-scope limitations spelled out.
            Subsystem {
                id: SubsystemId::new("synthetic-text-trace-vm-smoke"),
                name: "Synthetic Siglus text-trace VM smoke".to_string(),
                status: SubsystemStatus::Partial {
                    limitations: vec![
                        "Runs a SYNTHETIC authored opcode set (EmitText/SetFlag/SetInt/Halt), NOT \
                         the real Siglus opcode table."
                            .to_string(),
                        "Consumes a synthetic authored local key (XOR descramble), NOT a real \
                         Siglus container key; no retail bytes or keys."
                            .to_string(),
                        "Emits E1 text + VM-state evidence only; no rendered frame, no real \
                         Scene.pck decode."
                            .to_string(),
                    ],
                },
                fixture_ref: smoke_fixture,
                validation_command_id: ValidationCommandId::new(CMD_SMOKE),
                capabilities: vec![
                    "text-trace".to_string(),
                    "vm-state-snapshot".to_string(),
                    "secret-ref-key".to_string(),
                ],
                notes: "The only executed subsystem. Proves the runtime-evidence contract path \
                        end-to-end on synthetic bytes at E1."
                    .to_string(),
            },
            research_subsystem(
                "scene-pck-bytecode-decode",
                "Scene.pck scene bytecode decode",
                &["container-decode", "bytecode"],
                "Decode real Scene.pck scene bytecode into a typed op stream. Anchored on \
                 siglus-decompile + the Kaifuu Siglus format work.",
            ),
            research_subsystem(
                "siglus-opcode-dispatch",
                "Siglus opcode table + interpreter dispatch",
                &["opcode-dispatch", "interpreter"],
                "The real Siglus opcode table and stack/register interpreter. The synthetic \
                 SiglusTraceOp set is explicitly a stand-in, not this.",
            ),
            research_subsystem(
                "siglus-string-table-utf16",
                "UTF-16LE string-table resolution",
                &["string-table", "text-emission"],
                "Resolve UTF-16LE scene strings + engine text substitution into TextLines.",
            ),
            research_subsystem(
                "gameexe-namespace-resolution",
                "Gameexe.dat namespace resolution",
                &["config-resolution"],
                "Resolve Gameexe.dat namespaced config into runtime state.",
            ),
            research_subsystem(
                "siglus-lzss-decompression",
                "Proprietary Siglus LZSS decompression",
                &["decompression"],
                "The proprietary Siglus LZSS container codec the UTSUSHI-035 runtime-profile \
                 boundary currently rejects as out-of-profile.",
            ),
            research_subsystem(
                "siglus-flag-and-variable-banks",
                "Flag + variable bank model",
                &["state-banks", "snapshot"],
                "The real flag/variable bank model + snapshot/restore mapping. The smoke models a \
                 synthetic subset only.",
            ),
            research_subsystem(
                "siglus-selbtn-choices",
                "Siglus choice/selection dispatch",
                &["choices", "branch-discovery"],
                "Siglus SelBtn-style choice/selection dispatch feeding the choice-translation \
                 surface.",
            ),
        ],
        validation_commands: vec![
            ValidationCommand {
                id: ValidationCommandId::new(CMD_SMOKE),
                command: "cargo test -p utsushi-siglus --test vm_smoke".to_string(),
                expected_outcome: ExpectedOutcome::Pass,
                caption: "Runs the synthetic Siglus VM text-trace smoke: text + VM-state evidence \
                          through the Utsushi runtime-evidence contracts, secret-ref-only key \
                          handling."
                    .to_string(),
            },
            ValidationCommand {
                id: ValidationCommandId::new(CMD_DEFERRED),
                command: "just siglus-vm-follow-up".to_string(),
                expected_outcome: ExpectedOutcome::Skip {
                    reason: "utsushi.siglus_vm.subsystem_deferred".to_string(),
                },
                caption: "Placeholder for the deferred real-VM subsystems: not yet runnable; each \
                          Research subsystem is documented but unvalidated."
                    .to_string(),
            },
        ],
        reference_behavior: ReferenceBehavior {
            engine_runtime: "siglus (synthetic self-check; no external Siglus oracle wired yet)"
                .to_string(),
            observable_signal: "The E1 VmTraceEvidence text_lines + vm_state snapshot are \
                                deterministic for the committed synthetic fixtures; any divergence \
                                in emitted text or VM state falsifies the smoke."
                .to_string(),
            capture_method: CaptureMethod::SyntheticSelfCheck,
        },
        status: Status::Draft,
        status_disclaimer: None,
        generated_at: VM_IMPL_MAP_GENERATED_AT.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use utsushi_core::port::impl_map::{validate, validate_and_promote};

    #[test]
    fn impl_map_validates_and_promotes() {
        let mut map = build_siglus_vm_impl_map();
        let report = validate_and_promote(&mut map).expect("impl map validates");
        assert_eq!(map.status, Status::Validated);
        assert!(map.status_disclaimer.is_some(), "disclaimer stamped");
        // The map carries Research subsystems -> the validator warns about them,
        // confirming the honest-scope mechanism is engaged (not suppressed).
        assert!(
            report.warnings.iter().any(|warning| matches!(
                warning,
                utsushi_core::port::impl_map::ValidationWarning::ResearchSubsystemPresent { .. }
            )),
            "Research subsystems must surface a warning: {:?}",
            report.warnings
        );
    }

    #[test]
    fn impl_map_makes_no_broad_compatibility_claim() {
        let map = build_siglus_vm_impl_map();
        // No subsystem is `Supported`: the only executed one is `Partial`, the
        // rest are `Research`. This is the no-overclaim assertion.
        for subsystem in &map.subsystems {
            assert!(
                !matches!(subsystem.status, SubsystemStatus::Supported),
                "subsystem {} must not claim Supported in the first smoke",
                subsystem.id.as_str()
            );
        }
        // A fresh (unpromoted) build re-validates too.
        assert!(validate(&build_siglus_vm_impl_map()).is_ok());
    }
}
