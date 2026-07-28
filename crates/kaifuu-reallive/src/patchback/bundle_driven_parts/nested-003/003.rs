
    use super::*;
    use crate::compressor::compress_avg32_literal;
    use crate::encoding::encode_shift_jis_slot;
    use crate::scope::TranslationScope;
    use serde_json::json;

    /// Build the smallest viable synthetic Seen.txt with one scene
    /// whose decompressed bytecode starts with one Shift-JIS Textout
    /// run (`ハ` = `0x83 0x6E`) followed by a MetaLine terminator.
    fn build_synthetic_archive() -> SyntheticArchive {
        // Decompressed bytecode: SJIS for "ハ" (0x83 0x6E), then a
        // MetaLine to terminate the textout run.
        let plaintext = vec![0x83u8, 0x6E, 0x0A, 0x05, 0x00];
        let compressed = compress_avg32_literal(&plaintext).expect("compress synthetic");

        // Synthesize a scene header pointing at the compressed payload
        // immediately after the 0x1d0-byte header.
        let mut header = vec![0u8; SCENE_HEADER_BYTE_LEN];
        header[0..4].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
        // Plaintext synthetic scene -> NON-`xor_2` compiler version (110001,
        // not 110002/1110002): an `xor_2` version makes patchback try to
        // recover a key from unencrypted bytes and abort. Real `xor_2` is
        // covered by the real-corpus tests.
        header[4..8].copy_from_slice(&110_001u32.to_le_bytes()); // compiler version (non-xor_2)
        // bytecode_offset at 0x20.
        header[0x20..0x24].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
        // bytecode_uncompressed_size at 0x24.
        header[0x24..0x28].copy_from_slice(&(plaintext.len() as u32).to_le_bytes());
        // bytecode_compressed_size at 0x28.
        header[0x28..0x2c].copy_from_slice(&(compressed.len() as u32).to_le_bytes());

        let mut scene_blob = Vec::with_capacity(header.len() + compressed.len());
        scene_blob.extend_from_slice(&header);
        scene_blob.extend_from_slice(&compressed);

        // Build the 80,000-byte directory with scene 1 sitting at file
        // offset 0x13880.
        let scene_offset = REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN;
        let mut archive =
            vec![0u8; REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize + scene_blob.len()];
        // Scene 1's slot is at directory byte offset 1 * 8 == 8.
        let slot_byte_start = 8;
        archive[slot_byte_start..slot_byte_start + 4]
            .copy_from_slice(&(scene_offset as u32).to_le_bytes());
        archive[slot_byte_start + 4..slot_byte_start + 8]
            .copy_from_slice(&(scene_blob.len() as u32).to_le_bytes());
        archive[REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize..].copy_from_slice(&scene_blob);

        // Decompressed-byte-offset of the Textout run inside the
        // decompressed bytecode: position 0 (starts immediately).
        let _ = scene_offset;
        SyntheticArchive { archive }
    }

    struct SyntheticArchive {
        archive: Vec<u8>,
    }

    #[test]
    fn strip_out_of_band_control_markup_removes_kidoku_keeps_name_and_prose() {
        // Inline (single) kidoku marker + in-body name token + prose.
        assert_eq!(
            strip_out_of_band_control_markup("<reallive.kidoku 1>【和人】「hello」"),
            "【和人】「hello」"
        );
        // Synthesised table-form marker.
        assert_eq!(
            strip_out_of_band_control_markup("<reallive.kidoku table:1>narration"),
            "narration"
        );
        // Multiple markers (Kanon double-kidoku) anywhere in the string.
        assert_eq!(
            strip_out_of_band_control_markup("<reallive.kidoku 26><reallive.kidoku 27>「x」"),
            "「x」"
        );
        // No marker: verbatim.
        assert_eq!(strip_out_of_band_control_markup("「plain」"), "「plain」");
        // Unterminated marker: keep the remainder, never silently truncate.
        assert_eq!(
            strip_out_of_band_control_markup("<reallive.kidoku 1"),
            "<reallive.kidoku 1"
        );
    }

    #[test]
    fn patch_scene_blob_rejects_bytecode_offset_inside_header_region() {
        // 006 regression: patch_scene_blob guarded only the upper bound
        // (bytecode_end > blob.len); a header declaring bytecode_offset
        // < SCENE_HEADER_BYTE_LEN slipped through and re-emitted a corrupt
        // scene (compressed payload at 0x1d0 while the preserved offset
        // points inside the header). It must now surface a typed
        // SceneHeaderInvalid before any mutation.
        let mut blob = vec![0u8; SCENE_HEADER_BYTE_LEN + 16];
        // bytecode_offset (0x20) = 0x20, well inside the 0x1d0 header.
        blob[0x20..0x24].copy_from_slice(&0x20u32.to_le_bytes());
        // compressed_size (0x28) small enough that bytecode_end is in
        // bounds — proving the NEW lower-bound guard is what fires.
        blob[0x28..0x2c].copy_from_slice(&4u32.to_le_bytes());

        let err = patch_scene_blob(42, &blob, &[], None)
            .expect_err("bytecode_offset inside the header must be rejected");
        assert!(
            matches!(err, PatchbackError::SceneHeaderInvalid { scene_id: 42, .. }),
            "expected SceneHeaderInvalid, got {err:?}"
        );
    }

    fn make_bundle_json(
        scene_blob_file_offset: u64,
        decompressed_byte_offset: u64,
        decompressed_byte_len: u64,
        target_text: &str,
    ) -> Value {
        let bridge_id = "01970000-0000-7000-8000-000000000001";
        let revision_id = "01970000-0000-7000-8000-000000000002";
        let asset_id = "01970000-0000-7000-8000-000000000003";
        let bridge_unit_id = "01970000-0000-7000-8000-000000000004";
        let surface_id = "01970000-0000-7000-8000-000000000005";
        let span_id_unused = "01970000-0000-7000-8000-000000000006";
        let _ = span_id_unused;
        let source_profile_revision_id = "01970000-0000-7000-8000-000000000007";

        let scene_blob_hash =
            kaifuu_core::sha256_hash_bytes(b"synthetic-scene-1-placeholder-content");
        let source_hash = kaifuu_core::sha256_hash_bytes("Synthetic source text".as_bytes());
        let source_profile_hash = kaifuu_core::sha256_hash_bytes(b"kaifuu-reallive-observed");

        let start_byte = scene_blob_file_offset + decompressed_byte_offset;
        let end_byte = start_byte + decompressed_byte_len;

        json!({
            "schemaVersion": "0.2.0",
            "bridgeId": bridge_id,
            "sourceGame": {
                "gameId": "observed-reallive",
                "gameVersion": "1.0.0",
                "sourceProfileId": "kaifuu-reallive-observed",
                "sourceProfileRevision": {
                    "revisionId": source_profile_revision_id,
                    "revisionKind": "content_hash",
                    "value": source_profile_hash,
                },
            },
            "sourceBundleHash": scene_blob_hash,
            "sourceBundleRevision": {
                "revisionId": revision_id,
                "revisionKind": "content_hash",
                "value": scene_blob_hash,
            },
            "sourceLocale": "ja-JP",
            "hashStrategy": {
                "sourceProfile": {
                    "scope": "source_profile",
                    "algorithm": "sha256",
                    "normalization": "utf8-lf-json-stable-v1",
                },
                "sourceBundle": {
                    "scope": "source_bundle",
                    "algorithm": "sha256",
                    "normalization": "utf8-lf-json-stable-v1",
                },
                "sourceAsset": {
                    "scope": "source_asset",
                    "algorithm": "sha256",
                    "normalization": "bytes",
                },
                "sourceUnit": {
                    "scope": "source_unit",
                    "algorithm": "sha256",
                    "normalization": "utf8-lf-json-stable-v1",
                    "fields": ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
                },
                "patchExport": {
                    "scope": "patch_export",
                    "algorithm": "sha256",
                    "normalization": "utf8-lf-json-stable-v1",
                },
                "deltaPackage": {
                    "scope": "delta_package",
                    "algorithm": "sha256",
                    "normalization": "utf8-lf-json-stable-v1",
                },
            },
            "extractor": {
                "name": "kaifuu-reallive-bridge",
                "version": "0.1.0",
            },
            "assets": [
                {
                    "assetId": asset_id,
                    "assetKey": "reallive:scene-0001",
                    "assetKind": "script",
                    "sourceHash": scene_blob_hash,
                    "sourceRevision": {
                        "revisionId": revision_id,
                        "revisionKind": "content_hash",
                        "value": scene_blob_hash,
                    },
                    "path": "REALLIVEDATA/Seen.txt#scene-0001",
                }
            ],
            "units": [
                {
                    "bridgeUnitId": bridge_unit_id,
                    "surfaceId": surface_id,
                    "surfaceKind": "dialogue",
                    "sourceUnitKey": "reallive:scene-0001#0000",
                    "occurrenceId": "scene-0001-occ-0000",
                    "sourceLocale": "ja-JP",
                    "sourceText": "Synthetic source text",
                    "sourceHash": source_hash,
                    "sourceRevision": {
                        "revisionId": revision_id,
                        "revisionKind": "content_hash",
                        "value": scene_blob_hash,
                    },
                    "sourceAssetRef": {
                        "assetId": asset_id,
                        "assetKey": "reallive:scene-0001",
                    },
                    "sourceLocation": {
                        "containerKey": "reallive:scene-0001",
                        "entryPath": ["scene", "0001", "units", "0000"],
                        "range": {
                            "startByte": start_byte,
                            "endByte": end_byte,
                        },
                    },
                    "speaker": {"knowledgeState": "not_applicable"},
                    "context": {
                        "route": {
                            "sceneKey": "scene-0001",
                            "position": "line-0000",
                        },
                    },
                    "spans": [],
                    "patchRef": {
                        "assetId": asset_id,
                        "writeMode": "replace",
                        "sourceUnitKey": "reallive:scene-0001#0000",
                        "sourceRevision": {
                            "revisionId": revision_id,
                            "revisionKind": "content_hash",
                            "value": scene_blob_hash,
                        },
                    },
                    "runtimeExpectation": {
                        "expectationKind": "trace_text",
                        "traceKey": "scene-0001-occ-0000",
                    },
                    "target": {
                        "locale": "en-US",
                        "text": target_text,
                    }
                }
            ],
            "policyRecords": [],
        })
    }

    #[test]
    fn empty_bundle_is_identity_round_trip_through_archive_self_check() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        // A bundle with zero target units is a programming error
        // (validate_json requires `units` to match the source side),
        // but a 1-unit bundle with target_text identical to the source
        // body should still re-emit a parseable archive.
        let bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0, // decompressed_byte_offset: Textout starts at decompressed offset 0
            2,
            "Hi", // 2-byte ASCII fits the source 2-byte SJIS body
        );
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
        let patched = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect("apply succeeds");
        // Re-parse must yield a directory with the same number of
        // populated entries.
        let reparsed = parse_archive(&patched).expect("patched archive re-parses");
        assert_eq!(reparsed.entries.len(), 1);
    }

    #[test]
    fn source_identical_target_is_a_noop_scene_stays_byte_identical() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        let source_blob = scene_blob(&archive, 1).to_vec();
        let bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0,
            2,
            "Synthetic source text",
        );
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");

        let patched = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect("source-identical target must be a no-op");

        assert_eq!(
            scene_blob(&patched, 1),
            source_blob.as_slice(),
            "a source-identical target must carry the original scene blob verbatim"
        );
    }

    #[test]
    fn changed_target_still_re_emits_scene() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        let source_blob = scene_blob(&archive, 1).to_vec();
        let bundle_json = make_bundle_json(REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, 0, 2, "Hi");
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");

        let patched = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect("changed target must re-emit the scene");

        assert_ne!(
            scene_blob(&patched, 1),
            source_blob.as_slice(),
            "a changed target must cause its owning scene to be re-emitted"
        );
    }

    #[test]
    fn target_differing_only_in_kidoku_marker_is_noop() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        let source_blob = scene_blob(&archive, 1).to_vec();
        let bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0,
            2,
            "<reallive.kidoku 1>Synthetic source text",
        );
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");

        let patched = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect("marker-only difference must be a no-op");

        assert_eq!(
            scene_blob(&patched, 1),
            source_blob.as_slice(),
            "a target differing only by an out-of-band marker must carry the original scene blob verbatim"
        );
    }

    #[test]
    fn apply_strips_out_of_band_kidoku_marker_and_splices_only_the_body() {
        // A target carrying the producer's synthetic `<reallive.kidoku N>`
        // marker (as the translation prompt reproduces it inline) must have
        // that marker STRIPPED before the splice: the literal ASCII bytes of
        // `<reallive.kidoku` must never reach the patched bytecode, and the
        // real body ("Hi") must be spliced.
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        let bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0,
            2,
            "<reallive.kidoku 1>Hi",
        );
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
        let patched = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect("apply succeeds after stripping the out-of-band marker");
        let decompressed = decompress_scene(&patched, 1);
        let marker_bytes = REALLIVE_OUT_OF_BAND_MARKER_OPEN.as_bytes();
        assert!(
            !decompressed
                .windows(marker_bytes.len())
                .any(|w| w == marker_bytes),
            "the `<reallive.kidoku ` literal must NOT appear in the patched bytecode"
        );
        let hi = encode_shift_jis_slot("Hi").expect("encode Hi");
        assert!(
            decompressed.windows(hi.len()).any(|w| w == hi.as_slice()),
            "the translated body 'Hi' must be spliced into the patched bytecode"
        );
    }

    #[test]
    fn apply_rejects_target_that_is_only_out_of_band_control_markup() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        let bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0,
            2,
            "<reallive.kidoku 1>",
        );
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
        let err = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect_err("a control-markup-only target must be rejected");
        assert!(
            matches!(err, PatchbackError::ControlMarkupOnlyTarget { .. }),
            "expected ControlMarkupOnlyTarget, got {err:?}"
        );
    }

    #[test]
    fn unit_naming_a_scene_absent_from_the_archive_emits_typed_mismatch_error() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        // Scene attribution is by scene id (from sourceUnitKey), not by
        // byte containment. Name a scene the archive does not contain.
        let mut bundle_json = make_bundle_json(REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, 0, 2, "Hi");
        bundle_json["units"][0]["sourceUnitKey"] = serde_json::json!("reallive:scene-9999#0000");
        bundle_json["units"][0]["patchRef"]["sourceUnitKey"] =
            serde_json::json!("reallive:scene-9999#0000");
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
        let err = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect_err("must reject a unit naming an absent scene");
        assert!(
            matches!(err, PatchbackError::ProvenanceMismatch { .. }),
            "expected ProvenanceMismatch, got {err:?}"
        );
    }

    /// Assemble a Seen.txt archive from `(scene_id, scene_blob)` pairs,
    /// laid out sequentially after the 80,000-byte directory.
    fn assemble_archive(scenes: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut directory = vec![0u8; REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize];
        let mut payload: Vec<u8> = Vec::new();
        let mut cursor = REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN;
        for (scene_id, blob) in scenes {
            let slot = *scene_id as usize * 8;
            directory[slot..slot + 4].copy_from_slice(&(cursor as u32).to_le_bytes());
            directory[slot + 4..slot + 8].copy_from_slice(&(blob.len() as u32).to_le_bytes());
            payload.extend_from_slice(blob);
            cursor += blob.len() as u64;
        }
        let mut archive = directory;
        archive.extend_from_slice(&payload);
        archive
    }

    
