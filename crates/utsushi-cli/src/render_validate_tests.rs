use super::*;

#[test]
fn rejects_unsupported_engine() {
    let args: Vec<String> = vec![
        "--engine".into(),
        "siglus".into(),
        "--seen".into(),
        "/tmp/nothing".into(),
        "--scene".into(),
        "1".into(),
        "--artifact-root".into(),
        "/tmp/art".into(),
    ];
    let err = run_render_validate_command(&args).expect_err("siglus is not supported");
    assert!(err.to_string().contains("unsupported_engine"));
}

#[test]
fn rejects_missing_artifact_root() {
    let args: Vec<String> = vec![
        "--engine".into(),
        "reallive".into(),
        "--seen".into(),
        "/tmp/nothing".into(),
        "--scene".into(),
        "1".into(),
    ];
    let err = run_render_validate_command(&args).expect_err("missing --artifact-root");
    assert!(err.to_string().contains("--artifact-root"));
}

#[test]
fn rejects_unparseable_scene_id() {
    let args: Vec<String> = vec![
        "--engine".into(),
        "reallive".into(),
        "--seen".into(),
        "/tmp/nothing".into(),
        "--scene".into(),
        "notanint".into(),
        "--artifact-root".into(),
        "/tmp/art".into(),
    ];
    let err = run_render_validate_command(&args).expect_err("scene parse must fail");
    assert!(err.to_string().contains("scene_parse"));
}

#[test]
fn rejects_zero_dimension() {
    let args: Vec<String> = vec![
        "--engine".into(),
        "reallive".into(),
        "--seen".into(),
        "/tmp/nothing".into(),
        "--scene".into(),
        "1".into(),
        "--artifact-root".into(),
        "/tmp/art".into(),
        "--width".into(),
        "0".into(),
    ];
    let err = run_render_validate_command(&args).expect_err("zero width rejected");
    assert!(err.to_string().contains("dimension_zero"));
}

#[test]
fn help_documents_render_validate_surface() {
    assert!(HELP.contains("utsushi-cli render-validate"));
    assert!(HELP.contains("--engine reallive"));
    assert!(HELP.contains("EvidenceTier::E2"));
    // The redaction toggle + private/public split is documented.
    assert!(HELP.contains("--redaction on|off"));
    assert!(HELP.contains("--private-artifact-root"));
    assert!(HELP.contains("--message-index"));
    assert!(HELP.contains("redacted by default"));
    // The opcode-coverage gate surface is documented.
    assert!(HELP.contains("--require-semantic-reached-path"));
    assert!(HELP.contains("--dispatch-report"));
    assert!(HELP.contains("missingKeys"));
}

#[test]
fn help_request_does_not_require_flags() {
    let args: Vec<String> = vec!["--help".into()];
    run_render_validate_command(&args).expect("--help should not require flags");
}

#[test]
fn requires_gameexe_flag() {
    let args: Vec<String> = vec![
        "--engine".into(),
        "reallive".into(),
        "--seen".into(),
        "/tmp/nothing".into(),
        "--scene".into(),
        "1".into(),
        "--artifact-root".into(),
        "/tmp/art".into(),
        "--game-dir".into(),
        "/tmp/game".into(),
    ];
    let err = run_render_validate_command(&args).expect_err("--gameexe is required");
    assert!(
        err.to_string().contains("--gameexe"),
        "expected the missing --gameexe flag error, got: {err}"
    );
}

#[test]
fn requires_game_dir_flag() {
    let args: Vec<String> = vec![
        "--engine".into(),
        "reallive".into(),
        "--seen".into(),
        "/tmp/nothing".into(),
        "--scene".into(),
        "1".into(),
        "--artifact-root".into(),
        "/tmp/art".into(),
        "--gameexe".into(),
        "/tmp/Gameexe.ini".into(),
    ];
    let err = run_render_validate_command(&args).expect_err("--game-dir is required");
    assert!(
        err.to_string().contains("--game-dir"),
        "expected the missing --game-dir flag error, got: {err}"
    );
}

#[test]
fn missing_gameexe_file_surfaces_read_error() {
    let missing = std::env::temp_dir().join(format!(
        "utsushi-cli-render-validate-missing-{}",
        std::process::id()
    ));
    let args: Vec<String> = vec![
        "--engine".into(),
        "reallive".into(),
        "--seen".into(),
        missing.join("Seen.txt").display().to_string(),
        "--scene".into(),
        "1".into(),
        "--gameexe".into(),
        missing.join("Gameexe.ini").display().to_string(),
        "--game-dir".into(),
        missing.display().to_string(),
        "--artifact-root".into(),
        missing.join("artifacts").display().to_string(),
    ];
    let err = run_render_validate_command(&args)
        .expect_err("missing Gameexe.ini should fail before the replay driver");
    assert!(
        err.to_string()
            .contains("utsushi.cli.render_validate.gameexe_read"),
        "expected the gameexe read error, got: {err}"
    );
}

#[test]
fn positional_message_index_checks_expected_text_on_that_line() {
    let play_order = vec![
        text_line("line-0", "Same localized line."),
        text_line("line-1", "Broken second line."),
    ];
    let err = select_play_order_message(&play_order, 6010, Some("Same localized line."), Some(1))
        .expect_err("index 1 must not be accepted just because index 0 matches");
    assert!(
        err.to_string().contains("expect_text_missing_at_index"),
        "expected indexed missing-text diagnostic, got: {err}"
    );
}

#[test]
fn positional_message_index_selects_duplicate_occurrence() {
    let play_order = vec![
        text_line("line-0", "Same localized line."),
        text_line("line-1", "Same localized line."),
    ];
    let (index, chosen) =
        select_play_order_message(&play_order, 6010, Some("Same localized line."), Some(1))
            .expect("second duplicate occurrence is selected by index");
    assert_eq!(index, 1);
    assert_eq!(chosen.line_id, "line-1");
}

#[test]
fn substring_selection_without_index_rejects_duplicate_matches() {
    let play_order = vec![
        text_line("line-0", "Same localized line."),
        text_line("line-1", "Same localized line."),
    ];
    let err = select_play_order_message(&play_order, 6010, Some("Same localized"), None)
        .expect_err("duplicate substring matches require a message index");
    assert!(
        err.to_string().contains("expect_text_ambiguous"),
        "expected ambiguous substring diagnostic, got: {err}"
    );
}

fn text_line(line_id: &str, text: &str) -> TextLine {
    TextLine {
        line_id: line_id.to_string(),
        evidence_tier: EvidenceTier::E1,
        text: text.to_string(),
        speaker: None,
        color: None,
        text_surface: None,
        bridge_ref: None,
        source_asset: None,
        byte_offset_in_scene: None,
        body_shift_jis: None,
    }
}

// --- Opcode-coverage gate (the green-against-mock gap closure) ---
//
// `render-validate`'s `drive` computes coverage over the SAME
// branch-following pass through `dispatch_report_from_engine`, and the
// command applies `require_semantic_reached_path` as its
// `--require-semantic-reached-path` gate. These tests exercise that exact
// seam on synthetic in-memory scenes (no on-disk archive / Gameexe / g00
// needed): a scene referencing an unimplemented opcode still reaches a
// natural terminus and emits text, but the gate must FAIL loud with the
// machine-readable `missingKeys[]`; a fully-covered scene must PASS.

use std::collections::HashSet;
use utsushi_reallive::{
    BytecodeElement, InMemorySceneStore, MSG_MODULE_ID, MSG_MODULE_TYPE, OPCODE_LINE_BREAK,
    ReplayEngine, ReplayOpts, Scene,
};

use crate::dispatch_gate::{dispatch_report_from_engine, require_semantic_reached_path};

/// A single 8-byte RealLive `Command` element for `(module_type
/// module_id, opcode)` at `byte_offset`. Mirrors the reallive replay
/// helper: branch-following dispatches on the decoded header fields.
fn command_element(
    module_type: u8,
    module_id: u8,
    opcode: u16,
    byte_offset: usize,
) -> BytecodeElement {
    let mut raw_bytes = vec![0, module_type, module_id];
    raw_bytes.extend_from_slice(&opcode.to_le_bytes());
    raw_bytes.extend_from_slice(&[0, 0, 0]);
    BytecodeElement::Command {
        module_type,
        module_id,
        opcode,
        arg_count: 0,
        overload: 0,
        goto_targets: Vec::new(),
        goto_case_exprs: Vec::new(),
        raw_bytes,
        byte_offset,
        byte_len: 8,
    }
}

fn engine_with_single_command(module_type: u8, module_id: u8, opcode: u16) -> ReplayEngine {
    let scene = Scene::new(1, vec![command_element(module_type, module_id, opcode, 0)])
        .expect("synthetic single-command scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    ReplayEngine::from_store(store, HashSet::new())
}

#[test]
fn coverage_gate_fails_on_scene_with_missing_opcode() {
    // (2, 250, 9) is not an implemented RealLive opcode — it surfaces as a
    // `MissingRlop` and folds into `unknown_opcode_keys`.
    let engine = engine_with_single_command(2, 250, 9);
    let coverage = dispatch_report_from_engine(&engine, 1, &ReplayOpts::default());

    assert_eq!(
        coverage.missing_keys,
        vec![(2, 250, 9)],
        "the unimplemented opcode must be reported as a missing key",
    );
    // The rendered frame would still emit (natural terminus), so a naive
    // check would pass — the gate must catch the gap.
    let error = require_semantic_reached_path(&coverage)
        .expect_err("a scene with a missing opcode must fail the coverage gate");
    let message = error.to_string();
    assert!(
        message.contains("missing_keys=[(2, 250, 9)]"),
        "the gate failure must carry the machine-readable missing key: {message}",
    );
    assert!(
        message.contains("missing_count=1"),
        "the gate failure must report the missing-opcode count: {message}",
    );
}

#[test]
fn coverage_gate_passes_on_fully_covered_scene() {
    // A single recognised message line-break: dispatches semantically, no
    // missing opcode and a natural terminus.
    let engine = engine_with_single_command(MSG_MODULE_TYPE, MSG_MODULE_ID, OPCODE_LINE_BREAK);
    let coverage = dispatch_report_from_engine(&engine, 1, &ReplayOpts::default());

    assert!(
        coverage.missing_keys.is_empty(),
        "a fully-covered scene has no missing opcodes: {:?}",
        coverage.missing_keys,
    );
    require_semantic_reached_path(&coverage)
        .expect("a fully-covered scene must pass the coverage gate cleanly");

    // Coverage is folded into the JSON evidence report (honest by default).
    let json = coverage.to_json();
    assert_eq!(json["missingCount"], 0);
    assert_eq!(json["missingKeys"].as_array().unwrap().len(), 0);
}
