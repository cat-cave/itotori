use super::*;

pub(super) fn round_trip_choice_and_length_changing() {
    let manifest = manifest_value();
    let tuples = manifest_tuples(&manifest);
    let corpus = build_corpus("patchback", &tuples, false);

    let scene_id = corpus.content_scene_id;
    let index = parse_archive(&corpus.seen_bytes).expect("synthetic archive parses");
    let entry = index
        .entries
        .iter()
        .find(|e| e.scene_id == scene_id)
        .expect("content scene present");
    let blob = corpus.seen_bytes
        [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize]
        .to_vec();

    let gameexe_inventory = parse_gameexe_inventory(&[]);
    let opts = BridgeOpts {
        game_id: "synthetic-reallive",
        game_version: "0.0.0",
        source_profile_id: "synthetic-reallive",
        source_locale: "en-US",
        extractor_name: "synthetic-corpus-author",
        extractor_version: "0.1.0",
        scene_kidoku_count: 0,
    };
    let produced = produce_bundle(
        scene_id,
        &blob,
        &corpus.content_bytecode,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle builds from the synthetic scene");

    let choice_keys: Vec<String> = produced
        .bundle
        .units
        .iter()
        .filter(|u| u.surface_kind == "choice_label")
        .map(|u| u.source_unit_key.clone())
        .collect();
    assert_eq!(
        choice_keys.len(),
        2,
        "synthetic scene must surface exactly two choice_label options"
    );
    let dialogue_keys: Vec<String> = produced
        .bundle
        .units
        .iter()
        .filter(|u| u.surface_kind == "dialogue")
        .map(|u| u.source_unit_key.clone())
        .collect();
    assert!(
        !dialogue_keys.is_empty(),
        "synthetic scene must surface dialogue"
    );

    // Length-CHANGING dialogue + NextString-hostile choices (contain `[`, `(`
    // `)`, `!`, `,`, `-`, `.` — all outside the unquoted NextString set, so a
    // naive splice would corrupt the select block; the real encoder quotes it).
    let long_dialogue =
        "[EN] A deliberately much longer localized dialogue line (grows the scene!)";
    let tricky_choice_0 = "[EN] Go left, into the (bright) hall!";
    let tricky_choice_1 = "[EN] Wait - not yet, hold on...";
    let choice_targets = [tricky_choice_0, tricky_choice_1];

    let mut bundle_value = produced.json.clone();
    {
        let units = bundle_value["units"].as_array_mut().expect("units array");
        for unit in units.iter_mut() {
            let key = unit["sourceUnitKey"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let text = if let Some(idx) = choice_keys.iter().position(|k| *k == key) {
                choice_targets[idx].to_string()
            } else {
                long_dialogue.to_string()
            };
            unit["target"] = serde_json::json!({"locale": "en-US", "text": text});
        }
    }
    let translated =
        TranslatedBundleV02::from_json(&bundle_value).expect("translated bundle parses");

    let patched = apply_translated_bundle(
        &corpus.seen_bytes,
        &translated,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueAndChoices),
    )
    .expect("dialogue+choices patch must succeed on the synthetic archive");

    // The patched archive re-parses and the patched scene re-decodes CLEAN.
    let reindex = parse_archive(&patched).expect("patched archive re-parses");
    assert_eq!(reindex.entries.len(), index.entries.len());
    let new_entry = reindex
        .entries
        .iter()
        .find(|e| e.scene_id == scene_id)
        .expect("patched content scene present");
    let new_blob = &patched[new_entry.byte_offset as usize
        ..(new_entry.byte_offset + u64::from(new_entry.byte_len)) as usize];
    let new_header = SceneHeader::parse(new_blob).expect("patched header parses");
    let new_compressed = &new_blob[new_header.bytecode_offset as usize
        ..(new_header.bytecode_offset + new_header.bytecode_compressed_size) as usize];
    let new_bytecode = kaifuu_reallive::decompress_avg32(
        new_compressed,
        new_header.bytecode_uncompressed_size as usize,
    )
    .expect("patched scene decompresses");
    let patched_ops = parse_real_bytecode(&new_bytecode)
        .expect("patched scene re-decodes CLEAN (framing intact)");
    assert!(
        patched_ops.iter().all(RealLiveOpcode::is_recognized),
        "patched scene must have zero unknown / generic opcodes"
    );

    // The `{ … }` select block survives with both options re-inserted as the
    // NextString-safe encodings of the tricky translations.
    let patched_choices: &Vec<CommandArg> = patched_ops
        .iter()
        .find_map(|op| match op {
            RealLiveOpcode::Choice { choices } => Some(choices),
            _ => None,
        })
        .expect("patched scene still carries the select block");
    assert_eq!(patched_choices.len(), 2, "both choice options survive");
    for (i, target) in choice_targets.iter().enumerate() {
        let expected =
            encode_choice_option_next_string_safe(target).expect("choice encodes NextString-safe");
        assert_eq!(
            patched_choices[i].bytes, expected,
            "option {i} must be the NextString-safe quoted encoding of the translation"
        );
        assert!(
            decode_dialogue_textout(&patched_choices[i].bytes).is_some(),
            "option {i} decodes cleanly as a translatable run"
        );
    }

    // Length-CHANGING: the patched bytecode grew (longer dialogue + choices).
    assert!(
        new_bytecode.len() > corpus.content_bytecode.len(),
        "length-changing patch must grow the scene ({} -> {})",
        corpus.content_bytecode.len(),
        new_bytecode.len()
    );

    // Length-PRESERVING: an identity re-translation of the dialogue (under
    // dialogue-only scope, so the choices are carried byte-identical rather
    // than re-quoted) reproduces the source bytecode byte-for-byte (no drift).
    let mut identity_value = produced.json.clone();
    {
        let units = identity_value["units"].as_array_mut().expect("units array");
        for unit in units.iter_mut() {
            let src = unit["sourceText"].as_str().unwrap_or_default().to_string();
            unit["target"] = serde_json::json!({"locale": "en-US", "text": src});
        }
    }
    let identity = TranslatedBundleV02::from_json(&identity_value).expect("identity bundle parses");
    let identity_patched = apply_translated_bundle(
        &corpus.seen_bytes,
        &identity,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect("identity patch must succeed");
    let id_index = parse_archive(&identity_patched).expect("identity archive parses");
    let id_entry = id_index
        .entries
        .iter()
        .find(|e| e.scene_id == scene_id)
        .unwrap();
    let id_blob = &identity_patched[id_entry.byte_offset as usize
        ..(id_entry.byte_offset + u64::from(id_entry.byte_len)) as usize];
    let id_header = SceneHeader::parse(id_blob).unwrap();
    let id_compressed = &id_blob[id_header.bytecode_offset as usize
        ..(id_header.bytecode_offset + id_header.bytecode_compressed_size) as usize];
    let id_bytecode = kaifuu_reallive::decompress_avg32(
        id_compressed,
        id_header.bytecode_uncompressed_size as usize,
    )
    .unwrap();
    assert_eq!(
        id_bytecode, corpus.content_bytecode,
        "length-preserving identity patch must reproduce the source bytecode byte-for-byte"
    );
}
