//! Integration tests for the Siglus cross-engine substrate-conformance checklist.
//!
//! Pins: (1) the committed checklist names concrete facade methods + Siglus
//! event shapes; (2) lineage notes validate against the existing framework;
//! (3) malformed lineage notes fail.

use utsushi_siglus::substrate_conformance_checklist::{
    ChecklistEntry, ChecklistError, LineageConsumption, LineageNote, SiglusExpectedEventShape,
    allowed_framework_anchors, siglus_substrate_conformance_checklist, validate_checklist,
    validate_checklist_entry, validate_lineage_note,
};

#[test]
fn committed_checklist_validates() {
    validate_checklist(siglus_substrate_conformance_checklist())
        .expect("committed checklist must validate");
}

#[test]
fn checklist_names_concrete_facade_method_and_siglus_event_shape() {
    let entries = siglus_substrate_conformance_checklist();
    assert!(
        !entries.is_empty(),
        "checklist must contain at least one row"
    );
    let text_row = entries
        .iter()
        .find(|entry| entry.facade_method == "TextSurfaceSink::emit_line")
        .expect("checklist must name TextSurfaceSink::emit_line");
    assert_eq!(text_row.expected_event_shape.payload_type, "TextLine");
    assert!(
        text_row
            .expected_event_shape
            .fields
            .contains("evidence_tier=E1"),
        "Siglus TextLine shape must declare E1 fields"
    );
    assert!(
        text_row
            .expected_event_shape
            .siglus_source
            .contains("SiglusTraceOp::EmitText"),
        "Siglus source must name the EmitText op path"
    );
    assert_eq!(
        text_row.lineage.substrate_carrier, "TextSurfaceSink",
        "lineage must cite the TextSurfaceSink carrier"
    );

    let asset_open_row = entries
        .iter()
        .find(|entry| entry.facade_method == "AssetPackage::open")
        .expect("checklist must name AssetPackage::open");
    assert_eq!(
        asset_open_row.expected_event_shape.payload_type,
        "AssetBytes"
    );
    assert!(
        asset_open_row
            .expected_event_shape
            .fields
            .contains("VfsResult<AssetBytes>"),
        "AssetPackage::open must declare its VfsResult<AssetBytes> return shape"
    );
}

#[test]
fn lineage_notes_cite_existing_framework_anchors() {
    let allowed = allowed_framework_anchors();
    for entry in siglus_substrate_conformance_checklist() {
        validate_lineage_note(&entry.lineage)
            .unwrap_or_else(|err| panic!("lineage for {} failed: {err}", entry.facade_method));
        let path = entry
            .lineage
            .framework_anchor
            .split('#')
            .next()
            .expect("anchor path");
        assert!(
            allowed.contains(&path),
            "anchor {path} must be in the framework set"
        );
    }
}

#[test]
fn malformed_lineage_note_empty_carrier_fails() {
    let note = LineageNote {
        framework_anchor: "docs/research/reallive-engine.md",
        substrate_carrier: "",
        consumption: LineageConsumption::Scaffold,
        code_reuse_point: "something reusable somehow",
    };
    assert!(matches!(
        validate_lineage_note(&note),
        Err(ChecklistError::UnknownSubstrateCarrier(_))
    ));
}

#[test]
fn malformed_lineage_note_marketing_only_fails() {
    let note = LineageNote {
        framework_anchor: "docs/research/reallive-engine.md",
        substrate_carrier: "TextSurfaceSink",
        consumption: LineageConsumption::Scaffold,
        // Deliberately does NOT cite TextSurfaceSink — marketing-only.
        code_reuse_point: "Visual Arts engines share a proud heritage of quality.",
    };
    let err = validate_lineage_note(&note).expect_err("marketing-only must fail");
    assert!(matches!(
        err,
        ChecklistError::MarketingOnlyReuseClaim { .. }
    ));
}

#[test]
fn malformed_lineage_note_unknown_anchor_fails() {
    let note = LineageNote {
        framework_anchor: "docs/marketing/siglus-is-cool.md",
        substrate_carrier: "TextSurfaceSink",
        consumption: LineageConsumption::Scaffold,
        code_reuse_point: "TextSurfaceSink is shared",
    };
    assert!(matches!(
        validate_lineage_note(&note),
        Err(ChecklistError::InvalidFrameworkAnchor(_))
    ));
}

#[test]
fn malformed_lineage_note_engine_local_fails() {
    let note = LineageNote {
        framework_anchor: "docs/research/reallive-engine.md",
        substrate_carrier: "TextSurfaceSink",
        consumption: LineageConsumption::EngineLocal,
        code_reuse_point: "TextSurfaceSink",
    };
    assert!(matches!(
        validate_lineage_note(&note),
        Err(ChecklistError::EngineLocalNotAllowed)
    ));
}

#[test]
fn unknown_facade_method_fails() {
    let entry = ChecklistEntry {
        // Acceptance-criteria sketch name — not a real facade method.
        facade_method: "TextSurfaceSink::on_text_line",
        expected_event_shape: SiglusExpectedEventShape {
            payload_type: "TextLine",
            fields: "text",
            evidence_tier: "E1",
            siglus_source: "vm",
        },
        lineage: LineageNote {
            framework_anchor: "docs/research/reallive-engine.md",
            substrate_carrier: "TextSurfaceSink",
            consumption: LineageConsumption::SiglusWired,
            code_reuse_point: "TextSurfaceSink carries text",
        },
    };
    assert!(matches!(
        validate_checklist_entry(&entry),
        Err(ChecklistError::UnknownFacadeMethod(_))
    ));
}

#[test]
fn lineage_doc_cross_references_framework_and_checklist() {
    let doc_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/research/siglus-substrate-lineage-notes.md");
    let body = std::fs::read_to_string(&doc_path)
        .unwrap_or_else(|err| panic!("lineage notes doc missing at {}: {err}", doc_path.display()));
    assert!(
        body.contains("docs/research/reallive-engine.md"),
        "doc must cross-reference Appendix M / reallive-engine.md"
    );
    assert!(
        body.contains("TextSurfaceSink::emit_line"),
        "doc must name the concrete facade method TextSurfaceSink::emit_line"
    );
    assert!(
        body.contains("TextLine"),
        "doc must name the Siglus-side TextLine event shape"
    );
    assert!(
        body.contains("cross_engine_substrate_alignment"),
        "doc must point at the cross-engine alignment fixture"
    );
    for entry in siglus_substrate_conformance_checklist() {
        assert!(
            body.contains(entry.facade_method),
            "doc must name facade method {}",
            entry.facade_method
        );
    }
}
