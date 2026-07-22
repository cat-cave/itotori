use super::*;

/// `D_TEXT <text> <size>`: the keyword prefix and trailing size are
/// protected; the middle token is the translatable region.
#[test]
fn d_text_with_trailing_size_protects_keyword_and_size() {
    // Synthetic (non-retail) command string.
    let param0 = "D_TEXT Hello 32";
    let rec = recognize_plugin_command(param0).expect("D_TEXT is recognized");
    assert_eq!(rec.command, "D_TEXT");
    assert_eq!(rec.control_spans.len(), 2);

    let prefix = &rec.control_spans[0];
    assert_eq!(prefix.raw, "D_TEXT ");
    assert_eq!(&param0[prefix.start_byte..prefix.end_byte], "D_TEXT ");

    let suffix = &rec.control_spans[1];
    assert_eq!(suffix.raw, " 32");
    assert_eq!(&param0[suffix.start_byte..suffix.end_byte], " 32");
    assert_eq!(suffix.argument.as_deref(), Some("32"));

    // The unprotected (translatable) region is exactly the display text.
    assert_eq!(&param0[prefix.end_byte..suffix.start_byte], "Hello");
}

/// Multi-word display text with a trailing size: the whole middle run
/// stays translatable, only the trailing size is stripped.
#[test]
fn d_text_multiword_text_keeps_internal_spaces() {
    let param0 = "D_TEXT one two three 28";
    let rec = recognize_plugin_command(param0).unwrap();
    assert_eq!(rec.control_spans.len(), 2);
    let (prefix, suffix) = (&rec.control_spans[0], &rec.control_spans[1]);
    assert_eq!(&param0[prefix.end_byte..suffix.start_byte], "one two three");
    assert_eq!(suffix.raw, " 28");
}

/// No trailing numeric token: the whole remainder is display text and
/// only the keyword prefix is protected.
#[test]
fn d_text_without_trailing_size_protects_only_keyword() {
    let param0 = "D_TEXT plain words";
    let rec = recognize_plugin_command(param0).unwrap();
    assert_eq!(rec.control_spans.len(), 1);
    assert_eq!(rec.control_spans[0].raw, "D_TEXT ");
    assert_eq!(
        &param0[rec.control_spans[0].end_byte..],
        "plain words",
        "the full remainder is translatable when no size trails"
    );
}

/// A single non-numeric argument is display text (no size to strip).
#[test]
fn d_text_single_arg_is_display_text() {
    let rec = recognize_plugin_command("D_TEXT word").unwrap();
    assert_eq!(rec.control_spans.len(), 1);
    assert_eq!(rec.control_spans[0].raw, "D_TEXT ");
}

/// A single numeric argument: DTextPicture treats it as display text
/// (a lone arg is never stripped), so it is still recognized.
#[test]
fn d_text_single_numeric_arg_is_display_text() {
    let rec = recognize_plugin_command("D_TEXT 100").unwrap();
    // No trailing size stripped (arg_count == 1).
    assert_eq!(rec.control_spans.len(), 1);
    assert_eq!(rec.control_spans[0].raw, "D_TEXT ");
}

/// `D_TEXT` with no argument has nothing to display: not recognized.
#[test]
fn bare_d_text_keyword_is_not_recognized() {
    assert!(recognize_plugin_command("D_TEXT").is_none());
}

/// Control plugin commands present in the corpus are NOT recognized and
/// stay findings (no engine control mis-extracted as dialogue).
#[test]
fn control_commands_are_not_recognized() {
    for control in [
        "D_TEXT_SETTING ALIGN CENTER",
        "P_SHAKE 1 2 3",
        "P_STOP_SHAKE",
        "Achievement 5",
        "実績 3",
        "C_SET_TIME 12 0",
        "SSC_CHANGE_SYSTEM_SE 1 Cursor",
        "MP_SET_MOVIE intro",
        "CommonSave 1",
        "Difficulty 2",
    ] {
        assert!(
            recognize_plugin_command(control).is_none(),
            "control command {control:?} must stay a finding"
        );
    }
}

#[test]
fn observed_control_families_are_typed_opaque_and_unknowns_stay_unknown() {
    for control in [
        "Achievement 5",
        "C_ADD_TIME 30",
        "C_ADD_TIME　30",
        "CRD_Player settings 1345",
        "OnlySellShopCall 100",
        "showHpGauge",
    ] {
        assert!(
            matches!(
                classify_plugin_command(control),
                PluginCommandRecognition::Opaque(_)
            ),
            "observed control command {control:?} must be typed opaque"
        );
    }
    assert!(matches!(
        classify_plugin_command("NewPlugin maybe text"),
        PluginCommandRecognition::Unknown
    ));
}

#[test]
fn observed_scripts_are_typed_opaque_but_new_script_shapes_are_unknown() {
    for script in [
        "BattleManager._statusWindow.hide();",
        "BattleManager._statusWindow.show();",
        "window.close()",
        "$gameVariables.setValue(21, $gameVariables.value(21).clamp(0, 100))",
    ] {
        assert!(matches!(
            classify_script_command(script),
            ScriptCommandRecognition::Opaque(_)
        ));
    }
    assert!(matches!(
        classify_script_command("showText('new')"),
        ScriptCommandRecognition::Unknown
    ));
}
