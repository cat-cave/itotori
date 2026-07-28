#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preamble_round_trips_byte_identically() {
        let preamble = AvgSavePreamble {
            leading_u32: 24_876,
            compiler_version: AVG_DERIVED_COMPILER_VERSION,
            timestamp: [0x07E9, 0x0003, 0x0002, 0x000B, 0x0012, 0x0027],
            padding_a: 0,
            tail: 0x02DC,
        };
        let bytes = preamble.encode();
        // Verify against the documented AVG32 prefix.
        assert_eq!(&bytes[0x00..0x04], &[0x2C, 0x61, 0x00, 0x00]);
        assert_eq!(&bytes[0x04..0x08], &[0x12, 0x27, 0x00, 0x00]);
        assert_eq!(
            &bytes[0x08..0x14],
            &[
                0xE9, 0x07, 0x03, 0x00, 0x02, 0x00, 0x0B, 0x00, 0x12, 0x00, 0x27, 0x00
            ]
        );
        assert_eq!(&bytes[0x14..0x16], &[0x00, 0x00]);
        assert_eq!(&bytes[0x16..0x18], &[0xDC, 0x02]);
        let parsed = AvgSavePreamble::decode(&bytes).expect("decode");
        assert_eq!(parsed, preamble);
    }

    #[test]
    fn preamble_decode_rejects_truncated_input() {
        let err = AvgSavePreamble::decode(&[0u8; 0x10]).expect_err("too short");
        assert!(matches!(
            err,
            SaveDecodeError::PreambleTruncated {
                have: 0x10,
                need: 0x18
            }
        ));
        assert_eq!(err.semantic_code(), codes::PREAMBLE_TRUNCATED);
    }

    #[test]
    fn system_save_round_trips_synthetic_bytes_byte_identically() {
        let synthetic = SaveRoundTrip::synthetic_system_save(24_876);
        let decoded = SystemSave::decode(&synthetic).expect("decode");
        assert_eq!(decoded.preamble.leading_u32, 24_876);
        let re_encoded = decoded.encode();
        assert_eq!(re_encoded, synthetic, "round-trip must be byte-identical");
        assert_eq!(re_encoded.len(), 24_876);
    }

    #[test]
    fn system_save_decode_rejects_file_size_mismatch() {
        let synthetic = SaveRoundTrip::synthetic_system_save(1024);
        // Truncate by one byte — the declared file size no longer matches.
        let truncated = &synthetic[..1023];
        let err = SystemSave::decode(truncated).expect_err("truncated");
        assert!(matches!(
            err,
            SaveDecodeError::PreambleFileSizeMismatch {
                declared: 1024,
                actual: 1023
            }
        ));
        assert_eq!(err.semantic_code(), codes::PREAMBLE_FILE_SIZE_MISMATCH);
    }

    #[test]
    fn system_save_decode_rejects_wrong_magic() {
        // A `save999.sav` byte stream with the global-save magic must
        // NOT decode as a `SystemSave`.
        let global = SaveRoundTrip::synthetic_global_save(64);
        let err = SystemSave::decode(&global).expect_err("magic mismatch");
        // The synthetic global save has leading_u32 = 0xA4 = 164 != actual length
        // so file-size cross-check fires first. That is the system-save's
        // dedicated guard, so synthesise a same-size-but-wrong-magic stream
        // to reach the magic-mismatch branch.
        assert!(matches!(
            err,
            SaveDecodeError::PreambleFileSizeMismatch { .. }
                | SaveDecodeError::MagicMismatch { .. }
        ));
    }

    #[test]
    fn system_save_decode_rejects_wrong_magic_with_matching_file_size() {
        // Construct a byte stream with the global-save magic but a
        // leading u32 that matches the actual length, so the file-size
        // cross-check passes and the magic check fires.
        let mut bytes = SaveRoundTrip::synthetic_global_save(64);
        let actual_len = bytes.len() as u32;
        bytes[0x00..0x04].copy_from_slice(&actual_len.to_le_bytes());
        let err = SystemSave::decode(&bytes).expect_err("wrong magic");
        match err {
            SaveDecodeError::MagicMismatch { observed, expected } => {
                assert_eq!(observed, GLOBAL_SAVE_MAGIC);
                assert_eq!(expected, SYSTEM_SAVE_MAGIC);
            }
            other => panic!("expected MagicMismatch, got {other:?}"),
        }
    }

    #[test]
    fn global_save_round_trips_synthetic_bytes_byte_identically() {
        let synthetic = SaveRoundTrip::synthetic_global_save(128);
        let decoded = GlobalSave::decode(&synthetic).expect("decode");
        let re_encoded = decoded.encode();
        assert_eq!(re_encoded, synthetic, "round-trip must be byte-identical");
    }

    #[test]
    fn read_flags_round_trips_synthetic_bytes_byte_identically() {
        // Shift-JIS title bytes exercise decoding and byte-identical round-tripping.
        let title_bytes = vec![0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x81, 0x40];
        let synthetic = SaveRoundTrip::synthetic_read_flags(&title_bytes, 256);
        let decoded = ReadFlags::decode(&synthetic).expect("decode");
        assert_eq!(decoded.title_bytes, title_bytes);
        assert_eq!(decoded.title, "テスト\u{3000}");
        let re_encoded = decoded.encode();
        assert_eq!(re_encoded, synthetic, "round-trip must be byte-identical");
    }

    #[test]
    fn read_flags_decode_rejects_unterminated_title() {
        let mut bytes = SaveRoundTrip::synthetic_read_flags(b"AVG", 0);
        // Strip the trailing payload + NUL terminator + last title
        // byte; the title field is now unterminated within the slice.
        bytes.truncate(AVG_SAVE_PREAMBLE_BYTE_LEN + 3);
        let err = ReadFlags::decode(&bytes).expect_err("unterminated title");
        assert!(matches!(err, SaveDecodeError::MagicUnterminated { .. }));
        assert_eq!(err.semantic_code(), codes::MAGIC_UNTERMINATED);
    }

    #[test]
    fn save_state_is_inspectable_with_pinned_id() {
        let state = SaveState::new();
        assert_eq!(state.inspectable_id(), SAVE_STATE_INSPECTABLE_ID);
        let tree = state.inspect_state().expect("inspect");
        assert!(!tree.is_empty(), "manifest entry must always be present");
    }

    #[test]
    fn save_state_restore_round_trips_through_state_tree() {
        let mut state = SaveState::new();
        let synthetic = SaveRoundTrip::synthetic_system_save(2048);
        let system = SystemSave::decode(&synthetic).expect("decode");
        state.set_system_save(system.clone());
        let tree = state.inspect_state().expect("inspect");
        let mut restored = SaveState::new();
        let report = restored.restore_state(&tree).expect("restore");
        assert!(report.ignored_by_design.is_empty());
        assert_eq!(restored.system_save(), Some(&system));
        assert_eq!(restored.global_save(), None);
        assert_eq!(restored.read_flags(), None);
    }

    #[test]
    fn save_state_restore_rejects_unknown_state_path() {
        let mut state = SaveState::new();
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse(MANIFEST_PATH).expect("path"),
            StateValue::String {
                value: SAVE_STATE_MANIFEST.to_string(),
            },
        )
        .expect("insert");
        tree.insert(
            StatePath::parse("port.save_state.unknown").expect("path"),
            StateValue::String {
                value: "deadbeef".to_string(),
            },
        )
        .expect("insert");
        let err = state.restore_state(&tree).expect_err("unknown path");
        assert!(matches!(err, SnapshotError::RestoreStatePathUnknown { .. }));
    }

    #[test]
    fn codes_all_lists_every_semantic_code() {
        // Audit grep: this list must cover every code the variant set
        // produces.
        let variants = [
            SaveDecodeError::PreambleTruncated {
                have: 0,
                need: 0x18,
            },
            SaveDecodeError::PreambleFileSizeMismatch {
                declared: 0,
                actual: 0,
            },
            SaveDecodeError::MagicUnterminated { search_len: 0 },
            SaveDecodeError::MagicMismatch {
                observed: "x".to_string(),
                expected: SYSTEM_SAVE_MAGIC,
            },
            SaveDecodeError::ShiftJisDecodeFailure { byte_len: 0 },
        ];
        let all: std::collections::HashSet<&'static str> = codes::ALL.iter().copied().collect();
        for v in &variants {
            assert!(
                all.contains(v.semantic_code()),
                "code {} missing from codes::ALL",
                v.semantic_code()
            );
        }
    }

    #[test]
    fn round_trip_synthetic_global_save_with_zero_payload() {
        let synthetic = SaveRoundTrip::synthetic_global_save(0);
        let decoded = GlobalSave::decode(&synthetic).expect("decode");
        assert!(decoded.payload.is_empty());
        assert_eq!(decoded.encode(), synthetic);
    }

    #[test]
    fn hex_helpers_round_trip_high_bit_bytes() {
        let bytes = vec![0x00, 0x7f, 0x80, 0xff];
        let hex = bytes_to_hex(&bytes);
        assert_eq!(hex, "007f80ff");
        assert_eq!(hex_to_bytes(&hex).expect("parse"), bytes);
    }
}

