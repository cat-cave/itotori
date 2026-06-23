//! KAIFUU-174 bridge-inventory tests.
//!
//! Synthetic bytes derived from public RLDEV documentation. No retail
//! bytes; no `/archive/vault/` access.

use kaifuu_reallive::{
    AssetReferenceKind, ProtectedSpanKind, build_scene_inventory,
    decode_shift_jis_slot, detect_protected_spans, parse_archive, parse_gameexe_inventory,
    parse_scene,
};

mod synthetic {
    //! Synthetic scene-blob builders.

    /// `s` tag + u16 LE length + raw bytes.
    pub fn string_operand(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(3 + bytes.len());
        out.push(0x73);
        out.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(bytes);
        out
    }

    pub fn instruction(opcode: u8, operands: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(0x23);
        out.push(opcode);
        out.push(operands.len() as u8);
        for operand in operands {
            out.extend_from_slice(operand);
        }
        out
    }

    pub fn set_speaker(name_bytes: &[u8]) -> Vec<u8> {
        let operand = string_operand(name_bytes);
        instruction(0x02, &[operand.as_slice()])
    }

    pub fn text_display(text_bytes: &[u8]) -> Vec<u8> {
        let operand = string_operand(text_bytes);
        instruction(0x01, &[operand.as_slice()])
    }

    pub fn choice(choices: &[&[u8]]) -> Vec<u8> {
        let operands: Vec<Vec<u8>> = choices.iter().map(|c| string_operand(c)).collect();
        let refs: Vec<&[u8]> = operands.iter().map(|v| v.as_slice()).collect();
        instruction(0x03, &refs)
    }

    pub fn single_scene_archive(scene_bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(12 + scene_bytes.len());
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&12u32.to_le_bytes());
        out.extend_from_slice(&(scene_bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(scene_bytes);
        out
    }

    /// Bridge inventory fixture scene blob:
    /// - SetSpeaker("Aoi")
    /// - TextDisplay("Hello!")
    /// - Choice("Yes", "No")
    /// - Asset reference text slot for "bg/sample.g00"
    pub fn bridge_inventory_001_blob() -> Vec<u8> {
        let mut blob = Vec::new();
        blob.extend_from_slice(&set_speaker(b"Aoi"));
        blob.extend_from_slice(&text_display(b"Hello!"));
        blob.extend_from_slice(&choice(&[b"Yes", b"No"]));
        // Embed an asset reference as a TextDisplay operand so the
        // inventory walk picks it up via the heuristic.
        blob.extend_from_slice(&text_display(b"bg/sample.g00"));
        blob
    }

    /// Protected-spans fixture scene blob: one dialogue slot exercising
    /// every catalogue kind plus an unknown control byte.
    pub fn protected_spans_001_blob() -> Vec<u8> {
        // Construct a dialogue string with:
        // - 0x1f 0x03 color code
        // - 0x0d "base" 0x0a "ruby" 0x09 ruby
        // - 0x02 0x01 choice token (embedded in dialogue for test
        //   coverage; in real text this would be inside a Choice operand)
        // - 0x1e 0x05 text size directive
        // - 0x10 0x60 wait directive
        // - 0x0c clear text box
        // - 0x0a line break
        // - \{0\} name placeholder
        // - \\character variable placeholder
        // - 0x05 unknown control byte
        let mut dialogue = Vec::new();
        dialogue.extend_from_slice(&[0x1f, 0x03]); // color
        dialogue.extend_from_slice(b"H");
        dialogue.extend_from_slice(&[0x0d]);
        dialogue.extend_from_slice(b"base");
        dialogue.extend_from_slice(&[0x0a]);
        dialogue.extend_from_slice(b"ruby");
        dialogue.extend_from_slice(&[0x09]);
        dialogue.extend_from_slice(&[0x02, 0x01]); // choice token
        dialogue.extend_from_slice(&[0x1e, 0x05]); // size
        dialogue.extend_from_slice(&[0x10, 0x60]); // wait
        dialogue.extend_from_slice(&[0x0c]); // clear
        dialogue.extend_from_slice(&[0x0a]); // line break
        dialogue.extend_from_slice(b"\\{0\\}");
        dialogue.extend_from_slice(b"\\\\character");
        dialogue.extend_from_slice(&[0x05]); // unknown control
        dialogue.extend_from_slice(b"end");
        let mut blob = Vec::new();
        blob.extend_from_slice(&set_speaker(b"Speaker"));
        blob.extend_from_slice(&text_display(&dialogue));
        blob
    }
}

fn fixture_path(name: &str) -> std::path::PathBuf {
    let mut path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("tests");
    path.push("fixtures");
    path.push(name);
    path
}

fn assert_synthetic_matches_committed(name: &str, expected: &[u8]) {
    let on_disk = std::fs::read(fixture_path(name).join("SEEN.TXT")).unwrap_or_else(|err| {
        panic!("fixture {name} read failure: {err}")
    });
    assert_eq!(
        on_disk, expected,
        "committed fixture bytes for {name} drifted from the synthetic builder",
    );
}

fn parse_first(archive_bytes: &[u8]) -> (kaifuu_reallive::SceneIndex, kaifuu_reallive::Scene) {
    let index = parse_archive(archive_bytes).expect("archive parses");
    let entry = index.entries[0].clone();
    let blob = archive_bytes
        [entry.byte_offset as usize..(entry.byte_offset + entry.byte_len) as usize]
        .to_vec();
    let outcome = parse_scene(&blob, entry.archive_index, entry.byte_offset);
    let scene = outcome.scene.expect("scene parses");
    (index, scene)
}

// ----- bridge-inventory-001 -------------------------------------------------

#[test]
fn extracts_bridge_units_with_kaifuu_173_stable_slot_ids_as_source_unit_keys() {
    let scene_blob = synthetic::bridge_inventory_001_blob();
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);
    assert_synthetic_matches_committed("bridge-inventory-001", &archive_bytes);
    let (index, scene) = parse_first(&archive_bytes);
    let report = build_scene_inventory(&archive_bytes, &index, &[scene.clone()]);

    // Every bridge unit's source_unit_key must be one of the parsed
    // StringSlot ids.
    let slot_ids: std::collections::HashSet<&str> = scene
        .strings
        .iter()
        .map(|s| s.slot_id.as_str())
        .collect();
    for unit in &report.bridge_units {
        assert!(
            slot_ids.contains(unit.source_unit_key.as_str()),
            "bridge unit source_unit_key {} not in parsed slot ids {:?}",
            unit.source_unit_key,
            slot_ids
        );
    }
}

#[test]
fn source_unit_key_format_pinned_for_bridge_contract() {
    let scene_blob = synthetic::bridge_inventory_001_blob();
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);
    let (index, scene) = parse_first(&archive_bytes);
    let report = build_scene_inventory(&archive_bytes, &index, &[scene]);

    for unit in &report.bridge_units {
        let key = &unit.source_unit_key;
        assert!(
            key.starts_with("reallive:scene-"),
            "key {key} missing scene prefix"
        );
        assert!(key.contains(":str-off-"), "key {key} missing str-off segment");
        assert!(key.contains("-idx"), "key {key} missing slot index");
    }
}

#[test]
fn projects_dialogue_speaker_choice_string_slots_into_text_surface_strings() {
    let scene_blob = synthetic::bridge_inventory_001_blob();
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);
    let (index, scene) = parse_first(&archive_bytes);
    let report = build_scene_inventory(&archive_bytes, &index, &[scene]);

    let surfaces: std::collections::HashSet<&str> =
        report.bridge_units.iter().map(|u| u.text_surface.as_str()).collect();
    assert!(surfaces.contains("dialogue"));
    assert!(surfaces.contains("speaker_name"));
    assert!(surfaces.contains("choice_label"));
}

#[test]
fn decodes_shift_jis_text_into_bridge_unit_source_text_for_documented_fixture_bytes() {
    let scene_blob = synthetic::bridge_inventory_001_blob();
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);
    let (index, scene) = parse_first(&archive_bytes);
    let report = build_scene_inventory(&archive_bytes, &index, &[scene]);

    let texts: Vec<&str> = report.bridge_units.iter().map(|u| u.source_text.as_str()).collect();
    assert!(texts.contains(&"Aoi"));
    assert!(texts.contains(&"Hello!"));
    assert!(texts.contains(&"Yes"));
    assert!(texts.contains(&"No"));
}

#[test]
fn captures_g00_and_koe_asset_references_from_string_slots_and_gameexe_ini() {
    let scene_blob = synthetic::bridge_inventory_001_blob();
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);
    let (index, scene) = parse_first(&archive_bytes);
    let report = build_scene_inventory(&archive_bytes, &index, &[scene]);

    // Scene-level: bg/sample.g00 should be captured.
    let raw_paths: Vec<&str> = report
        .asset_references
        .assets
        .iter()
        .map(|a| a.raw_path.as_str())
        .collect();
    assert!(
        raw_paths.iter().any(|p| p.contains("sample.g00")),
        "expected sample.g00 in {raw_paths:?}"
    );
    assert!(report
        .asset_references
        .assets
        .iter()
        .any(|a| a.kind == AssetReferenceKind::Image));

    // Gameexe.ini level.
    let ini = b"#WINTITLE=Test\n#KOEPAC=koe.ovk\n";
    let gameexe = parse_gameexe_inventory(ini);
    let asset_refs: Vec<&str> = gameexe
        .entries
        .iter()
        .filter(|e| e.treatment == kaifuu_reallive::GameexeKeyTreatment::AssetReference)
        .map(|e| e.value.as_str())
        .collect();
    assert!(asset_refs.iter().any(|v| *v == "koe.ovk"));
}

#[test]
fn emits_kaifuu_reallive_inventory_unknown_gameexe_key_warning_for_non_catalogue_key() {
    let ini = b"#WEIRDKEY=42\n";
    let report = parse_gameexe_inventory(ini);
    assert!(report
        .warnings
        .iter()
        .any(|w| w.code == "kaifuu.reallive.inventory.unknown_gameexe_key"));
}

#[test]
fn emits_kaifuu_reallive_unsupported_text_shape_warning_for_unknown_role_string_slot() {
    // Build a scene with an Unrecognized opcode carrying a string operand
    // so the slot ends up with StringSlotRole::Unknown.
    let operand = synthetic::string_operand(b"mystery");
    let scene_blob = synthetic::instruction(0xFF, &[operand.as_slice()]);
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);
    let (index, scene) = parse_first(&archive_bytes);
    let report = build_scene_inventory(&archive_bytes, &index, &[scene]);

    assert!(
        report
            .warnings
            .iter()
            .any(|w| w.code == "kaifuu.reallive.unsupported_text_shape"),
        "warnings: {:?}",
        report.warnings
    );
}

#[test]
fn produces_byte_identical_bridge_json_across_runs_for_inventory_fixture() {
    let scene_blob = synthetic::bridge_inventory_001_blob();
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);
    let (index, scene) = parse_first(&archive_bytes);

    // Build the inventory three times. We compare everything except the
    // unstable UUIDv7 bridge_unit_id (the stability oracle is the
    // source_unit_key / occurrence_id pair).
    let mut snapshots = Vec::new();
    for _ in 0..3 {
        let report = build_scene_inventory(&archive_bytes, &index, &[scene.clone()]);
        let mut value = serde_json::to_value(&report).expect("serialize");
        if let Some(units) = value
            .get_mut("bridgeUnits")
            .and_then(|u| u.as_array_mut())
        {
            for unit in units {
                if let Some(obj) = unit.as_object_mut() {
                    obj.remove("bridgeUnitId");
                }
            }
        }
        snapshots.push(value.to_string());
    }
    let first = &snapshots[0];
    for (i, snap) in snapshots.iter().enumerate().skip(1) {
        assert_eq!(first, snap, "stability oracle iteration 0 vs {i}");
    }
}

// ----- protected-spans-001 --------------------------------------------------

#[test]
fn detects_color_ruby_name_choice_wait_clear_size_linebreak_control_spans_in_dialogue_slot() {
    let scene_blob = synthetic::protected_spans_001_blob();
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);
    assert_synthetic_matches_committed("protected-spans-001", &archive_bytes);
    let (index, scene) = parse_first(&archive_bytes);
    let report = build_scene_inventory(&archive_bytes, &index, &[scene.clone()]);

    // Locate the dialogue bridge unit.
    let dialogue_unit = report
        .bridge_units
        .iter()
        .find(|u| u.text_surface == "dialogue")
        .expect("dialogue unit present");

    // The dialogue slot must carry every catalogue kind plus the unknown
    // control.
    let dialogue_slot = scene
        .strings
        .iter()
        .find(|s| s.slot_id.as_str() == dialogue_unit.source_unit_key)
        .expect("dialogue slot");
    let raw = (0..dialogue_slot.raw_bytes_hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&dialogue_slot.raw_bytes_hex[i..i + 2], 16).unwrap())
        .collect::<Vec<u8>>();
    let decoded = decode_shift_jis_slot(&raw).text;
    let spans_report = detect_protected_spans(&raw, &decoded);

    let kinds: std::collections::HashSet<&str> = spans_report
        .spans
        .iter()
        .map(|s| s.kind.label())
        .collect();
    for expected in [
        "color_code",
        "ruby",
        "name_placeholder",
        "choice_token",
        "text_size_directive",
        "wait_directive",
        "clear_text_box",
        "line_break",
        "variable_placeholder",
        "unknown_control",
    ] {
        assert!(
            kinds.contains(expected),
            "missing protected-span kind {expected}; got: {kinds:?}"
        );
    }
}

#[test]
fn emits_kaifuu_reallive_protected_span_unknown_control_warning_for_unlisted_control_byte() {
    let scene_blob = synthetic::protected_spans_001_blob();
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);
    let (index, scene) = parse_first(&archive_bytes);
    let report = build_scene_inventory(&archive_bytes, &index, &[scene]);

    assert!(
        report
            .warnings
            .iter()
            .any(|w| w.code == "kaifuu.reallive.protected_span.unknown_control"),
        "warnings: {:?}",
        report.warnings
    );
}

#[test]
fn protected_span_byte_ranges_align_to_raw_bytes_for_control_codes() {
    // Color code at byte 0..2; the byte range must be (0, 2).
    let raw = &[0x1f, 0x03, b'X', b'Y'][..];
    let decoded = decode_shift_jis_slot(raw).text;
    let spans = detect_protected_spans(raw, &decoded);
    let color = spans
        .spans
        .iter()
        .find(|s| matches!(s.kind, ProtectedSpanKind::ColorCode { .. }))
        .expect("color span");
    assert_eq!(color.byte_range_start, 0);
    assert_eq!(color.byte_range_end, 2);
}
