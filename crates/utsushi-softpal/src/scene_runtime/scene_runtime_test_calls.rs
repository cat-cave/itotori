    #[test]
    fn evaluates_a_condition_and_takes_only_its_target_branch() {
        let (textdat, pointer) = textdat();
        // Labels reverse to offsets 12, 44, and 80. `jz label 2, local 1` is
        // not taken; `jmp label 3` bypasses the message at label 2. Returning a
        // constant zero from the evaluator makes this test emit that message.
        let tokens = [
            op(1),
            word(0x4000_0001),
            word(1),
            op(0x0a),
            word(2),
            word(0x4000_0001),
            op(9),
            word(3),
            op(0x1f),
            word(pointer),
            op(0x1f),
            word(0x0fff_ffff),
            op(0x1f),
            word(0),
            op(0x17),
            word(0x0002_0002),
            word(0),
            op(0x15),
        ];
        let mut points = Vec::from(&b"_POINT_LIST_****"[..]);
        for offset in [68_u32, 32, 0] {
            points.extend_from_slice(&offset.to_le_bytes());
        }
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("executes");
        assert_eq!(scene.stats.branch_count, 2);
        assert_eq!(scene.stats.dialogue_count, 0, "taken jump bypasses message");
        assert!(
            scene.diagnostics.is_empty(),
            "fully determined synthetic path"
        );
    }

    #[test]
    fn executes_a_reachable_message_syscall_through_the_text_path() {
        let (textdat, pointer) = textdat();
        // The reference's message syscall is the same push-then-0x17 shape
        // that ScriptScan resolves: text, absent speaker, message value, then
        // native target 0x0002:0x0002.
        let scene = SoftpalScene::execute(
            &program(&[
                op(0x1f),
                word(pointer),
                op(0x1f),
                word(0x0fff_ffff),
                op(0x1f),
                word(0),
                op(0x17),
                word(0x0002_0002),
                word(0),
                op(0x15),
            ]),
            &textdat,
        )
        .expect("message syscall is a valid scene");

        assert_eq!(scene.stats.dialogue_count, 1);
        assert_eq!(scene.stats.call_count, 1);
        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.steps,
            vec![SceneStep::Dialogue {
                command_offset: 12,
                speaker: None,
                text: "line".to_string(),
            }]
        );
    }

    #[test]
    fn executes_only_a_point_table_designated_message_entry() {
        // The root ends before the message. Point id 1 is the sole permitted
        // alternative entry, encoded in POINT.DAT as a header-relative offset;
        // replacing the entry resolver with a raw/default IP makes this fail.
        let (textdat, pointer) = textdat();
        let script = program(&[
            op(0x15),
            op(0x1f),
            word(pointer),
            op(0x1f),
            word(0x0fff_ffff),
            op(0x1f),
            word(0),
            op(0x17),
            word(0x0002_0002),
            word(0),
            op(0x15),
        ]);
        let mut points = Vec::from(&b"_POINT_LIST_****"[..]);
        points.extend_from_slice(&4_u32.to_le_bytes());

        let scene = SoftpalScene::execute_from_point_with_points(&script, &textdat, &points, 1)
            .expect("point-table entry executes");
        assert_eq!(scene.stats.instructions_executed, 5);
        assert_eq!(scene.stats.dialogue_count, 1);
        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.steps,
            vec![SceneStep::Dialogue {
                command_offset: 16,
                speaker: None,
                text: "line".to_string(),
            }]
        );
        assert!(matches!(
            SoftpalScene::execute_from_point_with_points(&script, &textdat, &points, 2),
            Err(SoftpalRuntimeError::PointEntryOutOfRange {
                point_id: 2,
                point_count: 1,
            })
        ));
    }

    #[test]
    fn debug_window_state_returns_the_previous_value_and_controls_flow() {
        let (textdat, pointer) = textdat();
        // Two state swaps should return 0 then 3. `not(local2)` is zero only
        // when the second call returned the state installed by the first; the
        // jump then bypasses the message. A gutted state exchange emits it.
        let tokens = [
            op(0x1f),
            word(3),
            op(0x17),
            word(0x000f_0005),
            word(0x4000_0001),
            op(0x1f),
            word(9),
            op(0x17),
            word(0x000f_0005),
            word(0x4000_0002),
            op(0x14),
            word(0x4000_0002),
            op(0x0a),
            word(1),
            word(0x4000_0002),
            op(0x1f),
            word(pointer),
            op(0x1f),
            word(0x0fff_ffff),
            op(0x1f),
            word(0),
            op(0x17),
            word(0x0002_0002),
            word(0),
            op(0x15),
        ];
        let mut points = Vec::from(&b"_POINT_LIST_****"[..]);
        points.extend_from_slice(&96_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("stateful debug calls execute");
        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.stats.dialogue_count, 0,
            "state return bypasses message"
        );
        assert_eq!(
            scene.stats.branch_count, 2,
            "conditional plus its taken jump"
        );
    }

    #[test]
    fn bgv_volume_round_trip_controls_execution() {
        let (textdat, pointer) = textdat();
        // The setter must consume and retain 73; the query must return that
        // retained value. Deleting either implementation makes the equality
        // false and reaches the decoded message at point 1.
        let tokens = [
            op(0x1f),
            word(73),
            op(0x17),
            word(0x000d_0015),
            word(0x4000_0001),
            op(0x17),
            word(0x000d_0016),
            word(0x4000_0002),
            op(0x0c),
            word(0x4000_0002),
            word(73),
            op(0x0a),
            word(1),
            word(0x4000_0002),
            op(0x15),
            op(0x1f),
            word(pointer),
            op(0x1f),
            word(0x0fff_ffff),
            op(0x1f),
            word(0),
            op(0x17),
            word(0x0002_0002),
            word(0),
            op(0x15),
        ];
        let mut points = Vec::from(&b"_POINT_LIST_****"[..]);
        points.extend_from_slice(&60_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("BGV-volume calls execute");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.stats.dialogue_count, 0,
            "stored volume bypasses message"
        );
        assert_eq!(scene.stats.branch_count, 1);
    }

    #[test]
    fn set_last_process_consumes_its_point_before_the_next_native_call() {
        let (textdat, pointer) = textdat();
        // 0023's cache has no compact scheduler consumer yet, so this checks
        // its observable stack contract: it must remove point 9 before the
        // following BGV setter consumes 73. Leaving 9 on the stack makes the
        // BGV query fail the comparison and emits the decoded message.
        let tokens = [
            op(0x1f),
            word(73),
            op(0x1f),
            word(9),
            op(0x17),
            word(0x0012_0023),
            word(0x4000_0001),
            op(0x17),
            word(0x000d_0015),
            word(0x4000_0002),
            op(0x17),
            word(0x000d_0016),
            word(0x4000_0003),
            op(0x0c),
            word(0x4000_0003),
            word(73),
            op(0x0a),
            word(1),
            word(0x4000_0003),
            op(0x15),
            op(0x1f),
            word(pointer),
            op(0x1f),
            word(0x0fff_ffff),
            op(0x1f),
            word(0),
            op(0x17),
            word(0x0002_0002),
            word(0),
            op(0x15),
        ];
        let mut points = Vec::from(&b"_POINT_LIST_****"[..]);
        points.extend_from_slice(&80_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("set-last-process call executes");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(scene.stats.dialogue_count, 0, "point id was consumed");
        assert_eq!(scene.stats.branch_count, 1);
    }

