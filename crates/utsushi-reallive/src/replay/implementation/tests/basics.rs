use super::*;

#[test]
fn replay_opts_default_step_budget_matches_constant() {
    let opts = ReplayOpts::default();
    assert_eq!(opts.step_budget, DEFAULT_REPLAY_STEP_BUDGET);
    assert!(!opts.stop_at_first_pause);
}

/// Regression for the `(module_type=1, module_id=5, opcode=3)` key
/// COLLISION: `msg.pause` and `sel.select_objbtn` used to share a key
/// because `module_id`s were mislabelled (both 5), so `sel` silently
/// clobbered `msg.pause` in the shared registry and Pause-event
/// detection dispatched the wrong op. With the real ids (msg=3
/// sel=2) the two ops occupy DISTINCT keys and `mount_full_registry`
/// registers both with no displacement (the dup-key guard would panic
/// on any collision).
#[test]
fn msg_pause_and_sel_select_objbtn_occupy_distinct_registry_keys() {
    let pause_key = RlopKey::new(
        MSG_MODULE_TYPE,
        MSG_MODULE_ID,
        crate::rlop::module_msg::OPCODE_PAUSE,
    );
    let objbtn_key = RlopKey::new(
        crate::rlop::module_sel::SEL_MODULE_TYPE,
        crate::rlop::module_sel::SEL_MODULE_ID,
        crate::rlop::module_sel::OPCODE_SELECT_OBJBTN,
    );
    // The corrected real ids. `sel` lives at the real RealLive `Sel`
    // module (module_type=0, module_id=2); `msg` at (1, 3). They no
    // longer share a module_type, so the two keys are trivially distinct.
    assert_eq!(pause_key, RlopKey::new(1, 3, 3), "msg.pause is (1, 3, 3)");
    assert_eq!(
        objbtn_key,
        RlopKey::new(0, 2, 4),
        "sel.select_objbtn is the REAL rlvm opcode (0, 2, 4)"
    );
    assert_ne!(
        pause_key, objbtn_key,
        "msg.pause and sel.select_objbtn MUST NOT share a key"
    );

    // Mounting the full registry must NOT panic (the dup-key guard
    // proves there is no displacement anywhere in the 9-family
    // catalog mount), and both keys must resolve to their own op.
    let sink: Arc<ReplayTextSink> = Arc::new(ReplayTextSink::default());
    let sink_dyn: Arc<dyn TextSurfaceSink> = Arc::clone(&sink) as Arc<dyn TextSurfaceSink>;
    let runtime = Arc::new(MsgRuntime::with_sink(Arc::clone(&sink_dyn)));
    let registry = mount_full_registry(sink_dyn, runtime);
    assert!(
        registry.get(pause_key).is_some(),
        "msg.pause must resolve at its own key"
    );
    assert!(
        registry.get(objbtn_key).is_some(),
        "sel.select_objbtn must resolve at its own key"
    );
}

#[test]
fn empty_replay_log_serialises_deterministically() {
    let log = ReplayLog {
        schema_version: REPLAY_LOG_SCHEMA_VERSION.to_string(),
        scene_id: 1,
        events: vec![],
        final_outcome: ReplayOutcome::EndOfScene { events: 0 },
    };
    let a = log.to_deterministic_json().expect("serialise");
    let b = log.to_deterministic_json().expect("serialise");
    assert_eq!(a, b);
    // Pinned key ordering.
    assert!(a.contains("\"events\""));
    assert!(a.contains("\"finalOutcome\""));
    assert!(a.contains("\"schemaVersion\""));
    assert!(a.contains("\"sceneId\""));
}

#[test]
fn replay_log_text_line_count_matches_event_count() {
    let log = ReplayLog {
        schema_version: REPLAY_LOG_SCHEMA_VERSION.to_string(),
        scene_id: 1,
        events: vec![
            ReplayEvent::Tick { count: 0 },
            ReplayEvent::TextLine {
                byte_offset_in_scene: 12,
                body_shift_jis: vec![0x82, 0xa0],
                body_utf8: "あ".to_string(),
                speaker: None,
                color: None,
            },
            ReplayEvent::Pause {
                byte_offset_in_scene: 20,
            },
        ],
        final_outcome: ReplayOutcome::FirstPauseReached { events: 3 },
    };
    assert_eq!(log.text_line_count(), 1);
    assert_eq!(log.unknown_opcode_count(), 0);
    assert_eq!(log.first_text_line_utf8(), Some("あ"));
}

#[test]
fn semantic_catalog_and_missing_commands_have_distinct_replay_provenance() {
    let engine = semantic_catalog_and_missing_engine();
    let opts = ReplayOpts::default();
    let log = engine.replay_from(1, &opts);

    assert_eq!(log.final_outcome, ReplayOutcome::EndOfScene { events: 6 });
    assert_eq!(log.catalog_fallback_count(), 1);
    assert_eq!(log.catalog_fallback_keys(), vec![(0, 5, 0)]);
    assert_eq!(log.unknown_opcode_count(), 1);
    assert_eq!(log.unknown_opcode_keys(), vec![(2, 250, 9)]);
    assert!(log.events.iter().any(|event| {
        matches!(
            event,
            ReplayEvent::CatalogFallback {
                byte_offset_in_scene: 8,
                module_type: 0,
                module_id: 5,
                opcode: 0,
            }
        )
    }));

    let report = engine.branch_following_report(1, &opts, HeadlessChoicePolicy::AlwaysFirst);
    assert_eq!(report.catalog_fallback_keys, vec![(0, 5, 0)]);
    assert_eq!(report.unknown_opcode_keys, vec![(2, 250, 9)]);

    let once = log
        .to_deterministic_json()
        .expect("serialise catalog event");
    let twice = log
        .to_deterministic_json()
        .expect("serialise catalog event again");
    assert_eq!(once, twice);
    assert!(once.contains("\"kind\": \"catalog_fallback\""));
}

#[test]
fn replay_event_text_line_hexes_body_bytes() {
    let event = ReplayEvent::TextLine {
        byte_offset_in_scene: 0,
        body_shift_jis: vec![0xde, 0xad, 0xbe, 0xef],
        body_utf8: String::new(),
        speaker: None,
        color: None,
    };
    let value = event_to_canonical_value(&event);
    let obj = value.as_object().expect("object");
    assert_eq!(
        obj.get("bodyShiftJisHex").and_then(|value| value.as_str()),
        Some("deadbeef"),
    );
}

#[test]
fn bytes_to_hex_round_trips_with_pinned_alphabet() {
    assert_eq!(bytes_to_hex(&[0x00, 0x0f, 0x10, 0xff]), "000f10ff");
}

#[test]
fn replay_scene_missing_file_returns_typed_read_failed() {
    let path = std::path::Path::new("/nonexistent/utsushi-reallive-replay-test/Seen.txt");
    let opts = ReplayOpts::default();
    let err = replay_scene(path, 1, &opts).expect_err("missing file is typed");
    match err {
        ReplayError::ReadFailed { path, .. } => {
            assert!(path.contains("Seen.txt"));
        }
        other => panic!("expected ReadFailed, got {other:?}"),
    }
}

#[test]
fn replay_scene_truncated_envelope_returns_typed_parse_error() {
    // Too short for the directory.
    let bytes = vec![0u8; 16];
    let opts = ReplayOpts::default();
    let err = replay_scene_bytes(&bytes, 1, &opts).expect_err("truncated envelope rejected");
    assert!(matches!(err, ReplayError::SceneIndexParse { .. }));
}
