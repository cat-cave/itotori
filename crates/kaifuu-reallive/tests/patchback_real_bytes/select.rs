use super::*;

/// A real Sweetie HD **select-block** scene. Scene 1018 decodes 100% clean
/// (0 unknown, 0 generic) and carries exactly ONE `module_sel` `{ … }`
/// select block with two translatable Shift-JIS options, plus 13
/// goto-family jump pointers — 3 of whose targets sit AFTER the select
/// block, so a length-changing edit to the choice labels shifts those
/// targets and forces the jump-target recalculation path to run THROUGH a
/// select-block edit.
const SELECT_BLOCK_SCENE_ID: u16 = 1018;

/// Two length-CHANGING en-US choice replacements, each deliberately carrying
/// NextString-hostile bytes (`[`, `(`, `)`, `!`, `,`, `-`, `.`) — every one
/// of which is OUTSIDE the unquoted `NextString` token set, so a naive raw
/// Shift-JIS splice would truncate the option and let the trailing bytes be
/// misread as select-block structure (`}` close / next option), corrupting
/// the command. The NextString-safe encoder must quote them so the `{ … }`
/// framing survives. Both are longer than their (18- / 14-byte) sources so
/// the edit is genuinely length-INCREASING and re-bases the downstream
/// goto targets.
const SELECT_OPT_0: &str = "[EN] Go left, into the (bright) hall!";
const SELECT_OPT_1: &str = "[EN] Wait - not yet, hold on...";

/// Real select-block patchback round-trip (choice_label round-trip) on a
/// genuine multi-option `module_sel` `{ … }` block (Sweetie HD scene 1018).
/// Extracts the scene, translates ONLY the two choice labels (dialogue is
/// carried byte-identical via source-identity targets, so the select-block
/// edit is the SOLE length change — a crisp, attributable proof), patches
/// under `dialogue+choices` scope, then asserts:
/// - the patched scene re-decompiles with ZERO new unknown / generic
///   opcodes and framing that still partitions exactly;
/// - the `{ … }` select block survives: still exactly one Choice command
///   with both options re-inserted, each option's bytes equal to the
///   NextString-safe encoding of its translation (translated label
///   observed) and decoding cleanly as a Shift-JIS run;
/// - the scene bytecode grew by EXACTLY the choice-option byte delta
///   (dialogue untouched — the select-block edit is isolated);
/// - every goto pointer still lands on an element boundary and still
///   targets the SAME logical element; the 3 targets after the block are
///   re-based by exactly the delta, the rest are unchanged.
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn select_block_patchback_round_trips_byte_correct_on_real_scene_1018() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::require_real_bytes(
            "select_block_patchback_round_trips_byte_correct_on_real_scene_1018",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path).expect("read Seen.txt");
    let cipher = recover_archive_xor2_cipher(&seen_bytes)
        .expect("Sweetie HD must yield a validated xor_2 cipher");

    let source_bytecode = decrypt_scene(&seen_bytes, SELECT_BLOCK_SCENE_ID, &cipher);
    let source_ops = parse_real_bytecode(&source_bytecode).expect("source scene decompiles clean");
    assert_eq!(
        source_ops
            .iter()
            .filter(|o| matches!(o, RealLiveOpcode::Unknown { .. }))
            .count(),
        0,
        "source select-block scene must decode with zero unknown opcodes"
    );
    assert_eq!(
        source_ops
            .iter()
            .filter(|o| matches!(o, RealLiveOpcode::Command { .. }))
            .count(),
        0,
        "source select-block scene must decode with zero generic (un-catalogued) commands"
    );

    // Exactly one multi-option `module_sel` `{ … }` select block.
    let source_choice_blocks: Vec<&Vec<kaifuu_reallive::CommandArg>> = source_ops
        .iter()
        .filter_map(|o| match o {
            RealLiveOpcode::Choice { choices } => Some(choices),
            _ => None,
        })
        .collect();
    assert_eq!(
        source_choice_blocks.len(),
        1,
        "scene {SELECT_BLOCK_SCENE_ID} must carry exactly one select block"
    );
    let source_options = source_choice_blocks[0];
    assert!(
        source_options.len() >= 2,
        "select block must be MULTI-option; got {}",
        source_options.len()
    );
    assert!(
        source_options
            .iter()
            .all(|o| decode_dialogue_textout(&o.bytes).is_some()),
        "every source option must be a translatable Shift-JIS run"
    );
    let source_option_lens: Vec<usize> = source_options.iter().map(|o| o.bytes.len()).collect();

    // Byte offset where the select block begins (for the downstream-goto
    // partition below).
    let source_spans = parse_real_bytecode_spans(&source_bytecode).expect("source spans partition");
    let mut cursor = 0usize;
    let mut choice_block_start = None;
    for (op, width) in &source_spans {
        if matches!(op, RealLiveOpcode::Choice { .. }) {
            choice_block_start = Some(cursor);
        }
        cursor += width;
    }
    let choice_block_start = choice_block_start.expect("select block byte offset");

    // Source goto pointers + their target element identities.
    let source_boundaries = boundary_ordinals(&source_bytecode);
    let source_sites =
        collect_goto_pointer_sites(&source_bytecode).expect("source goto pointers collect");
    let source_target_ordinals: Vec<(usize, &'static str)> = source_sites
        .iter()
        .map(|site| {
            assert!(site.target >= 0, "source goto target must be non-negative");
            *source_boundaries
                .get(&(site.target as usize))
                .expect("source goto target lands on a boundary")
        })
        .collect();
    let downstream_target_count = source_sites
        .iter()
        .filter(|s| s.target as usize >= choice_block_start)
        .count();
    assert!(
        downstream_target_count > 0,
        "scene {SELECT_BLOCK_SCENE_ID} must have >=1 goto target after the select block \
         (so the length-changing choice edit exercises jump recalculation)"
    );

    let (scene_blob, decompressed, header) = scene_bytes(&seen_bytes, SELECT_BLOCK_SCENE_ID);
    let gameexe_bytes = real_gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let opts = bridge_opts(header.kidoku_count);
    let produced = produce_bundle(
        SELECT_BLOCK_SCENE_ID,
        &scene_blob,
        &decompressed,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle builds from the select-block scene");
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
        "scene {SELECT_BLOCK_SCENE_ID} must surface exactly two choice_label options"
    );

    let translations = [SELECT_OPT_0, SELECT_OPT_1];
    let mut bundle_value = produced.json.clone();
    {
        let units = bundle_value["units"].as_array_mut().expect("units array");
        for unit in units.iter_mut() {
            let key = unit["sourceUnitKey"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let text = if let Some(idx) = choice_keys.iter().position(|k| *k == key) {
                // Translate the choice label (length-changing, tricky bytes).
                translations[idx].to_string()
            } else {
                // Dialogue: source-identity target -> re-encodes byte-identical,
                // so the select-block edit is the SOLE length change.
                unit["sourceText"].as_str().unwrap_or_default().to_string()
            };
            unit["target"] = serde_json::json!({"locale": "en-US", "text": text});
        }
    }
    let translated =
        TranslatedBundleV02::from_json(&bundle_value).expect("translated bundle parses");

    let patched = apply_translated_bundle(
        &seen_bytes,
        &translated,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueAndChoices),
    )
    .expect("dialogue+choices patch must succeed on the real select-block scene");

    let patched_bytecode = decrypt_scene(&patched, SELECT_BLOCK_SCENE_ID, &cipher);
    let patched_ops = parse_real_bytecode(&patched_bytecode)
        .expect("patched select-block scene must re-decompile (select framing intact)");
    assert_eq!(
        patched_ops
            .iter()
            .filter(|o| matches!(o, RealLiveOpcode::Unknown { .. }))
            .count(),
        0,
        "ZERO new unknown opcodes required after the select-block round-trip"
    );
    assert_eq!(
        patched_ops
            .iter()
            .filter(|o| matches!(o, RealLiveOpcode::Command { .. }))
            .count(),
        0,
        "ZERO new generic (un-catalogued) commands required after the round-trip"
    );
    parse_real_bytecode_spans(&patched_bytecode)
        .expect("patched select-block framing must still partition exactly");

    let patched_options = patched_ops
        .iter()
        .find_map(|op| match op {
            RealLiveOpcode::Choice { choices } => Some(choices),
            _ => None,
        })
        .expect("patched scene must still carry the module_sel select block");
    assert_eq!(
        patched_ops
            .iter()
            .filter(|o| matches!(o, RealLiveOpcode::Choice { .. }))
            .count(),
        1,
        "the select block must not have split / duplicated"
    );
    assert_eq!(
        patched_options.len(),
        source_options.len(),
        "every select-block option must survive the NextString-safe re-insert"
    );
    for (i, translation) in translations.iter().enumerate() {
        let expected = encode_choice_option_next_string_safe(translation)
            .expect("translation encodes NextString-safe");
        assert!(
            patched_options[i].bytes == expected,
            "option {i} bytes must be the NextString-safe quoted encoding of the translation: actual {}, expected {}",
            RedactedContentSummary::from_bytes(&patched_options[i].bytes),
            RedactedContentSummary::from_bytes(&expected),
        );
        assert!(
            decode_dialogue_textout(&patched_options[i].bytes).is_some(),
            "option {i} must decode cleanly as a translatable Shift-JIS run"
        );
        // Translated label observed: the tricky `[` byte is carried inside the
        // quoted token (not stripped / truncated), proving the label went in.
        assert!(
            patched_options[i].bytes.contains(&b'['),
            "option {i} must carry the literal `[` byte inside the quoted NextString"
        );
    }

    let expected_delta: isize = translations
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let enc = encode_choice_option_next_string_safe(t)
                .expect("encodes")
                .len();
            enc as isize - source_option_lens[i] as isize
        })
        .sum();
    assert!(
        expected_delta > 0,
        "the chosen translations must be net length-INCREASING (delta={expected_delta})"
    );
    assert_eq!(
        patched_bytecode.len() as isize,
        source_bytecode.len() as isize + expected_delta,
        "patched bytecode length must equal source + choice-option delta \
         (dialogue carried byte-identical; only the select block changed)"
    );

    let patched_boundaries = boundary_ordinals(&patched_bytecode);
    let patched_sites =
        collect_goto_pointer_sites(&patched_bytecode).expect("patched goto pointers collect");
    assert_eq!(
        patched_sites.len(),
        source_sites.len(),
        "goto pointer count must be preserved across the select-block edit"
    );
    let mut rebased = 0usize;
    for (i, (src, pat)) in source_sites.iter().zip(patched_sites.iter()).enumerate() {
        assert!(
            pat.target >= 0,
            "patched goto target #{i} must be non-negative"
        );
        let (pat_ord, pat_label) = *patched_boundaries
            .get(&(pat.target as usize))
            .unwrap_or_else(|| {
                panic!(
                    "patched goto target #{i} = {:#x} does NOT land on an element boundary",
                    pat.target
                )
            });
        assert_eq!(
            (pat_ord, pat_label),
            source_target_ordinals[i],
            "goto #{i} must still target the same logical element after the select-block edit"
        );
        if (src.target as usize) >= choice_block_start {
            // A target after the edited select block shifts by exactly the delta.
            assert_eq!(
                pat.target as isize,
                src.target as isize + expected_delta,
                "downstream goto #{i} must be re-based by exactly the select-block delta"
            );
            rebased += 1;
        } else {
            // A target before the block is untouched.
            assert_eq!(
                pat.target, src.target,
                "goto #{i} before the select block must be unchanged"
            );
        }
    }
    assert_eq!(
        rebased, downstream_target_count,
        "every goto target after the select block must be re-based"
    );

    eprintln!(
        "scene {SELECT_BLOCK_SCENE_ID}: select block round-tripped byte-correct \
         (options {source_option_lens:?} -> {:?} bytes, delta=+{expected_delta}, \
         0 unknown, {rebased}/{} goto targets re-based, source_hash={:016x} patched_hash={:016x})",
        patched_options
            .iter()
            .map(|o| o.bytes.len())
            .collect::<Vec<_>>(),
        source_sites.len(),
        simple_hash(&source_bytecode),
        simple_hash(&patched_bytecode),
    );
}
