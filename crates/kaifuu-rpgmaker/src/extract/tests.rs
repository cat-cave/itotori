use super::*;
use serde_json::json;

#[test]
fn dialogue_choice_scroll_and_unknown_code_are_handled() {
    // Synthetic event list (authored here, not retail bytes):
    // 101 setup (MZ speaker) | 401 line | 102 choices | 405 scroll |
    // 356 plugin | 122 script-operand | 70 unknown.
    let list = json!([
        {"code": 101, "indent": 0, "parameters": ["Face", 0, 0, 2, "Hero"]},
        {"code": 401, "indent": 0, "parameters": ["Hello \\v[1]!"]},
        {"code": 102, "indent": 0, "parameters": [["Yes", "No"], 1, 0, 2, 0]},
        {"code": 105, "indent": 0, "parameters": [2, false]},
        {"code": 405, "indent": 0, "parameters": ["Scrolling line"]},
        {"code": 356, "indent": 0, "parameters": ["SomePlugin arg"]},
        {"code": 122, "indent": 0, "parameters": [1, 1, 0, 4, "code()"]},
        {"code": 70, "indent": 0, "parameters": []}
    ]);
    let mut acc = ExtractAcc::default();
    walk_command_list(
        &mut acc,
        "Map001.json",
        vec!["list".to_string()],
        list.as_array().unwrap(),
    );

    // Units: speaker_name, dialogue, two choices, narration = 5.
    let kinds: Vec<&SurfaceKind> = acc.units.iter().map(|u| &u.surface_kind).collect();
    assert_eq!(acc.units.len(), 5, "got {kinds:?}");
    assert!(matches!(
        acc.units[0].surface_kind,
        SurfaceKind::SpeakerName
    ));
    assert!(matches!(
        acc.units[1].surface_kind,
        SurfaceKind::Dialogue { .. }
    ));
    assert_eq!(acc.units[1].speaker.as_deref(), Some("Hero"));
    // The dialogue line carries a \v[1] protected span.
    assert_eq!(acc.units[1].spans.len(), 1);
    assert_eq!(acc.units[1].spans[0].parsed_name, "rpgmaker.escape.V");
    assert!(matches!(
        acc.units[2].surface_kind,
        SurfaceKind::ChoiceLabel { option: 0, .. }
    ));
    assert!(matches!(
        acc.units[3].surface_kind,
        SurfaceKind::ChoiceLabel { option: 1, .. }
    ));
    assert!(matches!(acc.units[4].surface_kind, SurfaceKind::Narration));

    // Findings: plugin (356), control-variable script (122), unknown (70).
    assert_eq!(acc.findings.len(), 3);
    assert!(
        acc.findings
            .iter()
            .any(|f| f.kind == FindingKind::PluginCommandText)
    );
    assert!(
        acc.findings
            .iter()
            .any(|f| f.kind == FindingKind::ControlVariableScriptString)
    );
    let unknown = acc
        .findings
        .iter()
        .find(|f| f.kind == FindingKind::UnknownCommandCode)
        .expect("unknown-code finding");
    assert_eq!(unknown.command_code, Some(70));
}

#[test]
fn recognized_d_text_plugin_extracts_unit_and_typed_controls_leave_no_finding() {
    // Synthetic event list: a recognized D_TEXT (display text + size),
    // a D_TEXT_SETTING control command, and a screen-shake control
    // command. Only the D_TEXT becomes a translatable unit.
    let list = json!([
        {"code": 356, "indent": 0, "parameters": ["D_TEXT Hello 32"]},
        {"code": 356, "indent": 0, "parameters": ["D_TEXT_SETTING ALIGN CENTER"]},
        {"code": 356, "indent": 0, "parameters": ["P_SHAKE 1 2 3"]}
    ]);
    let mut acc = ExtractAcc::default();
    walk_command_list(
        &mut acc,
        "Map001.json",
        vec!["list".to_string()],
        list.as_array().unwrap(),
    );

    // One recognized plugin-text unit; two control commands enter the
    // exact opaque census rather than a generic finding.
    assert_eq!(acc.units.len(), 1, "only D_TEXT extracts a unit");
    let unit = &acc.units[0];
    assert!(matches!(
        unit.surface_kind,
        SurfaceKind::PluginText {
            plugin_command: "D_TEXT"
        }
    ));
    // The unit text is the FULL parameters[0] literal (patchback-safe);
    // it is keyed by the parameters/0 pointer.
    assert_eq!(unit.text, "D_TEXT Hello 32");
    assert_eq!(
        unit.source_unit_key(),
        "rpgmaker:Map001.json#/list/0/parameters/0"
    );
    // The keyword prefix and trailing size are protected control spans,
    // so only "Hello" is translatable. Every span's byte range must
    // reproduce its raw substring.
    let names: Vec<&str> = unit.spans.iter().map(|s| s.parsed_name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "rpgmaker.plugin.D_TEXT.command",
            "rpgmaker.plugin.D_TEXT.font_size",
        ]
    );
    for span in &unit.spans {
        assert_eq!(&unit.text[span.start_byte..span.end_byte], span.raw);
    }

    // Two control plugin commands are typed opaque, never dropped and
    // never mis-extracted as units.
    assert_eq!(acc.opaque_commands.len(), 2);
    assert!(acc.findings.is_empty());
    assert_eq!(acc.opaque_commands[0].command, "D_TEXT_SETTING");
    assert_eq!(acc.opaque_commands[1].command, "P_SHAKE");
}

#[test]
fn d_text_with_inline_escape_code_merges_spans_in_order() {
    // Display text carries an inline \v[1] code: the keyword prefix, the
    // escape code, and the trailing size must all be protected, sorted
    // ascending by start byte and non-overlapping.
    let list = json!([
        {"code": 356, "indent": 0, "parameters": ["D_TEXT \\v[1]pts 28"]}
    ]);
    let mut acc = ExtractAcc::default();
    walk_command_list(
        &mut acc,
        "Map001.json",
        vec!["list".to_string()],
        list.as_array().unwrap(),
    );
    assert_eq!(acc.units.len(), 1);
    let spans = &acc.units[0].spans;
    let names: Vec<&str> = spans.iter().map(|s| s.parsed_name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "rpgmaker.plugin.D_TEXT.command",
            "rpgmaker.escape.V",
            "rpgmaker.plugin.D_TEXT.font_size",
        ]
    );
    // Ascending + non-overlapping.
    for pair in spans.windows(2) {
        assert!(pair[0].end_byte <= pair[1].start_byte);
    }
    for span in spans {
        assert_eq!(&acc.units[0].text[span.start_byte..span.end_byte], span.raw);
    }
}

#[test]
fn database_name_and_description_surfaces_are_keyed_by_pointer() {
    let items = json!([
        null,
        {"id": 1, "name": "Potion", "description": "Heals \\c[2]HP\\c[0]."}
    ]);
    let mut acc = ExtractAcc::default();
    walk_database(&mut acc, "Items.json", &items);
    assert_eq!(acc.units.len(), 2);
    assert_eq!(
        acc.units[0].source_unit_key(),
        "rpgmaker:Items.json#/1/name"
    );
    assert_eq!(
        acc.units[1].source_unit_key(),
        "rpgmaker:Items.json#/1/description"
    );
    // Description protected spans: two \c[..] runs.
    assert_eq!(acc.units[1].spans.len(), 2);
}

#[test]
fn empty_strings_are_not_emitted_as_units() {
    let actors = json!([null, {"id": 1, "name": "Hero", "nickname": "", "profile": ""}]);
    let mut acc = ExtractAcc::default();
    walk_database(&mut acc, "Actors.json", &actors);
    assert_eq!(
        acc.units.len(),
        1,
        "empty nickname/profile must not emit units"
    );
    assert_eq!(
        acc.units[0].pointer,
        vec!["1".to_string(), "name".to_string()]
    );
}
