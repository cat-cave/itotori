use super::*;

fn first(report: &GameexeInventoryReport) -> &GameexeInventoryEntry {
    report.entries.first().expect("at least one entry")
}

#[test]
fn parses_caption_as_bridge_unit() {
    let ini = b"#CAPTION=\"Test Title\"\n";
    let report = parse_gameexe_inventory(ini);
    let entry = first(&report);
    assert_eq!(entry.key, "#CAPTION");
    assert_eq!(entry.value, "Test Title");
    assert_eq!(entry.treatment, GameexeKeyTreatment::BridgeUnit);
    assert!(matches!(entry.family, GameexeKeyFamily::Caption));
    assert!(report.warnings.is_empty());
}

#[test]
fn classifies_foldname_family_with_kind_suffix() {
    let ini = b"#FOLDNAME.G00 = \"G00\" = 0 : \"G00.PAK\"\n";
    let report = parse_gameexe_inventory(ini);
    let entry = first(&report);
    assert_eq!(entry.treatment, GameexeKeyTreatment::AssetReference);
    match &entry.family {
        GameexeKeyFamily::FolderName { kind } => assert_eq!(kind, "G00"),
        other => panic!("expected FolderName, got {other:?}"),
    }
}

#[test]
fn classifies_screensize_mod_as_config() {
    let ini = b"#SCREENSIZE_MOD=999,1280,720\n";
    let entry = first(&parse_gameexe_inventory(ini)).clone();
    assert_eq!(entry.treatment, GameexeKeyTreatment::Config);
    assert!(matches!(entry.family, GameexeKeyFamily::ScreenSizeMod));
}

#[test]
fn classifies_waku_two_level_index() {
    let ini = b"#WAKU.000.000.NAME=\"_waku10\"\n";
    let entry = first(&parse_gameexe_inventory(ini)).clone();
    match entry.family {
        GameexeKeyFamily::Waku {
            theme,
            variant,
            field,
        } => {
            assert_eq!(theme, "000");
            assert_eq!(variant.as_deref(), Some("000"));
            assert_eq!(field, "NAME");
        }
        other => panic!("expected Waku, got {other:?}"),
    }
    assert_eq!(entry.value, "_waku10");
}

#[test]
fn classifies_waku_one_level_index() {
    let ini = b"#WAKU.000.TYPE=5\n";
    let entry = first(&parse_gameexe_inventory(ini)).clone();
    match entry.family {
        GameexeKeyFamily::Waku {
            theme,
            variant,
            field,
        } => {
            assert_eq!(theme, "000");
            assert!(variant.is_none());
            assert_eq!(field, "TYPE");
        }
        other => panic!("expected Waku, got {other:?}"),
    }
}

#[test]
fn classifies_syscom_indexed_as_bridge_unit() {
    let ini = b"#SYSCOM.005.000=\"FullScreen\"\n";
    let entry = first(&parse_gameexe_inventory(ini)).clone();
    match entry.family {
        GameexeKeyFamily::Syscom { index } => assert_eq!(index, "005.000"),
        other => panic!("expected Syscom, got {other:?}"),
    }
    assert_eq!(entry.treatment, GameexeKeyTreatment::BridgeUnit);
}

#[test]
fn classifies_object_max_and_object_indexed() {
    let report = parse_gameexe_inventory(b"#OBJECT_MAX=256\n#OBJECT.001=0,0,0\n");
    assert_eq!(report.entries.len(), 2);
    assert!(matches!(
        report.entries[0].family,
        GameexeKeyFamily::ObjectMax
    ));
    match &report.entries[1].family {
        GameexeKeyFamily::Object { index } => assert_eq!(index, "001"),
        other => panic!("expected Object, got {other:?}"),
    }
}

#[test]
fn classifies_koeonoff_indexed_as_bridge_unit_with_speaker_set() {
    let ini = "#KOEONOFF.005.(000,002,003,004).ON=\"women\"\n".as_bytes();
    let entry = first(&parse_gameexe_inventory(ini)).clone();
    match entry.family {
        GameexeKeyFamily::KoeOnOff { index, speakers } => {
            assert_eq!(index, "005");
            assert_eq!(speakers, "000,002,003,004");
        }
        other => panic!("expected KoeOnOff, got {other:?}"),
    }
    assert_eq!(entry.treatment, GameexeKeyTreatment::BridgeUnit);
}

#[test]
fn classifies_namae_as_bridge_unit() {
    let ini = "#NAMAE=\"Kazuto\" = \"Kazuto\" = (1,016, -1)\n".as_bytes();
    let entry = first(&parse_gameexe_inventory(ini)).clone();
    assert!(matches!(entry.family, GameexeKeyFamily::Namae));
    assert_eq!(entry.treatment, GameexeKeyTreatment::BridgeUnit);
}

#[test]
fn classifies_mouseactioncall_index_and_field() {
    let ini = b"#MOUSEACTIONCALL.000.AREA=1232,0,1279,719\n";
    let entry = first(&parse_gameexe_inventory(ini)).clone();
    match entry.family {
        GameexeKeyFamily::MouseActionCall { index, field } => {
            assert_eq!(index, "000");
            assert_eq!(field, "AREA");
        }
        other => panic!("expected MouseActionCall, got {other:?}"),
    }
    assert_eq!(entry.treatment, GameexeKeyTreatment::Config);
}

#[test]
fn classifies_se_indexed_as_asset_reference() {
    let ini = b"#SE.000 = \"SELECT\" = 0\n";
    let entry = first(&parse_gameexe_inventory(ini)).clone();
    match entry.family {
        GameexeKeyFamily::SoundEffect { index } => assert_eq!(index, "000"),
        other => panic!("expected SoundEffect, got {other:?}"),
    }
    assert_eq!(entry.treatment, GameexeKeyTreatment::AssetReference);
}

#[test]
fn classifies_dstrack_as_asset_reference() {
    let ini = b"#DSTRACK = 00000000 - 08466742 - 04233233 = \"ASA\" = \"ASA\"\n";
    let entry = first(&parse_gameexe_inventory(ini)).clone();
    assert!(matches!(entry.family, GameexeKeyFamily::DsTrack));
    assert_eq!(entry.treatment, GameexeKeyTreatment::AssetReference);
}

#[test]
fn classifies_window_indexed_field() {
    let ini = b"#WINDOW.000.MOJI_SIZE=36\n";
    let entry = first(&parse_gameexe_inventory(ini)).clone();
    match entry.family {
        GameexeKeyFamily::Window { index, field } => {
            assert_eq!(index, "000");
            assert_eq!(field, "MOJI_SIZE");
        }
        other => panic!("expected Window, got {other:?}"),
    }
}

#[test]
fn classifies_window_config_attr() {
    let ini = b"#WINDOW_ATTR=100,100,160,200,0\n";
    let entry = first(&parse_gameexe_inventory(ini)).clone();
    match entry.family {
        GameexeKeyFamily::WindowConfig { field } => assert_eq!(field, "ATTR"),
        other => panic!("expected WindowConfig, got {other:?}"),
    }
    assert_eq!(entry.treatment, GameexeKeyTreatment::Config);
}

#[test]
fn classifies_save_nodata_as_bridge_unit() {
    let ini = "#SAVE_NODATA=\"empty\"\n".as_bytes();
    let entry = first(&parse_gameexe_inventory(ini)).clone();
    assert!(matches!(entry.family, GameexeKeyFamily::SaveNoData));
    assert_eq!(entry.treatment, GameexeKeyTreatment::BridgeUnit);
}

#[test]
fn classifies_savemessage_str_as_bridge_unit() {
    let ini = "#SAVEMESSAGE_TITLE_STR=\"confirm\"\n".as_bytes();
    let entry = first(&parse_gameexe_inventory(ini)).clone();
    assert_eq!(entry.treatment, GameexeKeyTreatment::BridgeUnit);
}

#[test]
fn classifies_btnobj_with_kind_and_rest() {
    let ini = b"#BTNOBJ.ACTION.000.HIT=1\n";
    let entry = first(&parse_gameexe_inventory(ini)).clone();
    match entry.family {
        GameexeKeyFamily::BtnObj { kind, rest } => {
            assert_eq!(kind, "ACTION");
            assert_eq!(rest, "000.HIT");
        }
        other => panic!("expected BtnObj, got {other:?}"),
    }
}

#[test]
fn classifies_hint_subfamily() {
    let ini = b"#HINT.AUTOMODE.POS=1140,0\n";
    let entry = first(&parse_gameexe_inventory(ini)).clone();
    match entry.family {
        GameexeKeyFamily::Hint { kind, rest } => {
            assert_eq!(kind, "AUTOMODE");
            assert_eq!(rest, "POS");
        }
        other => panic!("expected Hint, got {other:?}"),
    }
}

#[test]
fn classifies_mask_indexed_as_asset_reference() {
    let entry = first(&parse_gameexe_inventory(b"#MASK.003=\"_mask03\"\n")).clone();
    match entry.family {
        GameexeKeyFamily::Mask { index } => assert_eq!(index, "003"),
        other => panic!("expected Mask, got {other:?}"),
    }
    assert_eq!(entry.treatment, GameexeKeyTreatment::AssetReference);
}

#[test]
fn classifies_color_table_indexed() {
    let entry = first(&parse_gameexe_inventory(b"#COLOR_TABLE.001=255,255,255\n")).clone();
    match entry.family {
        GameexeKeyFamily::ColorTable { index } => assert_eq!(index, "001"),
        other => panic!("expected ColorTable, got {other:?}"),
    }
}

#[test]
fn classifies_init_family() {
    let entry = first(&parse_gameexe_inventory(b"#INIT_SCREENMODE=0\n")).clone();
    match entry.family {
        GameexeKeyFamily::Init { field } => assert_eq!(field, "SCREENMODE"),
        other => panic!("expected Init, got {other:?}"),
    }
}

#[test]
fn numeric_g00_knob_is_config_not_asset_reference() {
    // `#G00BUF=8` is an image-buffer count, not an asset path; it
    // must not be emitted as a literal asset reference.
    let report = parse_gameexe_inventory(b"#G00BUF=8\n");
    let entry = first(&report);
    assert_eq!(entry.treatment, GameexeKeyTreatment::Config);
    assert!(matches!(entry.family, GameexeKeyFamily::G00Family));
}

#[test]
fn path_g00_declaration_stays_asset_reference() {
    // A non-numeric `#G00*` RHS is an actual path/pack declaration.
    let report = parse_gameexe_inventory(b"#G00PACK=bg.g00\n");
    let entry = first(&report);
    assert_eq!(entry.treatment, GameexeKeyTreatment::AssetReference);
    assert!(matches!(entry.family, GameexeKeyFamily::G00Family));
}

#[test]
fn koepac_stays_asset_reference() {
    let report = parse_gameexe_inventory(b"#KOEPAC=koe.ovk\n");
    let entry = first(&report);
    assert_eq!(entry.treatment, GameexeKeyTreatment::AssetReference);
    assert!(matches!(entry.family, GameexeKeyFamily::KoePack));
}

#[test]
fn negative_test_bare_hash_yields_malformed_unknown() {
    let report = parse_gameexe_inventory(b"#\n");
    let entry = first(&report);
    assert_eq!(entry.treatment, GameexeKeyTreatment::Unknown);
    match &entry.family {
        GameexeKeyFamily::Unknown { reason, .. } => {
            assert_eq!(*reason, UnknownReason::MalformedKey);
        }
        other => panic!("expected Unknown, got {other:?}"),
    }
    assert_eq!(report.warnings.len(), 1);
    assert_eq!(report.warnings[0].code, UNKNOWN_GAMEEXE_KEY_CODE);
}

#[test]
fn negative_test_hash_dot_only_yields_malformed_unknown() {
    let report = parse_gameexe_inventory(b"#.foo=1\n");
    let entry = first(&report);
    assert_eq!(entry.treatment, GameexeKeyTreatment::Unknown);
    match &entry.family {
        GameexeKeyFamily::Unknown { reason, .. } => {
            assert_eq!(*reason, UnknownReason::MalformedKey);
        }
        other => panic!("expected Unknown, got {other:?}"),
    }
}

#[test]
fn negative_test_garbage_family_yields_unknown_family() {
    let report = parse_gameexe_inventory(b"#NONSENSE_FAMILY_THAT_DOES_NOT_EXIST=1\n");
    let entry = first(&report);
    assert_eq!(entry.treatment, GameexeKeyTreatment::Unknown);
    match &entry.family {
        GameexeKeyFamily::Unknown { reason, raw_key } => {
            assert_eq!(*reason, UnknownReason::UnknownFamily);
            assert!(raw_key.contains("NONSENSE_FAMILY"));
        }
        other => panic!("expected Unknown, got {other:?}"),
    }
}

#[test]
fn unknown_carries_raw_key_text() {
    let report = parse_gameexe_inventory(b"#WEIRDXXX=42\n");
    let entry = first(&report);
    match &entry.family {
        GameexeKeyFamily::Unknown { raw_key, .. } => {
            assert_eq!(raw_key, "#WEIRDXXX");
        }
        other => panic!("expected Unknown, got {other:?}"),
    }
}

#[test]
fn handles_crlf_line_endings_and_blank_lines() {
    let ini = b"\r\n#CAPTION=\"Hi\"\r\n\r\n#REGNAME=Tester\r\n";
    let report = parse_gameexe_inventory(ini);
    assert_eq!(report.entries.len(), 2);
    assert_eq!(report.entries[0].key, "#CAPTION");
    assert_eq!(report.entries[1].key, "#REGNAME");
}

#[test]
fn systemcall_retains_subtype_payload() {
    let (save, _) = classify_key("#SYSTEMCALL_SAVE", "");
    let (load, _) = classify_key("#SYSTEMCALL_LOAD", "");
    match (&save, &load) {
        (
            GameexeKeyFamily::SystemCall {
                payload: save_payload,
            },
            GameexeKeyFamily::SystemCall {
                payload: load_payload,
            },
        ) => {
            assert_eq!(save_payload, "SAVE");
            assert_eq!(load_payload, "LOAD");
        }
        other => panic!("expected distinct SystemCall payloads, got {other:?}"),
    }
    // The two sub-calls are now distinguishable typed values.
    assert_ne!(save, load);
}

#[test]
fn window_attr_classifies_via_window_prefix() {
    // The removed shadowed `WINDOW_ATTR` branch produced the same
    // result the `WINDOW_` strip already yields.
    let (family, treatment) = classify_key("#WINDOW_ATTR", "");
    assert_eq!(treatment, GameexeKeyTreatment::Config);
    match family {
        GameexeKeyFamily::WindowConfig { field } => assert_eq!(field, "ATTR"),
        other => panic!("expected WindowConfig, got {other:?}"),
    }
}

#[test]
fn msgbk_button_disp_mode_is_message_back_config_not_engine_bootstrap() {
    let (family, _) = classify_key("#MSGBK_BUTTON_DISP_MODE", "");
    match family {
        GameexeKeyFamily::MessageBackConfig { field } => {
            assert_eq!(field, "BUTTON_DISP_MODE");
        }
        other => panic!("expected MessageBackConfig, got {other:?}"),
    }
}

#[test]
fn classifies_dll_slot_binding_as_config() {
    // `#DLL.000 = "rlBabel"` is a RealLive extension-DLL slot binding
    // (observed in the Kanon corpus); it is engine config, not a
    // translatable string or an asset path, and must not fall through
    // to Unknown.
    let ini = b"#DLL.000 = \"rlBabel\"\n";
    let report = parse_gameexe_inventory(ini);
    let entry = first(&report);
    assert_eq!(entry.treatment, GameexeKeyTreatment::Config);
    match &entry.family {
        GameexeKeyFamily::Dll { index } => assert_eq!(index, "000"),
        other => panic!("expected Dll, got {other:?}"),
    }
    assert!(report.warnings.is_empty());
}

#[test]
fn stray_bare_d_key_surfaces_unknown_not_silent_config() {
    let (family, treatment) = classify_key("#D", "");
    assert_eq!(treatment, GameexeKeyTreatment::Unknown);
    match family {
        GameexeKeyFamily::Unknown { raw_key, reason } => {
            assert_eq!(raw_key, "#D");
            assert_eq!(reason, UnknownReason::UnknownFamily);
        }
        other => panic!("expected Unknown, got {other:?}"),
    }
}
