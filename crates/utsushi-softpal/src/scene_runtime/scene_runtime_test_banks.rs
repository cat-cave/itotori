    #[test]
    fn scene_skip_cancel_returns_success_and_bypasses_failure_path() {
        let (textdat, pointer) = textdat();
        // Category 9/index 52 consumes no arguments and returns success. If
        // its implementation is removed or reduced to a pass-through, local 1
        // remains zero and the conditional reaches the message at point 1.
        let tokens = [
            op(0x17),
            word(0x0009_0034),
            word(0x4000_0001),
            op(0x0a),
            word(1),
            word(0x4000_0001),
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
        points.extend_from_slice(&28_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("scene-skip cancellation executes");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.stats.dialogue_count, 0,
            "success bypasses failure message"
        );
        assert_eq!(scene.stats.branch_count, 1);
    }

    #[test]
    fn auto_set_consumes_its_flag_and_returns_success() {
        let (textdat, pointer) = textdat();
        // The setter must consume its input and write success. A gutted
        // implementation either stops at the named call or leaves local 1 at
        // zero, which takes point 1 and emits this message.
        let tokens = [
            op(0x1f),
            word(1),
            op(0x17),
            word(0x0009_0002),
            word(0x4000_0001),
            op(0x0a),
            word(1),
            word(0x4000_0001),
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
        points.extend_from_slice(&36_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("auto setter executes");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.stats.dialogue_count, 0,
            "success bypasses failure message"
        );
        assert_eq!(scene.stats.branch_count, 1);
    }

    #[test]
    fn user_memory_read_and_write_control_execution_at_the_proven_bank_boundary() {
        let (textdat, pointer) = textdat();
        // Set vars[1] = 0xffff, write 7 through tag 1, and read it back into
        // local 2. The equality controls a branch that bypasses the message.
        // Removing either tag-1 access makes local 2 zero and emits the line.
        let tokens = [
            op(1),
            word(0x4000_0001),
            word(0xffff),
            op(1),
            word(0x1000_0001),
            word(7),
            op(1),
            word(0x4000_0002),
            word(0x1000_0001),
            op(0x0c),
            word(0x4000_0002),
            word(7),
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
        points.extend_from_slice(&64_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("user-memory path executes");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.stats.dialogue_count, 0,
            "bank round-trip bypasses message"
        );
        assert_eq!(scene.stats.branch_count, 1);
    }

    #[test]
    fn user_memory_stops_visibly_when_the_indirect_index_is_out_of_range() {
        let (textdat, _) = textdat();
        let scene = SoftpalScene::execute(
            &program(&[
                op(1),
                word(0x4000_0001),
                word(0x1_0000),
                op(1),
                word(0x4000_0002),
                word(0x1000_0001),
                op(0x15),
            ]),
            &textdat,
        )
        .expect("out-of-range operand remains decodable");

        assert_eq!(
            scene.diagnostics,
            vec![RuntimeDiagnostic {
                signature: "user_mem_index_out_of_range".to_string(),
                offset: 24,
            }]
        );
        assert_eq!(scene.stats.instructions_executed, 2);
    }

    #[test]
    fn user_memory_write_stops_visibly_when_the_indirect_index_is_out_of_range() {
        let (textdat, _) = textdat();
        let scene = SoftpalScene::execute(
            &program(&[
                op(1),
                word(0x4000_0001),
                word(0x1_0000),
                op(0x1f),
                word(7),
                op(0x1e),
                word(0x1000_0001),
                op(0x15),
            ]),
            &textdat,
        )
        .expect("out-of-range destination remains decodable");

        assert_eq!(
            scene.diagnostics,
            vec![RuntimeDiagnostic {
                signature: "user_mem_index_out_of_range".to_string(),
                offset: 32,
            }]
        );
        assert_eq!(scene.stats.instructions_executed, 3);
    }

    #[test]
    fn system_task_value_returns_the_active_latch_value_to_control_execution() {
        let (textdat, pointer) = textdat();
        // The zero-argument call returns one. If its modeled result is gutted,
        // the conditional reaches the message instead of bypassing it.
        let tokens = [
            op(0x17),
            word(0x0012_000f),
            word(0x4000_0001),
            op(0x0a),
            word(1),
            word(0x4000_0001),
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
        points.extend_from_slice(&28_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points(&program(&tokens), &textdat, Some(&points))
            .expect("system task value executes");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.stats.dialogue_count, 0,
            "success bypasses failure message"
        );
        assert_eq!(scene.stats.branch_count, 1);
    }

    #[test]
    fn string_alloc_consumes_its_argument_and_returns_a_nonzero_dynamic_handle() {
        let (textdat, pointer) = textdat();
        // A real allocation returns a nonzero handle. If it is gutted, reduced
        // to zero, or does not consume the source stack value, the conditional
        // reaches the message or a later call observes a corrupted stack.
        let tokens = [
            op(0x1f),
            word(99),
            op(0x17),
            word(0x0012_0006),
            word(0x4000_0001),
            op(0x14),
            word(0x4000_0001),
            op(0x0a),
            word(1),
            word(0x4000_0001),
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
            .expect("string allocation executes");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(
            scene.stats.dialogue_count, 0,
            "handle bypasses failure message"
        );
        assert_eq!(scene.stats.branch_count, 2);
    }

    #[test]
    fn openfile_reads_the_pac_payload_named_by_its_filedat_slot() {
        let (textdat, pointer) = textdat();
        let filedat = filedat(&["FONT.DAT"]);
        let archive = pac(&[("FILE.DAT", filedat.as_slice()), ("FONT.DAT", &[7, 8, 9])]);
        // The open result becomes the read handle. The first byte read through
        // that handle must equal the PAC payload's 7; otherwise the branch
        // reaches the message. Deleting open/read or replacing the table with
        // a fixed success return therefore fails this behavior test.
        let tokens = [
            op(0x1f),
            word(0),
            op(0x17),
            word(0x0012_001e),
            word(0x4000_0001),
            op(0x1f),
            word(3),
            op(0x1f),
            word(12),
            op(0x1f),
            word(0x4000_0001),
            op(0x17),
            word(0x0012_001f),
            word(0x4000_0002),
            op(1),
            word(0x4000_0003),
            word(12),
            op(1),
            word(0x4000_0004),
            word(0x5000_0003),
            op(0x0c),
            word(0x4000_0004),
            word(7),
            op(0x14),
            word(0x4000_0004),
            op(0x0a),
            word(1),
            word(0x4000_0004),
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
        points.extend_from_slice(&148_u32.to_le_bytes());
        let scene = SoftpalScene::execute_with_points_mem_dat_and_pac(
            &program(&tokens),
            &textdat,
            Some(&points),
            None,
            &archive,
        )
        .expect("PAC-backed file path executes");

        assert!(scene.diagnostics.is_empty());
        assert_eq!(scene.stats.dialogue_count, 0, "PAC byte bypasses message");
        assert_eq!(scene.stats.branch_count, 2);
    }

    #[test]
    fn openfile_stops_visibly_when_the_resolved_pac_entry_is_absent() {
        let (textdat, _) = textdat();
        let filedat = filedat(&["MISSING.DAT"]);
        let archive = pac(&[("FILE.DAT", filedat.as_slice())]);
        let scene = SoftpalScene::execute_with_points_mem_dat_and_pac(
            &program(&[
                op(0x1f),
                word(0),
                op(0x17),
                word(0x0012_001e),
                word(0),
                op(0x15),
            ]),
            &textdat,
            None,
            None,
            &archive,
        )
        .expect("well-formed input retains a named runtime failure");

        assert_eq!(
            scene.diagnostics,
            vec![RuntimeDiagnostic {
                signature: "openfile_pac_entry_missing".to_string(),
                offset: 20,
            }]
        );
    }
