use super::*;

/// The Choice-bearing scene the config-driven-scope tests exercise:
/// Sweetie HD scene 2011 carries a real `module_sel` Choice (op #33, before
/// all 213 dialogue units) with two Shift-JIS options.
const CHOICE_SCENE_ID: u16 = 2011;

/// Produce the scene-2011 source bundle and return
/// `(translated_json_value, choice_unit_keys)` where `choice_unit_keys`
/// lists the `sourceUnitKey`s of the two `choice_label` units in order.
fn scene_2011_source_bundle(seen_bytes: &[u8]) -> (serde_json::Value, Vec<String>) {
    let (scene_blob, decompressed, header) = scene_bytes(seen_bytes, CHOICE_SCENE_ID);
    let gameexe_bytes = real_gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let opts = bridge_opts(header.kidoku_count);
    let produced = produce_bundle(
        CHOICE_SCENE_ID,
        &scene_blob,
        &decompressed,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle must build from the choice scene");
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
        "scene {CHOICE_SCENE_ID} must surface exactly two choice_label options"
    );
    (produced.json.clone(), choice_keys)
}

/// A translated en-US choice option deliberately carrying NextString-hostile
/// bytes: `[` (0x5B, the memory-index open byte that ends an unquoted
/// NextString token), plus `.`, `!`, `(`, `)`, `,`, `-`, `'` — none of which
/// are unquoted string-token bytes. A raw Shift-JIS splice of this text would
/// truncate the option and corrupt the select command.
const TRICKY_CHOICE_0: &str = "[EN] Maybe today I'm in the mood (yes!), a bit.";
const TRICKY_CHOICE_1: &str = "[EN] No way - I'd rather not... [skip]";

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn scope_dialogue_and_choices_patches_scene_2011_choice_nextstring_safe_round_trip() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::require_real_bytes(
            "scope_dialogue_and_choices_patches_scene_2011_choice_nextstring_safe_round_trip",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path).expect("read Seen.txt");
    let cipher = recover_archive_xor2_cipher(&seen_bytes)
        .expect("Sweetie HD must yield a validated xor_2 cipher");

    let (mut bundle_value, choice_keys) = scene_2011_source_bundle(&seen_bytes);

    // Translate the two choice options to the tricky en-US strings and the
    // dialogue units to a sentinel — all IN scope under dialogue+choices.
    let tricky = [TRICKY_CHOICE_0, TRICKY_CHOICE_1];
    {
        let units = bundle_value["units"].as_array_mut().expect("units array");
        for unit in units.iter_mut() {
            let key = unit["sourceUnitKey"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let text = if let Some(idx) = choice_keys.iter().position(|k| *k == key) {
                tricky[idx].to_string()
            } else {
                EN_SENTINEL.to_string()
            };
            unit["target"] = serde_json::json!({"locale": "en-US", "text": text});
        }
    }
    let translated = TranslatedBundleV02::from_json(&bundle_value).expect("translated parses");

    let patched = apply_translated_bundle(
        &seen_bytes,
        &translated,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueAndChoices),
    )
    .expect("dialogue+choices patch must succeed on the real choice scene");

    // Re-parse the patched scene at the plaintext layer.
    let patched_bytecode = decrypt_scene(&patched, CHOICE_SCENE_ID, &cipher);
    let ops = parse_real_bytecode(&patched_bytecode)
        .expect("patched choice scene must re-decompile cleanly (select framing intact)");
    let choices = ops
        .iter()
        .find_map(|op| match op {
            RealLiveOpcode::Choice { choices } => Some(choices),
            _ => None,
        })
        .expect("patched scene must still carry the module_sel Choice command");
    assert_eq!(
        choices.len(),
        2,
        "both choice options must survive the NextString-safe splice"
    );

    // Each option's raw bytes must equal the NextString-safe encoding of its
    // tricky translation, decode cleanly, and NOT carry an unescaped early
    // terminator — i.e. the `[` did not corrupt the token.
    for (i, expected_text) in tricky.iter().enumerate() {
        let expected_bytes =
            encode_choice_option_next_string_safe(expected_text).expect("tricky text encodes");
        assert!(
            choices[i].bytes == expected_bytes,
            "option {i} bytes must be the NextString-safe quoted encoding of the translation: actual {}, expected {}",
            RedactedContentSummary::from_bytes(&choices[i].bytes),
            RedactedContentSummary::from_bytes(&expected_bytes),
        );
        assert!(
            decode_dialogue_textout(&choices[i].bytes).is_some(),
            "option {i} must decode cleanly as a translatable Shift-JIS run"
        );
        // The tricky `[` byte is present INSIDE the option (proving it was
        // carried, not stripped/truncated).
        assert!(
            choices[i].bytes.contains(&b'['),
            "option {i} must carry the literal `[` byte inside the quoted NextString"
        );
    }
    eprintln!(
        "scope=dialogue+choices: scene {CHOICE_SCENE_ID} choice round-tripped NextString-safe \
         (options: {:?})",
        choices.iter().map(|c| c.bytes.len()).collect::<Vec<_>>()
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn scope_dialogue_only_carries_scene_2011_choice_byte_identical() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::require_real_bytes(
            "scope_dialogue_only_carries_scene_2011_choice_byte_identical",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path).expect("read Seen.txt");
    let cipher = recover_archive_xor2_cipher(&seen_bytes)
        .expect("Sweetie HD must yield a validated xor_2 cipher");

    // Capture the SOURCE choice options.
    let source_bytecode = decrypt_scene(&seen_bytes, CHOICE_SCENE_ID, &cipher);
    let source_ops = parse_real_bytecode(&source_bytecode).expect("source scene decompiles");
    let source_choice: Vec<Vec<u8>> = source_ops
        .iter()
        .find_map(|op| match op {
            RealLiveOpcode::Choice { choices } => {
                Some(choices.iter().map(|c| c.bytes.clone()).collect())
            }
            _ => None,
        })
        .expect("source scene carries a Choice command");

    let (mut bundle_value, choice_keys) = scene_2011_source_bundle(&seen_bytes);

    // Give the CHOICE units a corrupting `[`-bearing target and the dialogue
    // units the sentinel. Under dialogue-only scope the choice targets MUST be
    // ignored (carried byte-identical) — proving the CONFIG, not bundle
    // omission, enforces the scope boundary. This is the exact byte that would
    // corrupt a naive splice.
    {
        let units = bundle_value["units"].as_array_mut().expect("units array");
        for unit in units.iter_mut() {
            let key = unit["sourceUnitKey"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let text = if choice_keys.contains(&key) {
                TRICKY_CHOICE_0.to_string()
            } else {
                EN_SENTINEL.to_string()
            };
            unit["target"] = serde_json::json!({"locale": "en-US", "text": text});
        }
    }
    let translated = TranslatedBundleV02::from_json(&bundle_value).expect("translated parses");

    let patched = apply_translated_bundle(
        &seen_bytes,
        &translated,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect("dialogue-only patch must succeed");

    let patched_bytecode = decrypt_scene(&patched, CHOICE_SCENE_ID, &cipher);
    let patched_ops =
        parse_real_bytecode(&patched_bytecode).expect("patched scene decompiles cleanly");
    let patched_choice: Vec<Vec<u8>> = patched_ops
        .iter()
        .find_map(|op| match op {
            RealLiveOpcode::Choice { choices } => {
                Some(choices.iter().map(|c| c.bytes.clone()).collect())
            }
            _ => None,
        })
        .expect("patched scene still carries a Choice command");

    assert!(
        patched_choice == source_choice,
        "out-of-scope Choice options must be byte-identical under dialogue-only scope \
         (the corrupting `[` target must NOT have been applied): actual {}, expected {}",
        RedactedContentSummary::from_bytes(&patched_choice.concat()),
        RedactedContentSummary::from_bytes(&source_choice.concat()),
    );

    // Sanity: the dialogue WAS translated (the scope boundary is non-vacuous).
    let sentinel_sjis =
        kaifuu_reallive::encode_shift_jis_slot(EN_SENTINEL).expect("sentinel encodes");
    let sentinel_present = patched_bytecode
        .windows(sentinel_sjis.len())
        .any(|w| w == sentinel_sjis.as_slice());
    assert!(
        sentinel_present,
        "dialogue-only scope must still translate the dialogue Textout bodies"
    );
    eprintln!(
        "scope=dialogue-only: scene {CHOICE_SCENE_ID} choice options carried byte-identical \
         ({} options), dialogue translated",
        source_choice.len()
    );
}
