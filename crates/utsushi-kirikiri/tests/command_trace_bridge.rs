//! Acceptance — the KAG command trace links speaker / message
//! branch rows back to the REAL extraction bridge units.
//!
//! `kaifuu-kirikiri` is a dev-dependency ORACLE here (never a production
//! coupling — see this crate's `Cargo.toml`). This test proves the trace's
//! re-derived `bridgeRef` (`bridgeUnitId` + `sourceUnitKey`) is byte-identical
//! to the authoritative extraction identity `kaifuu_kirikiri::parse_ks` stamps
//! on the SAME source text — so the linkage is provably the real bridge, not a
//! parallel one. Fixture is synthetic, authored, CC0
//! (`fixtures/public/kag-plaintext/main.ks`).

use std::collections::HashMap;
use std::path::PathBuf;

use kaifuu_kirikiri::{KsUnit, TextRole, parse_ks};
use utsushi_kirikiri::{RowKind, trace_kag_commands};

const SOURCE_FILE: &str = "main.ks";

fn fixture_bytes() -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/public/kag-plaintext")
        .join(SOURCE_FILE);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Every extraction unit keyed by its stable `source_unit_key`.
fn extraction_units() -> HashMap<String, KsUnit> {
    let doc = parse_ks(SOURCE_FILE, &fixture_bytes());
    doc.units
        .into_iter()
        .map(|u| (u.source_unit_key.clone(), u))
        .collect()
}

#[test]
fn speaker_message_branch_rows_link_to_real_extraction_bridge_units() {
    let units = extraction_units();
    let trace = trace_kag_commands(SOURCE_FILE, &fixture_bytes());

    let mut checked = 0usize;
    for row in &trace.rows {
        let Some(bridge_ref) = &row.bridge_ref else {
            // Only speaker / message / branch rows carry a bridge ref.
            assert!(
                !matches!(row.kind, RowKind::Message),
                "message rows must always carry a bridge ref",
            );
            continue;
        };
        let unit = units.get(&bridge_ref.source_unit_key).unwrap_or_else(|| {
            panic!(
                "trace row {} references sourceUnitKey {} that KAIFUU-009 did not extract",
                row.command_index, bridge_ref.source_unit_key,
            )
        });
        // The re-derived UUID7-shaped id is byte-identical to the extraction's.
        assert_eq!(
            bridge_ref.bridge_unit_id, unit.bridge_unit_id,
            "bridgeUnitId mismatch for {}",
            bridge_ref.source_unit_key,
        );
        // And it points at the SAME source text / role.
        match row.kind {
            RowKind::Speaker => {
                assert_eq!(unit.role, TextRole::SpeakerName);
                assert_eq!(row.speaker.as_deref(), Some(unit.source_text.as_str()));
            }
            RowKind::Message | RowKind::Branch => {
                assert_eq!(unit.role, TextRole::Dialogue);
                assert_eq!(row.text.as_deref(), Some(unit.source_text.as_str()));
            }
            other => panic!("unexpected bridge-ref-bearing row kind {other:?}"),
        }
        checked += 1;
    }

    // The fixture exercises speakers, messages, and branch options — all
    // linked. (5 speakers + 5 messages + 2 branch options = 12.)
    assert_eq!(checked, 12, "expected every text-bearing row linked");
}

#[test]
fn every_extracted_dialogue_and_speaker_unit_is_reachable_in_the_trace() {
    // The reverse direction: no extraction unit is silently dropped by the
    // probe. Every `dialogue`/`speaker_name` unit finds (EXCEPT the
    // macro-body template line, which is not executed until invoked) is present
    // as a trace bridge ref.
    let units = extraction_units();
    let trace = trace_kag_commands(SOURCE_FILE, &fixture_bytes());
    let referenced: std::collections::HashSet<&str> = trace
        .rows
        .iter()
        .filter_map(|r| r.bridge_ref.as_ref().map(|b| b.source_unit_key.as_str()))
        .collect();

    for (key, unit) in &units {
        // The `[macro name=aside]The house…[endmacro]` body is a template, not
        // an executed line — the probe records the macro id, not the body text.
        if unit.source_text.contains("The house is warm and quiet") {
            assert!(
                !referenced.contains(key.as_str()),
                "macro-body template must not be a trace message",
            );
            continue;
        }
        assert!(
            referenced.contains(key.as_str()),
            "extraction unit {key} ({:?}) is not reachable in the trace",
            unit.role,
        );
    }
}
