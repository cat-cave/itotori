use super::*;

fn parse_str(text: &str) -> Gameexe {
    let bytes = encoding_rs::SHIFT_JIS.encode(text).0.into_owned();
    Gameexe::parse(&bytes).expect("synthetic input must parse")
}

#[test]
fn parses_quoted_string_scalar() {
    let gx = parse_str("#CAPTION=\"hello\"\r\n");
    assert_eq!(gx.get_str("CAPTION"), Some("hello"));
    assert!(gx.get_int_array("CAPTION").is_none());
}

#[test]
fn parses_unquoted_string_scalar() {
    let gx = parse_str("#REGNAME = SAMPLE\\FIXTURE\r\n");
    assert_eq!(gx.get_str("REGNAME"), Some("SAMPLE\\FIXTURE"));
}

#[test]
fn parses_integer_scalar_as_one_element_array() {
    let gx = parse_str("#SEEN_START=0001\r\n");
    assert_eq!(gx.get_int("SEEN_START"), Some(1));
    assert_eq!(gx.get_int_array("SEEN_START"), Some(&[1][..]));
    assert!(gx.get_str("SEEN_START").is_none());
}

#[test]
fn records_typed_warning_for_malformed_integer_token() {
    let gx = parse_str("#KEY = abc\r\n");

    assert!(gx.get_int("KEY").is_none());
    assert_eq!(
        gx.warnings(),
        &[GameexeParseWarning {
            key: "KEY".to_string(),
            raw: "abc".to_string(),
        }]
    );
}

#[test]
fn screen_size_reads_screensize_mod() {
    assert_eq!(
        parse_str("#SCREENSIZE_MOD=0\r\n").screen_size_px(),
        (640, 480)
    );
    assert_eq!(
        parse_str("#SCREENSIZE_MOD=1\r\n").screen_size_px(),
        (800, 600)
    );
    assert_eq!(
        parse_str("#SCREENSIZE_MOD=999,1280,720\r\n").screen_size_px(),
        (1280, 720)
    );
    // Missing → classic default, never a panic.
    assert_eq!(parse_str("#CAPTION=\"x\"\r\n").screen_size_px(), (640, 480));
}

#[test]
fn message_window_reads_fixture_global_attr_narration_window() {
    // Sample fixture #WINDOW.000: top-left bottom box, ATTR_MOD=0 so the global
    // #WINDOW_ATTR supplies the colour, NAME_MOD=0 (narration only).
    let gx = parse_str(
        "#WINDOW_ATTR=100,100,160,200,0\r\n\
             #WINDOW.000.POS=0:0,345\r\n\
             #WINDOW.000.ATTR_MOD=0\r\n\
             #WINDOW.000.ATTR=080,112,160,255,0\r\n\
             #WINDOW.000.MOJI_SIZE=25\r\n\
             #WINDOW.000.MOJI_POS=19,0,53,0\r\n\
             #WINDOW.000.MOJI_CNT=22,3\r\n\
             #WINDOW.000.MOJI_REP=-1,3\r\n\
             #WINDOW.000.NAME_MOD=0\r\n\
             #WINDOW.000.MESSAGE_MOD=0\r\n",
    );
    let cfg = gx.message_window(0);
    assert_eq!(cfg.origin, 0);
    assert_eq!((cfg.pos_x, cfg.pos_y), (0, 345));
    // ATTR_MOD=0 → global WINDOW_ATTR wins over the window-local ATTR.
    assert_eq!(cfg.attr_rgba, (100, 100, 160, 200));
    assert_eq!(cfg.moji_size, 25);
    assert_eq!(cfg.moji_pad, (19, 0, 53, 0));
    assert_eq!(cfg.moji_cnt, Some((22, 3)));
    assert_eq!(cfg.moji_rep, (-1, 3));
    assert_eq!(cfg.name_mod, 0);
}

#[test]
fn message_window_reads_fixture_name_box_and_local_attr() {
    // Sample fixture #WINDOW.000 with ATTR_MOD=1 → the window-local ATTR
    // is used; NAME_MOD=1 → separate name box.
    let gx = parse_str(
        "#WINDOW_ATTR=100,100,160,200,0\r\n\
             #WINDOW.000.POS=2:220,0\r\n\
             #WINDOW.000.ATTR_MOD=1\r\n\
             #WINDOW.000.ATTR=10,20,30,240,0\r\n\
             #WINDOW.000.MOJI_SIZE=36\r\n\
             #WINDOW.000.MOJI_POS=48,0,12,0\r\n\
             #WINDOW.000.NAME_MOD=1\r\n\
             #WINDOW.000.NAME_MOJI_SIZE=25\r\n\
             #WINDOW.000.NAME_POS=18,26\r\n\
             #WINDOW.000.MESSAGE_MOD=0\r\n",
    );
    let cfg = gx.message_window(0);
    assert_eq!(cfg.origin, 2);
    assert_eq!((cfg.pos_x, cfg.pos_y), (220, 0));
    // ATTR_MOD=1 → window-local ATTR, NOT the global.
    assert_eq!(cfg.attr_rgba, (10, 20, 30, 240));
    assert_eq!(cfg.moji_size, 36);
    assert_eq!(cfg.name_mod, 1);
    assert_eq!(cfg.name_moji_size, 25);
    assert_eq!(cfg.name_pos, (18, 26));
}

#[test]
fn parses_integer_array() {
    let gx = parse_str("#SCREENSIZE_MOD=999,1280,720\r\n");
    assert_eq!(
        gx.get_int_array("SCREENSIZE_MOD"),
        Some(&[999, 1280, 720][..])
    );
    // Asking for a string on an int-array yields None — typed mismatch
    // never panics.
    assert!(gx.get_str("SCREENSIZE_MOD").is_none());
    // Wrong shape accessors also return None, not a wrong-shape
    // partial answer.
    assert!(gx.get_int("SCREENSIZE_MOD").is_none());
    assert!(gx.get_int_pair("SCREENSIZE_MOD").is_none());
}

#[test]
fn parses_integer_pair() {
    let gx = parse_str("#CANCELCALL=9999,10\r\n");
    assert_eq!(gx.get_int_pair("CANCELCALL"), Some((9999, 10)));
    assert_eq!(gx.get_int_array("CANCELCALL"), Some(&[9999, 10][..]));
}

#[test]
fn parses_foldname_triple_with_empty_archive() {
    let gx = parse_str("#FOLDNAME.KOE = \"KOE\" =  1   : \"\"\r\n");
    assert_eq!(gx.get_tuple3("FOLDNAME.KOE"), Some(("KOE", 1, "")));
}

#[test]
fn parses_foldname_triple_with_pak() {
    let gx = parse_str("#FOLDNAME.G00 = \"G00\" =  0   : \"G00.PAK\"\r\n");
    assert_eq!(gx.get_tuple3("FOLDNAME.G00"), Some(("G00", 0, "G00.PAK")));
}

#[test]
fn malformed_foldname_raises_typed_error() {
    let bytes = b"#FOLDNAME.X = no_quote = 0 : \"X.PAK\"\r\n";
    let err = Gameexe::parse(bytes).expect_err("malformed FOLDNAME must raise");
    assert!(matches!(err, GameexeParseError::MalformedFoldname { .. }));
}

#[test]
fn parses_namae_entry_keyed_by_display() {
    // Encoded so the input is true Shift-JIS bytes, not UTF-8.
    let gx = parse_str("#NAMAE=\"和人\" = \"和人\" = (1,016, -1)\r\n");
    let entry = gx
        .get_namae("NAMAE.和人")
        .expect("NAMAE.<display> must be reachable");
    assert_eq!(entry.display, "和人");
    assert_eq!(entry.canonical, "和人");
    assert_eq!(entry.mode, 1);
    assert_eq!(entry.color_table_index, 16);
    assert_eq!(entry.reserved, -1);
}

#[test]
fn namae_resolver_maps_key_to_display_and_color_table_rgb() {
    // NAMAE middle field is a #COLOR_TABLE index, not a voice slot.
    // 和人 → idx 16 → COLOR_TABLE.016 = (204,204,255) pale;
    // 真理子 → idx 14 → COLOR_TABLE.014 = (255,153,204) pink.
    let gx = parse_str(
        "#COLOR_TABLE.014=255,153,204\r\n\
             #COLOR_TABLE.016=204,204,255\r\n\
             #NAMAE=\"和人\" = \"和人\" = (1,016, -1)\r\n\
             #NAMAE=\"真理子\" = \"真理子\" = (1,014, -1)\r\n\
             #NAMAE=\"？？？／凛\" = \"？？？\" = (1,015, -1)\r\n",
    );
    let resolver = gx.namae_resolver();
    let kazuto = resolver.resolve("和人").expect("和人 resolves");
    assert_eq!(kazuto.display_name, "和人");
    assert_eq!(kazuto.color, [204, 204, 255]);
    let mariko = resolver.resolve("真理子").expect("真理子 resolves");
    assert_eq!(mariko.display_name, "真理子");
    assert_eq!(mariko.color, [255, 153, 204]);
    // Censored key shows the canonical box name (？？？), not the key.
    let hidden = resolver.resolve("？？？／凛").expect("？？？／凛 resolves");
    assert_eq!(hidden.display_name, "？？？");
    // Narration / unregistered key → no speaker.
    assert!(resolver.resolve("ナレーション").is_none());
}

#[test]
fn malformed_namae_raises_typed_error() {
    let bytes = b"#NAMAE=\"unclosed\r\n";
    let err = Gameexe::parse(bytes).expect_err("unclosed NAMAE must raise");
    assert!(matches!(err, GameexeParseError::MalformedNamae { .. }));
}

#[test]
fn parses_syscom_user_prefix() {
    let gx = parse_str("#SYSCOM.000=U:\"label\"\r\n");
    let value = gx.get("SYSCOM.000").expect("SYSCOM.000 must be reachable");
    match value {
        GameexeValue::SyscomLabel(label) => {
            assert_eq!(label.visibility, SyscomVisibility::User);
            assert_eq!(label.label, "label");
        }
        other => panic!("expected SyscomLabel, got {other:?}"),
    }
    // get_str on a SyscomLabel returns the label body.
    assert_eq!(gx.get_str("SYSCOM.000"), Some("label"));
}

#[test]
fn parses_syscom_nav_prefix() {
    let gx = parse_str("#SYSCOM.011=N:\"label\"\r\n");
    let value = gx.get("SYSCOM.011").expect("SYSCOM.011 must be reachable");
    match value {
        GameexeValue::SyscomLabel(label) => {
            assert_eq!(label.visibility, SyscomVisibility::Navigation);
            assert_eq!(label.label, "label");
        }
        other => panic!("expected SyscomLabel, got {other:?}"),
    }
}

#[test]
fn parses_syscom_sub_option_without_prefix() {
    let gx = parse_str("#SYSCOM.005.000=\"option0\"\r\n");
    let value = gx.get("SYSCOM.005.000").expect("must be reachable");
    match value {
        GameexeValue::SyscomLabel(label) => {
            assert_eq!(label.visibility, SyscomVisibility::Unspecified);
            assert_eq!(label.label, "option0");
        }
        other => panic!("expected SyscomLabel, got {other:?}"),
    }
}

#[test]
fn missing_key_returns_none_not_error() {
    let gx = parse_str("#FOO=1\r\n");
    assert!(gx.get("BAR").is_none());
    assert!(gx.get_str("BAR").is_none());
    assert!(gx.get_int("BAR").is_none());
    assert!(gx.get_int_array("BAR").is_none());
    assert!(gx.get_tuple3("BAR").is_none());
}

#[test]
fn list_namespace_returns_source_order() {
    let gx = parse_str("#SYSCOM.000=U:\"A\"\r\n#SYSCOM.001=U:\"B\"\r\n#SYSCOM.002=U:\"C\"\r\n");
    let listed = gx.list_namespace("SYSCOM");
    assert_eq!(listed, vec!["SYSCOM.000", "SYSCOM.001", "SYSCOM.002"]);
}

#[test]
fn shift_jis_replacement_raises_typed_error() {
    // 0xFD is not a valid Shift-JIS lead byte; `encoding_rs` will
    // substitute U+FFFD. The parser must surface that as
    // `ShiftJisDecode` rather than silently dropping the byte.
    let bytes: &[u8] = &[b'#', b'K', b'=', 0xFD, b'\r', b'\n'];
    let err = Gameexe::parse(bytes).expect_err("invalid Shift-JIS must raise");
    match err {
        GameexeParseError::ShiftJisDecode {
            code, line_number, ..
        } => {
            assert_eq!(code, GAMEEXE_SHIFT_JIS_DECODE_FAILURE_CODE);
            assert_eq!(line_number, 1);
        }
        other => panic!("expected ShiftJisDecode, got {other:?}"),
    }
}

#[test]
fn malformed_key_raises_typed_error() {
    let bytes = b"#=novalue\r\n";
    let err = Gameexe::parse(bytes).expect_err("empty key must raise");
    assert!(matches!(err, GameexeParseError::MalformedKey { .. }));
}

#[test]
fn malformed_dotted_key_raises_typed_error() {
    let bytes = b"#.X=1\r\n";
    let err = Gameexe::parse(bytes).expect_err("leading-dot key must raise");
    assert!(matches!(err, GameexeParseError::MalformedKey { .. }));
}

#[test]
fn comment_and_blank_lines_skip_silently() {
    let gx = parse_str("\r\n; comment\r\n   \r\n#OK=1\r\n");
    assert_eq!(gx.len(), 1);
    assert_eq!(gx.get_int("OK"), Some(1));
}

#[test]
fn parse_into_arc_yields_shared_tree() {
    let bytes = encoding_rs::SHIFT_JIS.encode("#A=1\r\n").0.into_owned();
    let arc = parse_into_arc(&bytes).expect("must parse");
    assert_eq!(arc.get_int("A"), Some(1));
}

#[test]
fn case_insensitive_keys_normalise_on_lookup() {
    let gx = parse_str("#caption=\"hi\"\r\n");
    assert_eq!(gx.get_str("CAPTION"), Some("hi"));
    // Lookup with lowercase or leading `#` works too.
    assert_eq!(gx.get_str("caption"), Some("hi"));
    assert_eq!(gx.get_str("#CAPTION"), Some("hi"));
}

#[test]
fn duplicate_key_last_writer_wins() {
    // The flat map keeps one entry per dotted path; a later line
    // overwrites an earlier one but does not change source order.
    let gx = parse_str("#K=1\r\n#K=2\r\n");
    assert_eq!(gx.get_int("K"), Some(2));
    assert_eq!(gx.list_namespace("K"), vec!["K"]);
}
