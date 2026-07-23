use super::*;

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn patches_dialogue_scene_with_en_us_sentinel_and_preserves_binary_runs_byte_identical() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::require_real_bytes(
            "patches_dialogue_scene_with_en_us_sentinel_and_preserves_binary_runs_byte_identical",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));
    assert!(
        seen_bytes.len() as u64 >= REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
        "Seen.txt must carry the 10,000-slot directory"
    );

    let source_seen_hash = simple_hash(&seen_bytes);

    let index = parse_archive(&seen_bytes).expect("real Seen.txt envelope must parse");
    assert_eq!(
        index.entries.len(),
        198,
        "Sweetie HD must have 198 populated scene slots"
    );

    let (scene_blob, decompressed, header) = scene_bytes(&seen_bytes, DIALOGUE_SCENE_ID);

    // Capture every BINARY (non-translatable) Textout body BEFORE the
    // patch. These are the embedded data runs that must survive
    // byte-identical — they are never surfaced as translatable units.
    let original_opcodes = parse_real_bytecode(&decompressed).expect("source bytecode parses");
    let binary_runs: Vec<Vec<u8>> = original_opcodes
        .iter()
        .filter_map(|op| match op {
            RealLiveOpcode::Textout { raw_bytes, .. }
                if decode_dialogue_textout(raw_bytes).is_none() =>
            {
                Some(raw_bytes.clone())
            }
            _ => None,
        })
        .collect();
    assert!(
        !binary_runs.is_empty(),
        "the dialogue scene must contain at least one binary catch-all run to preserve"
    );
    // The first TRANSLATABLE textout body (used by the "original gone"
    // assertion — a binary run would survive and break the check).
    let original_first_dialogue: Vec<u8> = original_opcodes
        .iter()
        .find_map(|op| match op {
            RealLiveOpcode::Textout { raw_bytes, .. }
                if decode_dialogue_textout(raw_bytes).is_some() && raw_bytes.len() >= 4 =>
            {
                Some(raw_bytes.clone())
            }
            _ => None,
        })
        .expect("dialogue scene must have at least one readable textout");

    // Build the v0.2 source bundle (producer).
    let gameexe_bytes = real_gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let opts = bridge_opts(header.kidoku_count);
    let produced = produce_bundle(
        DIALOGUE_SCENE_ID,
        &scene_blob,
        &decompressed,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle must build from the dialogue scene");

    // Synthesise a translated bundle: en-US sentinel on every unit.
    let mut translated_value = produced.json.clone();
    {
        let units = translated_value["units"]
            .as_array_mut()
            .expect("units must be a JSON array");
        for unit in units.iter_mut() {
            unit["target"] = serde_json::json!({
                "locale": "en-US",
                "text": EN_SENTINEL,
            });
        }
    }
    let translated =
        TranslatedBundleV02::from_json(&translated_value).expect("translated bundle parses");

    let patched = apply_translated_bundle(
        &seen_bytes,
        &translated,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect("apply_translated_bundle must succeed on the dialogue scene");
    assert_eq!(
        simple_hash(&seen_bytes),
        source_seen_hash,
        "apply_translated_bundle must not mutate its input slice"
    );

    let reparsed = parse_archive(&patched).expect("patched Seen.txt must re-parse");
    assert_eq!(
        reparsed.entries.len(),
        198,
        "patched archive must preserve the 198-entry directory shape"
    );

    let new_entry = reparsed
        .entries
        .iter()
        .find(|entry| entry.scene_id == DIALOGUE_SCENE_ID)
        .expect("patched archive must still contain the dialogue scene");
    let new_blob_start = new_entry.byte_offset as usize;
    let new_blob_end = new_blob_start + new_entry.byte_len as usize;
    let new_scene_blob = &patched[new_blob_start..new_blob_end];
    let new_header = SceneHeader::parse(new_scene_blob).expect("patched scene header parses");
    let new_bytecode = &new_scene_blob[new_header.bytecode_offset as usize
        ..(new_header.bytecode_offset + new_header.bytecode_compressed_size) as usize];
    let mut new_decompressed =
        decompress_avg32(new_bytecode, new_header.bytecode_uncompressed_size as usize)
            .expect("patched bytecode must decompress cleanly");
    // Decrypt the patched scene to the PLAINTEXT layer — the same layer the
    // binary runs were captured at and the layer the interpreter executes.
    // The per-game key is recovered from the pristine SOURCE archive (every
    // source scene decodes clean, so the key validates); it is identical for
    // the patched archive, whose edited scene the patchback re-encrypted.
    if compiler_version_uses_xor2(new_header.compiler_version) {
        recover_archive_xor2_cipher(&seen_bytes)
            .expect("Sweetie HD source archive must yield a validated xor_2 cipher")
            .apply_segment(&mut new_decompressed);
    }

    for (i, run) in binary_runs.iter().enumerate() {
        let survives = new_decompressed
            .windows(run.len())
            .any(|window| window == run.as_slice());
        assert!(
            survives,
            "binary catch-all run #{i} (len={}) must survive patchback byte-identical — \
             a translate+patchback run must never overwrite an embedded data table",
            run.len()
        );
    }
    eprintln!(
        "scene {DIALOGUE_SCENE_ID}: {} binary runs preserved byte-identical",
        binary_runs.len()
    );

    let opcodes = parse_real_bytecode(&new_decompressed).expect("patched bytecode parses");
    let en_sentinel_bytes =
        kaifuu_reallive::encode_shift_jis_slot(EN_SENTINEL).expect("sentinel encodes as SJIS");
    let sentinel_in_bytecode = new_decompressed
        .windows(en_sentinel_bytes.len())
        .any(|window| window == en_sentinel_bytes.as_slice());
    assert!(
        sentinel_in_bytecode,
        "patched decompressed bytecode must contain the SJIS-encoded en-US sentinel (len={})",
        en_sentinel_bytes.len()
    );
    let textout_count = opcodes
        .iter()
        .filter(|op| matches!(op, RealLiveOpcode::Textout { .. }))
        .count();
    let sentinel_textout_count = opcodes
        .iter()
        .filter(|op| match op {
            RealLiveOpcode::Textout { raw_bytes, .. } => {
                raw_bytes.starts_with(EN_SENTINEL_SJIS_PREFIX)
            }
            _ => false,
        })
        .count();
    eprintln!(
        "scene {DIALOGUE_SCENE_ID} patched: textout_count={textout_count}, \
         sentinel_textout_count={sentinel_textout_count}"
    );
    assert!(
        sentinel_textout_count > 0,
        "at least one Textout must start with the en-US sentinel's SJIS prefix \
         (`「` = 0x81 0x75); got 0/{textout_count}"
    );

    let original_present = new_decompressed
        .windows(original_first_dialogue.len())
        .any(|window| window == original_first_dialogue.as_slice());
    assert!(
        !original_present,
        "original ja-JP dialogue body must no longer appear verbatim in the patched bytecode"
    );

    let size_ratio = (patched.len() as f64) / (seen_bytes.len() as f64);
    eprintln!(
        "Seen.txt size: source={} patched={} (ratio={size_ratio:.3})",
        seen_bytes.len(),
        patched.len()
    );
    assert!(
        (0.5..=1.5).contains(&size_ratio),
        "patched Seen.txt size {patched_len} is outside +/-50% of the source ({source_len})",
        patched_len = patched.len(),
        source_len = seen_bytes.len()
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn provenance_mismatch_byte_range_emits_typed_error_on_real_bytes() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::require_real_bytes(
            "provenance_mismatch_byte_range_emits_typed_error_on_real_bytes",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path).expect("read Seen.txt");

    let (scene_blob, decompressed, header) = scene_bytes(&seen_bytes, DIALOGUE_SCENE_ID);
    let gameexe_bytes = real_gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let opts = bridge_opts(header.kidoku_count);
    let produced = produce_bundle(
        DIALOGUE_SCENE_ID,
        &scene_blob,
        &decompressed,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle");

    let mut translated_value = produced.json.clone();
    {
        let units = translated_value["units"]
            .as_array_mut()
            .expect("units array");
        for unit in units.iter_mut() {
            unit["target"] = serde_json::json!({
                "locale": "en-US",
                "text": EN_SENTINEL,
            });
        }
        // Corrupt the first unit's occurrence index to one the scene's
        // bytecode re-walk cannot resolve.
        let bad_key = format!("reallive:scene-{DIALOGUE_SCENE_ID:04}#99999");
        units[0]["sourceUnitKey"] = serde_json::json!(bad_key);
        units[0]["patchRef"]["sourceUnitKey"] = serde_json::json!(bad_key);
    }
    let translated =
        TranslatedBundleV02::from_json(&translated_value).expect("translated bundle parses");
    let err = match apply_translated_bundle(
        &seen_bytes,
        &translated,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    ) {
        Err(err) => err,
        Ok(patched) => panic!(
            "corrupted provenance must raise a typed mismatch (unexpected archive {})",
            RedactedContentSummary::from_bytes(&patched)
        ),
    };
    let err_string = format!("{err}");
    assert!(
        err_string.contains("kaifuu.reallive.patchback_provenance_mismatch"),
        "expected provenance_mismatch code"
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn missing_target_payload_surfaces_typed_schema_invalid_on_real_bytes() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::require_real_bytes(
            "missing_target_payload_surfaces_typed_schema_invalid_on_real_bytes",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path).expect("read Seen.txt");
    let (scene_blob, decompressed, header) = scene_bytes(&seen_bytes, DIALOGUE_SCENE_ID);
    let gameexe_bytes = real_gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let opts = bridge_opts(header.kidoku_count);
    let produced = produce_bundle(
        DIALOGUE_SCENE_ID,
        &scene_blob,
        &decompressed,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle");
    // The source-side JSON has no `target` field — must fail to parse
    // as a translated bundle.
    let err = match TranslatedBundleV02::from_json(&produced.json) {
        Err(err) => err,
        Ok(bundle) => panic!(
            "missing target.text must surface a typed error (unexpected source_units={} targets={})",
            bundle.source.units.len(),
            bundle.targets.len()
        ),
    };
    let err_string = format!("{err}");
    assert!(
        err_string.contains("kaifuu.reallive.patchback_bundle_schema_invalid")
            || err_string.contains("target"),
        "expected bundle_schema_invalid code"
    );
}
