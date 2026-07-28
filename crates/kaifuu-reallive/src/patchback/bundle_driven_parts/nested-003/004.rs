/// Build one scene blob (`header || compressed-bytecode`) from
    /// decompressed plaintext bytecode.
    fn scene_blob_from_plaintext(plaintext: &[u8]) -> Vec<u8> {
        let compressed = compress_avg32_literal(plaintext).expect("compress scene");
        let mut header = vec![0u8; SCENE_HEADER_BYTE_LEN];
        header[0..4].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
        // Plaintext scene -> NON-`xor_2` compiler version (110001, not
        // 110002/1110002): an `xor_2` version would make patchback try to
        // recover a key from unencrypted bytes and abort. The real `xor_2`
        // round-trip is covered by the real-corpus tests.
        header[4..8].copy_from_slice(&110_001u32.to_le_bytes());
        header[0x20..0x24].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
        header[0x24..0x28].copy_from_slice(&(plaintext.len() as u32).to_le_bytes());
        header[0x28..0x2c].copy_from_slice(&(compressed.len() as u32).to_le_bytes());
        let mut blob = header;
        blob.extend_from_slice(&compressed);
        blob
    }

    /// Decompress a scene's bytecode out of an assembled archive.
    fn decompress_scene(archive: &[u8], scene_id: u16) -> Vec<u8> {
        let index = parse_archive(archive).expect("archive parses");
        let entry = index
            .entries
            .iter()
            .find(|e| e.scene_id == scene_id)
            .expect("scene present");
        let blob = &archive
            [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize];
        let header = SceneHeader::parse(blob).expect("header");
        let bc_start = header.bytecode_offset as usize;
        let bc_end = bc_start + header.bytecode_compressed_size as usize;
        decompress_avg32(
            &blob[bc_start..bc_end],
            header.bytecode_uncompressed_size as usize,
        )
        .expect("decompress")
    }

    /// Return a scene blob using the parsed archive directory's offset/length.
    fn scene_blob(archive: &[u8], scene_id: u16) -> &[u8] {
        let index = parse_archive(archive).expect("archive parses");
        let entry = index
            .entries
            .iter()
            .find(|e| e.scene_id == scene_id)
            .expect("scene present");
        &archive
            [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize]
    }

    #[test]
    fn deep_decompressed_offset_resolves_to_owning_scene_not_a_later_scene() {
        // BUG-2 regression: a unit whose decompressed range would land
        // inside a LATER scene's file extent must still resolve to its
        // own scene (by scene id), and patch only that scene.
        // Two identical scenes; scene 1 owns the edited unit but its
        // range startByte is deliberately set inside scene 2's file
        // range (simulating a deep decompressed offset under the old
        // file-offset-mixing bug).
        let plaintext = vec![0x83u8, 0x6E, 0x0A, 0x05, 0x00];
        let blob1 = scene_blob_from_plaintext(&plaintext);
        let blob2 = scene_blob_from_plaintext(&plaintext);
        let scene2_file_offset = REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN + blob1.len() as u64;
        let archive = assemble_archive(&[(1, blob1), (2, blob2)]);

        // Range startByte lands inside scene 2's file extent; under the
        // old containment logic this mis-resolved to scene 2.
        let bundle_json = make_bundle_json(scene2_file_offset, 0, 2, "Hi");
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
        let patched = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect("must resolve to owning scene 1 and apply");

        // Scene 1 was patched (now starts with SJIS "Hi"); scene 2 is
        // byte-identical to its original decompressed bytecode.
        let scene1 = decompress_scene(&patched, 1);
        let scene2 = decompress_scene(&patched, 2);
        let hi = encode_shift_jis_slot("Hi").expect("encode");
        assert!(
            scene1.starts_with(&hi),
            "scene 1 must carry the edit; got {scene1:02x?}"
        );
        assert_eq!(
            scene2, plaintext,
            "scene 2 must be untouched (the edit must not bleed into a later scene)"
        );
    }

    #[test]
    fn empty_choice_option_keeps_later_unit_splice_aligned_end_to_end() {
        // BUG-1 regression: a scene with an empty `,,` choice option plus
        // a trailing dialogue unit. The producer and the patchback
        // re-walk must agree on occurrence_index for every unit, so the
        // trailing unit splices correctly with NO ProvenanceMismatch.
        // Bytecode: Textout(ハ), select{ "A", <empty>, "B" }, Textout(ニ),
        // MetaLine. The empty middle option is dropped by `decode_select`.
        let mut plaintext: Vec<u8> = Vec::new();
        plaintext.extend_from_slice(&[0x83, 0x6E]); // occ 0 dialogue
        plaintext.extend_from_slice(&[0x23, 0x00, 0x02, 0x01, 0x00, 0x02, 0x00, 0x00]);
        plaintext.push(b'{');
        plaintext.extend_from_slice(b"A"); // occ 1 "A"
        plaintext.extend_from_slice(&[0x0a, 0x05, 0x00]);
        plaintext.extend_from_slice(&[0x0a, 0x06, 0x00]); // empty option -> dropped
        plaintext.extend_from_slice(b"B"); // occ 2 "B"
        plaintext.extend_from_slice(&[0x0a, 0x07, 0x00]);
        plaintext.push(b'}');
        plaintext.extend_from_slice(&[0x83, 0x70]); // occ 3 dialogue
        plaintext.extend_from_slice(&[0x0a, 0x05, 0x00]);

        let blob = scene_blob_from_plaintext(&plaintext);
        let archive = assemble_archive(&[(1, blob)]);

        let opts = crate::bridge::BridgeOpts {
            game_id: "synthetic",
            game_version: "test",
            source_profile_id: "synthetic-profile",
            source_locale: "ja-JP",
            extractor_name: "kaifuu-reallive-bridge",
            extractor_version: "0.1.0",
            scene_kidoku_count: 0,
        };
        let report = crate::gameexe::parse_gameexe_inventory(b"");
        let produced = crate::produce_bundle(1, &[0u8; 32], &plaintext, &report, &opts)
            .expect("bundle builds");

        // Four units, occurrences 0..3 with no gap (empty option emitted
        // none).
        assert_eq!(produced.bundle.units.len(), 4);

        // Translate each unit to a distinct 1-byte ASCII target.
        let targets = ["a", "b", "c", "d"];
        let mut translated_value = produced.json.clone();
        {
            let units = translated_value["units"].as_array_mut().expect("units");
            for (i, unit) in units.iter_mut().enumerate() {
                unit["target"] = serde_json::json!({"locale": "en-US", "text": targets[i]});
            }
        }
        let translated =
            TranslatedBundleV02::from_json(&translated_value).expect("translated parses");
        // scope=dialogue+choices: the two choice options are IN scope and get
        // re-emitted NextString-safe (`"b"` / `"c"`); the two dialogue units
        // take the plain Shift-JIS slot encoding (`a` / `d`).
        let patched = apply_translated_bundle(
            &archive,
            &translated,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueAndChoices),
        )
        .expect("apply must succeed (no occurrence drift)");

        // Correct-unit splice: every edit landed at its true position. The
        // choice options are quoted NextString runs (opening `"` 0x22,
        // body, closing `"` 0x22); the dialogue units are bare Shift-JIS.
        let expected: Vec<u8> = vec![
            0x61, // occ0 dialogue -> "a"
            0x23, 0x00, 0x02, 0x01, 0x00, 0x02, 0x00, 0x00, // select header
            0x7b, // '{'
            0x22, 0x62, 0x22, // occ1 "A" -> NextString-safe "b"
            0x0a, 0x05, 0x00, // \n + line
            0x0a, 0x06, 0x00, // empty option (untouched)
            0x22, 0x63, 0x22, // occ2 "B" -> NextString-safe "c"
            0x0a, 0x07, 0x00, // \n + line
            0x7d, // '}'
            0x64, // occ3 dialogue -> "d"
            0x0a, 0x05, 0x00, // MetaLine
        ];
        let actual = decompress_scene(&patched, 1);
        assert_eq!(
            actual, expected,
            "trailing dialogue unit must splice at its own position with no drift"
        );

        // The patched select command re-parses cleanly with both options
        // recovered as their NextString-safe forms — proving the choice
        // splice did not corrupt the `module_sel` framing.
        let ops = parse_real_bytecode(&actual).expect("patched bytecode must re-parse");
        let choice = ops
            .iter()
            .find_map(|op| match op {
                RealLiveOpcode::Choice { choices } => Some(choices),
                _ => None,
            })
            .expect("patched scene must still carry a Choice command");
        assert_eq!(choice.len(), 2, "both options must survive");
        assert_eq!(choice[0].bytes, b"\"b\"");
        assert_eq!(choice[1].bytes, b"\"c\"");
    }

    #[test]
    fn binary_catch_all_textout_survives_patchback_byte_identical_while_dialogue_is_translated() {
        use crate::test_fixtures::{SCENE1_BINARY_BLOCK_214B, SCENE2011_DIALOGUE_SJIS};
        const SENTINEL: &str = "[EN] sentinel dialogue line";

        // Scene bytecode: [real dialogue Textout][MetaLine]
        // [214-byte binary Textout][MetaLine]. The producer surfaces only
        // the dialogue unit; the binary run is excluded. A translate+
        // patchback run must (a) rewrite the dialogue to the en-US sentinel
        // and (b) leave the 214-byte binary block byte-identical — proving
        // the excluded data table is never overwritten.
        let mut plaintext: Vec<u8> = Vec::new();
        plaintext.extend_from_slice(SCENE2011_DIALOGUE_SJIS); // occ 0 dialogue
        plaintext.extend_from_slice(&[0x0a, 0x05, 0x00]); // MetaLine
        plaintext.extend_from_slice(SCENE1_BINARY_BLOCK_214B); // binary — excluded
        plaintext.extend_from_slice(&[0x0a, 0x06, 0x00]); // MetaLine

        let blob = scene_blob_from_plaintext(&plaintext);
        let archive = assemble_archive(&[(1, blob)]);

        let opts = crate::bridge::BridgeOpts {
            game_id: "synthetic",
            game_version: "test",
            source_profile_id: "synthetic-profile",
            source_locale: "ja-JP",
            extractor_name: "kaifuu-reallive-bridge",
            extractor_version: "0.1.0",
            scene_kidoku_count: 0,
        };
        let report = crate::gameexe::parse_gameexe_inventory(b"");
        let produced = crate::produce_bundle(1, &[0u8; 32], &plaintext, &report, &opts)
            .expect("bundle builds");

        // Only the dialogue run surfaced (binary excluded).
        assert_eq!(
            produced.bundle.units.len(),
            1,
            "only the dialogue run is surfaced; the binary catch-all run is excluded"
        );

        // Translate the single dialogue unit to an en-US sentinel.
        let mut translated_value = produced.json.clone();
        {
            let units = translated_value["units"].as_array_mut().expect("units");
            assert_eq!(units.len(), 1);
            units[0]["target"] = json!({"locale": "en-US", "text": SENTINEL});
        }
        let translated =
            TranslatedBundleV02::from_json(&translated_value).expect("translated parses");
        let patched = apply_translated_bundle(
            &archive,
            &translated,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect("apply must succeed");

        let new_decompressed = decompress_scene(&patched, 1);

        // (a) The 214-byte binary data block survives byte-identical.
        let binary_survives = new_decompressed
            .windows(SCENE1_BINARY_BLOCK_214B.len())
            .any(|window| window == SCENE1_BINARY_BLOCK_214B);
        assert!(
            binary_survives,
            "the excluded 214-byte binary data block must survive patchback byte-identical"
        );

        // (b) The dialogue run was rewritten to the sentinel bytes.
        let sentinel_sjis = encode_shift_jis_slot(SENTINEL).expect("sentinel encodes");
        let sentinel_present = new_decompressed
            .windows(sentinel_sjis.len())
            .any(|window| window == sentinel_sjis.as_slice());
        assert!(
            sentinel_present,
            "the translated dialogue must appear as the en-US sentinel bytes in the patched bytecode"
        );

        // (c) The original Japanese dialogue bytes are gone (replaced).
        let original_dialogue_present = new_decompressed
            .windows(SCENE2011_DIALOGUE_SJIS.len())
            .any(|window| window == SCENE2011_DIALOGUE_SJIS);
        assert!(
            !original_dialogue_present,
            "the original ja-JP dialogue bytes must no longer appear verbatim after patchback"
        );
    }

    #[test]
    fn schema_invalid_bundle_emits_typed_error_before_any_write() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        // Drop schemaVersion to force v0.2 validation failure.
        let mut bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0, // decompressed_byte_offset: Textout starts at decompressed offset 0
            2,
            "Hi",
        );
        bundle_json
            .as_object_mut()
            .expect("object")
            .remove("schemaVersion");
        let err = TranslatedBundleV02::from_json(&bundle_json)
            .expect_err("schema-invalid bundle must surface typed error");
        assert!(
            matches!(err, PatchbackError::BundleSchemaInvalid { .. }),
            "expected BundleSchemaInvalid, got {err:?}"
        );
        // Sanity: the archive is unchanged.
        let reparsed = parse_archive(&archive).expect("source still parses");
        assert_eq!(reparsed.entries.len(), 1);
    }

    #[test]
    fn missing_target_text_surfaces_typed_schema_invalid() {
        let mut bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0, // decompressed_byte_offset: Textout starts at decompressed offset 0
            2,
            "Hi",
        );
        bundle_json["units"][0]
            .as_object_mut()
            .expect("object")
            .remove("target");
        let err = TranslatedBundleV02::from_json(&bundle_json)
            .expect_err("missing target object must surface typed error");
        assert!(matches!(err, PatchbackError::BundleSchemaInvalid { .. }));
    }

    /// Build a synthetic single-scene archive whose bytecode is
    /// `Textout("ハ") · goto(@target) · MetaLine`, where the `goto` pointer
    /// targets the trailing MetaLine (an element boundary AFTER the edited
    /// dialogue). Returns `(archive, goto_target_offset, metaline_offset)`.
    fn build_archive_with_goto() -> (Vec<u8>, i32, usize) {
        let mut plaintext: Vec<u8> = Vec::new();
        // occ0 dialogue "ハ" at decompressed offset 0..2.
        plaintext.extend_from_slice(&[0x83, 0x6E]);
        // `goto` command (command_id 0x0001_0000): 0x23 opener, module_type=0,
        // module_id=1 (JMP), opcode=0, argc=0, overload=0, then one i32 target.
        // Header occupies offset 2..10; the i32 pointer occupies 10..14.
        plaintext.extend_from_slice(&[0x23, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
        let metaline_offset: usize = 14;
        plaintext.extend_from_slice(&(metaline_offset as i32).to_le_bytes());
        // The jump target: the MetaLine at offset 14.
        plaintext.extend_from_slice(&[0x0A, 0x05, 0x00]);
        assert_eq!(plaintext.len(), 17);

        let blob = scene_blob_from_plaintext(&plaintext);
        let archive = assemble_archive(&[(1, blob)]);
        (archive, metaline_offset as i32, metaline_offset)
    }

    /// A length-changing dialogue edit (both longer and shorter) re-bases the
    /// trailing `goto` pointer so it still targets the MetaLine at its NEW
    /// offset — never a stale offset that would land mid-command.
    #[test]
    fn length_changing_edit_recalculates_goto_target() {
        for target_text in ["HELLO WORLD FROM KAIFUU PATCHBACK", "A"] {
            let (archive, orig_target, _orig_metaline) = build_archive_with_goto();
            let new_body = encode_shift_jis_slot(target_text).expect("encode");
            let delta = new_body.len() as i64 - 2; // source "ハ" is 2 bytes.
            assert_ne!(delta, 0, "test needs a genuine length change");

            let bundle_json =
                make_bundle_json(REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, 0, 2, target_text);
            let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
            let patched = apply_translated_bundle(
                &archive,
                &bundle,
                &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
            )
            .expect("length-changing patch with a goto must succeed");

            let new_decompressed = decompress_scene(&patched, 1);

            // The goto pointer was re-based by the length delta.
            let sites = crate::opcode::collect_goto_pointer_sites(&new_decompressed)
                .expect("patched scene goto pointers collect");
            assert_eq!(sites.len(), 1, "the synthetic scene has exactly one goto");
            let expected_target = orig_target as i64 + delta;
            assert_eq!(
                sites[0].target as i64, expected_target,
                "goto target must be re-based by {delta} (source {orig_target} -> {expected_target})"
            );

            // The re-based target still lands on an element boundary — the
            // MetaLine that moved with the length change.
            let spans =
                parse_real_bytecode(&new_decompressed).expect("patched bytecode re-decodes");
            let mut cursor = 0usize;
            let mut lands_on_metaline = false;
            for op in &spans {
                if cursor == sites[0].target as usize {
                    assert!(
                        matches!(op, RealLiveOpcode::MetaLine { .. }),
                        "goto must still target the MetaLine, got {}",
                        op.label()
                    );
                    lands_on_metaline = true;
                }
                let (_o, w) = crate::opcode::decode_element(&new_decompressed, cursor)
                    .expect("element decodes");
                cursor += w;
            }
            assert!(
                lands_on_metaline,
                "re-based goto target {} must land on an element boundary",
                sites[0].target
            );
        }
    }

    #[test]
    fn length_changing_edit_succeeds_and_grows_archive() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        // Replace the 2-byte "ハ" with a 30-character ASCII string —
        // length-changing edit.
        let target = "[EN] hello world from kaifuu";
        let bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0, // decompressed_byte_offset: Textout starts at decompressed offset 0
            2,
            target,
        );
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
        let patched = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect("apply succeeds despite length growth");
        let reparsed = parse_archive(&patched).expect("patched archive re-parses");
        assert_eq!(reparsed.entries.len(), 1);
        let new_entry = &reparsed.entries[0];
        assert!(
            new_entry.byte_len > 0,
            "patched scene must have non-zero length"
        );
        // Decompress & confirm the new bytecode starts with the SJIS-
        // encoded target.
        let blob_start = new_entry.byte_offset as usize;
        let blob_end = blob_start + new_entry.byte_len as usize;
        let header = SceneHeader::parse(&patched[blob_start..blob_end]).expect("header");
        let bytecode_start = blob_start + header.bytecode_offset as usize;
        let bytecode_end = bytecode_start + header.bytecode_compressed_size as usize;
        let new_decompressed = decompress_avg32(
            &patched[bytecode_start..bytecode_end],
            header.bytecode_uncompressed_size as usize,
        )
        .expect("re-decompress");
        let target_sjis = encode_shift_jis_slot(target).expect("encode target");
        assert!(
            new_decompressed.starts_with(&target_sjis),
            "patched bytecode must start with the new SJIS-encoded target bytes"
        );
    }

