use super::*;

#[test]
fn parses_surface_key_with_rfc6901_decoding() {
    let (file, tokens) = parse_surface_key("rpgmaker:Items.json#/1/description").unwrap();
    assert_eq!(file, "Items.json");
    assert_eq!(tokens, vec!["1".to_string(), "description".to_string()]);

    let (file, tokens) =
        parse_surface_key("rpgmaker:System.json#/terms/messages/possession").unwrap();
    assert_eq!(file, "System.json");
    assert_eq!(
        tokens,
        vec![
            "terms".to_string(),
            "messages".to_string(),
            "possession".to_string()
        ]
    );

    // RFC6901 escapes: ~1 -> '/', ~0 -> '~'.
    let (_, tokens) = parse_surface_key("rpgmaker:M.json#/a~1b/c~0d").unwrap();
    assert_eq!(tokens, vec!["a/b".to_string(), "c~d".to_string()]);
}

#[test]
fn malformed_surface_keys_are_typed_errors() {
    assert!(matches!(
        parse_surface_key("notrpgmaker:x#/a"),
        Err(PatchbackError::SurfaceKeyMalformed { .. })
    ));
    assert!(matches!(
        parse_surface_key("rpgmaker:Items.json/1/name"),
        Err(PatchbackError::SurfaceKeyMalformed { .. })
    ));
}

fn edit(key: &str, tokens: &[&str], target: &str, source: &str) -> FileEdit {
    FileEdit {
        source_unit_key: key.to_string(),
        tokens: tokens
            .iter()
            .map(std::string::ToString::to_string)
            .collect(),
        target_text: target.to_string(),
        expected_source_hash: sha256_hash_bytes(source.as_bytes()),
    }
}

#[test]
fn untranslated_edit_is_byte_identical_noop() {
    // Top-level array, mirroring a real database file shape.
    let original = br#"[null,{"id":1,"name":"Potion","description":"Heals."}]"#;
    // target == source for every edit.
    let edits = vec![
        edit(
            "rpgmaker:Items.json#/1/name",
            &["1", "name"],
            "Potion",
            "Potion",
        ),
        edit(
            "rpgmaker:Items.json#/1/description",
            &["1", "description"],
            "Heals.",
            "Heals.",
        ),
    ];
    let out = patch_file_bytes("Items.json", original, &edits).unwrap();
    assert_eq!(out, original, "untranslated patch must be byte-identical");
}

#[test]
fn translated_edit_changes_only_targeted_surface() {
    let original = br#"[null,{"id":1,"name":"Potion","description":"Heals."}]"#;
    // A non-ASCII translation (katakana "ポーション").
    let target = "\u{30dd}\u{30fc}\u{30b7}\u{30e7}\u{30f3}";
    let edits = vec![edit(
        "rpgmaker:Items.json#/1/name",
        &["1", "name"],
        target,
        "Potion",
    )];
    let out = patch_file_bytes("Items.json", original, &edits).unwrap();
    assert_ne!(out, original);

    // The whole file is byte-identical except the targeted `name`
    // literal, which is replaced by the ASCII-safe `\u`-escaped target
    // (the encoder output is pinned by its own unit test).
    let encoded_name = encode_json_string_ascii_safe(target);
    let expected = format!(r#"[null,{{"id":1,"name":{encoded_name},"description":"Heals."}}]"#);
    assert_eq!(out, expected.as_bytes());

    // The non-targeted `description` surface still decodes intact.
    let mut scanner = Scanner::new(&out);
    let span = scanner
        .locate(&["1".to_string(), "description".to_string()])
        .unwrap();
    assert_eq!(Scanner::decode_span(&out, span).unwrap(), "Heals.");
}

#[test]
fn stale_source_is_typed_error() {
    let original = br#"[null,{"id":1,"name":"Potion"}]"#;
    // Hash gate computed against a different source string.
    let edits = vec![edit(
        "rpgmaker:Items.json#/1/name",
        &["1", "name"],
        "Elixir",
        "DIFFERENT-SOURCE",
    )];
    let err = patch_file_bytes("Items.json", original, &edits).unwrap_err();
    assert!(
        matches!(err, PatchbackError::StaleSource { .. }),
        "expected StaleSource, got {err:?}"
    );
    assert!(err.to_string().contains(PATCHBACK_STALE_SOURCE_CODE));
}

#[test]
fn unresolved_surface_is_typed_error() {
    let original = br#"[null,{"id":1,"name":"Potion"}]"#;
    let edits = vec![edit(
        "rpgmaker:Items.json#/1/missing",
        &["1", "missing"],
        "x",
        "Potion",
    )];
    let err = patch_file_bytes("Items.json", original, &edits).unwrap_err();
    assert!(
        matches!(err, PatchbackError::UnresolvedSurface { .. }),
        "expected UnresolvedSurface, got {err:?}"
    );
}
