use super::*;

#[test]
fn parses_fixture_markup_into_engine_neutral_spans() {
    let text = "名前は\\N[1]、{player}<color=red><wait=30><ruby=依代|よりしろ><mystery tag>";
    let unit = json!({ "protectedSpans": [] });
    let spans = FixtureAdapter::protected_spans_for_unit(&unit, text).unwrap();

    for span in &spans {
        assert_eq!(
            &text[span.start as usize..span.end as usize],
            span.raw,
            "span should map back to source bytes: {span:?}"
        );
    }

    let placeholder = spans
        .iter()
        .find(|span| span.raw == "{player}")
        .expect("placeholder span");
    assert_eq!(placeholder.kind, "variable_placeholder");
    assert_eq!(placeholder.preserve_mode, "map");
    assert_eq!(placeholder.variable_name.as_deref(), Some("player"));

    let name_variable = spans
        .iter()
        .find(|span| span.raw == "\\N[1]")
        .expect("name variable span");
    assert_eq!(name_variable.kind, "variable_placeholder");
    assert_eq!(name_variable.parsed_name.as_deref(), Some("name_variable"));
    assert_eq!(name_variable.variable_name.as_deref(), Some("name[1]"));

    let color = spans
        .iter()
        .find(|span| span.raw == "<color=red>")
        .expect("color span");
    assert_eq!(color.kind, "control_markup");
    assert_eq!(color.parsed_name.as_deref(), Some("color"));
    assert_eq!(color.arguments.as_deref(), Some(&["red".to_string()][..]));

    let wait = spans
        .iter()
        .find(|span| span.raw == "<wait=30>")
        .expect("wait span");
    assert_eq!(wait.parsed_name.as_deref(), Some("wait"));
    assert_eq!(wait.arguments.as_deref(), Some(&["30".to_string()][..]));

    let ruby = spans
        .iter()
        .find(|span| span.raw == "<ruby=依代|よりしろ>")
        .expect("ruby span");
    assert_eq!(ruby.kind, "ruby_annotation");
    assert_eq!(ruby.annotation_text.as_deref(), Some("よりしろ"));
    assert_eq!(ruby.display_mode.as_deref(), Some("ruby"));

    let unknown = spans
        .iter()
        .find(|span| span.raw == "<mystery tag>")
        .expect("unknown tag span");
    assert_eq!(unknown.kind, "control_markup");
    assert_eq!(unknown.parsed_name.as_deref(), Some("mystery"));
    assert_eq!(unknown.arguments.as_deref(), Some(&["tag".to_string()][..]));
}

#[test]
fn protects_unknown_and_malformed_backslash_markup_conservatively() {
    let text = "未知\\Q[alpha]と\\1[42]と\\#と\\N[broken";
    let unit = json!({ "protectedSpans": [] });
    let spans = FixtureAdapter::protected_spans_for_unit(&unit, text).unwrap();

    for raw in ["\\Q[alpha]", "\\1[42]", "\\#", "\\N[broken"] {
        let span = spans
            .iter()
            .find(|span| span.raw == raw)
            .unwrap_or_else(|| panic!("missing protected span {raw}"));
        assert_eq!(span.kind, "control_markup");
        assert_eq!(
            &text[span.start as usize..span.end as usize],
            span.raw,
            "span should map back to source bytes: {span:?}"
        );
    }

    let symbol_command = spans
        .iter()
        .find(|span| span.raw == "\\1[42]")
        .expect("symbol command span");
    assert_eq!(
        symbol_command.parsed_name.as_deref(),
        Some("unknown_backslash_command")
    );
    assert_eq!(
        symbol_command.arguments.as_deref(),
        Some(&["1".to_string(), "42".to_string()][..])
    );

    let malformed = spans
        .iter()
        .find(|span| span.raw == "\\N[broken")
        .expect("malformed command span");
    assert_eq!(
        malformed.parsed_name.as_deref(),
        Some("unknown_unclosed_backslash_command")
    );
    assert_eq!(malformed.arguments.as_deref(), Some(&["N".to_string()][..]));
}

#[test]
fn explicit_fixture_spans_are_normalized_to_byte_offsets() {
    let text = "こんにちは、{player}。";
    let unit = json!({
        "protectedSpans": [
            {
                "kind": "placeholder",
                "raw": "{player}",
                "start": 6,
                "end": 14
            }
        ]
    });

    let spans = FixtureAdapter::protected_spans_for_unit(&unit, text).unwrap();

    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].kind, "variable_placeholder");
    assert_eq!(spans[0].start, 18);
    assert_eq!(spans[0].end, 26);
    assert_eq!(spans[0].variable_name.as_deref(), Some("player"));
}

#[test]
fn extracts_multi_surface_public_fixture_to_golden_bridge_snapshot() {
    let fixture_dir = public_fixture_dir();
    let extraction = FixtureAdapter
        .extract(ExtractRequest {
            game_dir: &fixture_dir,
        })
        .unwrap();
    let actual = stable_json(&extraction.bridge).unwrap();
    let expected =
        fs::read_to_string(repo_root().join("fixtures/hello-game/expected/bridge-v0.1.json"))
            .unwrap();

    assert_eq!(actual, expected);
    assert_eq!(extraction.bridge.units.len(), 11);

    let surfaces = extraction
        .bridge
        .units
        .iter()
        .map(|unit| unit.text_surface.as_str())
        .collect::<BTreeSet<_>>();
    assert!(surfaces.len() >= 5);
    for required in [
        "dialogue",
        "speaker_name",
        "choice_label",
        "ui_label",
        "tutorial_text",
        "database_entry",
        "image_text",
    ] {
        assert!(surfaces.contains(required), "missing surface {required}");
    }

    let span_kinds = extraction
        .bridge
        .units
        .iter()
        .flat_map(|unit| unit.protected_spans.iter())
        .map(|span| span.kind.as_str())
        .collect::<BTreeSet<_>>();
    assert!(span_kinds.contains("variable_placeholder"));
    assert!(span_kinds.contains("control_markup"));
}

#[test]
fn public_fixture_surface_coverage_matrix_matches_source() {
    let fixture_dir = public_fixture_dir();
    let source: Value =
        serde_json::from_str(&fs::read_to_string(fixture_dir.join("source.json")).unwrap())
            .unwrap();
    let matrix: Value = serde_json::from_str(
        &fs::read_to_string(fixture_dir.join("surface-coverage-v0.2.json")).unwrap(),
    )
    .unwrap();

    let target_locales = source["targetLocales"].as_array().unwrap();
    let locale_branches = source["localeBranches"].as_array().unwrap();
    assert!(target_locales.len() >= 2);
    assert!(locale_branches.len() >= 2);
    assert_eq!(
        matrix["localeBranches"].as_array().unwrap().len(),
        locale_branches.len()
    );

    let mut source_surface_units = BTreeMap::<String, Vec<String>>::new();
    for unit in source["units"].as_array().unwrap() {
        let surface = unit["textSurface"].as_str().unwrap().to_string();
        let key = unit["sourceUnitKey"].as_str().unwrap().to_string();
        source_surface_units.entry(surface).or_default().push(key);
    }

    let mut matrix_surface_units = BTreeMap::<String, Vec<String>>::new();
    for surface in matrix["surfaces"].as_array().unwrap() {
        let surface_kind = surface["surfaceKind"].as_str().unwrap().to_string();
        let unit_keys = surface["unitKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| key.as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            surface["unitCount"].as_u64().unwrap() as usize,
            unit_keys.len()
        );
        matrix_surface_units.insert(surface_kind, unit_keys);
    }
    assert_eq!(matrix_surface_units, source_surface_units);

    let span_kinds = matrix["protectedSpanCoverage"]
        .as_array()
        .unwrap()
        .iter()
        .map(|span| span["spanKind"].as_str().unwrap())
        .collect::<BTreeSet<_>>();
    assert!(span_kinds.contains("variable_placeholder"));
    assert!(span_kinds.contains("control_markup"));

    for bundle in matrix["expectedBridgeBundles"].as_array().unwrap() {
        let path = bundle["path"].as_str().unwrap();
        assert!(
            repo_root().join(path).is_file(),
            "missing expected bundle {path}"
        );
    }
}
