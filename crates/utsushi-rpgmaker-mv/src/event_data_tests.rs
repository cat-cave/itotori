use super::*;
use serde_json::json;

#[test]
fn classifies_map_files() {
    assert!(is_map_file("Map001.json"));
    assert!(is_map_file("Map12.json"));
    assert!(!is_map_file("CommonEvents.json"));
    assert!(!is_map_file("MapInfos.json"));
    assert!(!is_map_file("Map.json"));
}

#[test]
fn walks_show_text_window_with_mz_speaker() {
    let value = json!({
        "events": [
            null,
            { "pages": [ { "list": [
                { "code": 101, "indent": 0, "parameters": ["face", 0, 0, 2, "Alice"] },
                { "code": 401, "indent": 0, "parameters": ["Hello there."] },
                { "code": 401, "indent": 0, "parameters": ["How are you?"] },
                { "code": 0, "indent": 0, "parameters": [] }
            ] } ] }
        ]
    });
    let mut out = Vec::new();
    walk_map("Map001.json", &value, &mut out).unwrap();
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].text, "Hello there.");
    assert_eq!(out[0].speaker.as_deref(), Some("Alice"));
    assert_eq!(out[0].role, TextRole::Dialogue);
    assert_eq!(out[1].text, "How are you?");
    assert_eq!(out[0].message_group, out[1].message_group);
    assert_eq!(
        out[0].source_unit_key(),
        "rpgmaker-mv:Map001.json#/events/1/pages/0/list/1/parameters/0"
    );
}

#[test]
fn walks_choices_and_scrolling() {
    let value = json!([
        null,
        { "list": [
            { "code": 102, "indent": 0, "parameters": [["Yes", "No"], 1] },
            { "code": 105, "indent": 0, "parameters": [2, false] },
            { "code": 405, "indent": 0, "parameters": ["Scrolling line."] }
        ] }
    ]);
    let mut out = Vec::new();
    walk_common_events("CommonEvents.json", &value, &mut out).unwrap();
    assert_eq!(out.len(), 3);
    assert_eq!(out[0].role, TextRole::Choice);
    assert_eq!(out[0].text, "Yes");
    assert_eq!(out[1].text, "No");
    assert_eq!(out[2].role, TextRole::Scrolling);
    assert_eq!(out[2].text, "Scrolling line.");
}

#[test]
fn rejects_event_commands_with_missing_or_non_integer_codes() {
    for (case, command) in [
        ("missing", json!({ "parameters": [] })),
        ("non-integer", json!({ "code": "401", "parameters": [] })),
    ] {
        let temp_dir = tempfile::tempdir().unwrap();
        let data_dir = temp_dir.path().join("www/data");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(
            data_dir.join("CommonEvents.json"),
            serde_json::to_vec(&json!([null, { "list": [command] }])).unwrap(),
        )
        .unwrap();

        let result = load_program(&DataDir {
            layout: DataLayout::Mv,
            root: data_dir,
        });

        assert!(
            matches!(
                result,
                Err(EventDataError::MalformedCommandCode { file, pointer })
                    if file == "CommonEvents.json" && pointer == "/1/list/0/code"
            ),
            "{case} command code should be rejected as malformed"
        );
    }
}
