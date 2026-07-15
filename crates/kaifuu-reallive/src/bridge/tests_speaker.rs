use super::test_support::*;
use super::*;
use crate::gameexe::parse_gameexe_inventory;

#[test]
fn namae_resolved_inline_speaker_is_known_not_mislabeled_parser_unknown() {
    // A `【Ren】` inline name token whose name resolves to a NAMAE row must
    // keep its resolved identity (`known`), NOT be flattened to
    // `parser_unknown` as the old producer did for every speaker.
    let report = parse_gameexe_inventory(
        b"#NAMAE=\"Ren\" = \"Ren\" = (1,016, -1)\n#COLOR_TABLE.016=204,204,255\n",
    );
    let bytecode = dialogue_bytecode("\u{3010}Ren\u{3011}hello");
    let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
        .expect("resolved inline speaker must produce a unit");
    let speaker = &produced.json["units"][0]["speaker"];
    assert_eq!(
        speaker["knowledgeState"], "known",
        "a NAMAE-resolved name must never be mislabelled parser_unknown; got {speaker}"
    );
    assert_eq!(speaker["displayName"], "Ren");
    assert_eq!(speaker["canonicalNameRef"], "reallive:namae:Ren");
    assert_eq!(speaker["revealState"], "revealed");
    assert_eq!(speaker["textColor"], json!([204, 204, 255]));
    assert!(
        speaker["speakerId"].as_str().is_some(),
        "known speaker must carry a resolved speakerId"
    );
}

#[test]
fn namae_censored_row_yields_reader_unknown_with_reader_safe_label() {
    // A censored NAMAE row (display key differs from the box-shown name)
    // means the parser knows the identity but the reader is shown a mask:
    // `reader_unknown`, carrying the reader-safe `readerLabel` mask.
    // Modelled on the REAL Sweetie HD rows (`#NAMAE="？？？／凛"="？？？"`):
    // the inline `【…】` token carries the DISPLAY KEY (identity), and the
    // reader sees the box-shown mask — the direction the runtime resolves.
    let report = parse_gameexe_inventory(
        b"#NAMAE=\"hidden-ren\" = \"???\" = (1,016, -1)\n#COLOR_TABLE.016=204,204,255\n",
    );
    let bytecode = dialogue_bytecode("\u{3010}hidden-ren\u{3011}hello");
    let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
        .expect("censored speaker must produce a unit");
    let speaker = &produced.json["units"][0]["speaker"];
    assert_eq!(speaker["knowledgeState"], "reader_unknown");
    assert_eq!(speaker["displayName"], "hidden-ren");
    assert_eq!(
        speaker["readerLabel"], "???",
        "the reader-safe label is the box-shown mask, not the true identity"
    );
    assert_eq!(speaker["revealState"], "concealed");
}

#[test]
fn token_matching_only_a_box_shown_mask_stays_parser_unknown_no_fabricated_identity() {
    // FINDING 2 (false identity): a token that equals only the SECOND
    // (box-shown) field of a censored row must NOT resolve. The runtime
    // keys on the display key `hidden-ren`; a `【???】` token has no display
    // key `???`, so it stays `parser_unknown` and fabricates no identity.
    // (Deleting the display-key-only guard — reinstating `|| box_name ==
    // raw` — would emit `reader_unknown` identity `hidden-ren` here.)
    let report = parse_gameexe_inventory(
        b"#NAMAE=\"hidden-ren\" = \"???\" = (1,016, -1)\n#COLOR_TABLE.016=204,204,255\n",
    );
    let bytecode = dialogue_bytecode("\u{3010}???\u{3011}hello");
    let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
        .expect("unresolved token must still produce a unit");
    let speaker = &produced.json["units"][0]["speaker"];
    assert_eq!(
        speaker["knowledgeState"], "parser_unknown",
        "a token equal only to a box-shown mask must not fabricate an identity; got {speaker}"
    );
    assert_eq!(speaker["rawSpeakerText"], "???");
    assert!(
        speaker.get("displayName").is_none(),
        "no resolved displayName may be fabricated; got {speaker}"
    );
}

#[test]
fn display_key_token_resolves_uniquely_even_when_another_rows_box_equals_it() {
    // FINDING 2 (resolved key mislabelled unknown): rows A="???" and
    // B="A". The token `【A】` uniquely matches row A's display key. Row B's
    // box-shown `A` must NOT count as a second match (the old `|| box_name
    // == raw` arm returned `None` here → spurious `parser_unknown`). With
    // display-key-only matching this resolves cleanly to A (concealed,
    // since A's box is the mask `???`).
    let report = parse_gameexe_inventory(
        b"#NAMAE=\"A\" = \"???\" = (1,016, -1)\n#NAMAE=\"B\" = \"A\" = (1,016, -1)\n#COLOR_TABLE.016=204,204,255\n",
    );
    let bytecode = dialogue_bytecode("\u{3010}A\u{3011}hello");
    let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
        .expect("uniquely-keyed token must produce a unit");
    let speaker = &produced.json["units"][0]["speaker"];
    assert_ne!(
        speaker["knowledgeState"], "parser_unknown",
        "a unique display-key match must not be mislabelled ambiguous; got {speaker}"
    );
    assert_eq!(speaker["knowledgeState"], "reader_unknown");
    assert_eq!(speaker["displayName"], "A");
    assert_eq!(speaker["canonicalNameRef"], "reallive:namae:A");
    assert_eq!(speaker["readerLabel"], "???");
}

#[test]
fn tokenless_body_embedding_a_registered_name_is_not_attributed_as_known() {
    // FINDING 1 (substring fabrication): a tokenless narration body that
    // merely EMBEDS a registered name (`Ren`, `Ren & Ken`) must NOT be
    // promoted to `known`. The old `decoded_text.contains(namae)` scan
    // fabricated `known` Ren here. With that scan removed the only
    // attribution left is the bounded first-line fallback, which is
    // `parser_unknown` — never a resolved identity.
    let report = parse_gameexe_inventory(
        b"#NAMAE=\"Ren\" = \"Ren\" = (1,016, -1)\n#NAMAE=\"Ren & Ken\" = \"Ren & Ken\" = (1,016, -1)\n#COLOR_TABLE.016=204,204,255\n",
    );
    let bytecode = dialogue_bytecode("I saw Ren & Ken leave.");
    let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
        .expect("tokenless narration must still produce a unit");
    let speaker = &produced.json["units"][0]["speaker"];
    assert_ne!(
        speaker["knowledgeState"], "known",
        "tokenless narration embedding a name must never be attributed known; got {speaker}"
    );
    assert_ne!(speaker["knowledgeState"], "reader_unknown");
    assert!(
        speaker.get("displayName").is_none(),
        "no resolved displayName may be fabricated for narration; got {speaker}"
    );
}

#[test]
fn speaker_is_not_carried_forward_across_a_line_boundary_to_narration() {
    // FINDING 1 (unbounded carry-forward): `【Ren】Hello` names Ren for its
    // own line, but the FOLLOWING tokenless run `The door closed.` is
    // narration across a MetaLine boundary and must NOT inherit Ren. The
    // boundary clears `last_speaker`, so the narration unit is
    // `not_applicable`, not `known` Ren.
    let report = parse_gameexe_inventory(
        b"#NAMAE=\"Ren\" = \"Ren\" = (1,016, -1)\n#COLOR_TABLE.016=204,204,255\n",
    );
    let mut bytecode = dialogue_bytecode("\u{3010}Ren\u{3011}Hello");
    bytecode.extend_from_slice(&dialogue_bytecode("The door closed."));
    let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
        .expect("two-line scene must produce units");
    let units = produced.json["units"].as_array().expect("units array");
    assert_eq!(units.len(), 2, "both dialogue runs must surface");
    assert_eq!(
        units[0]["speaker"]["knowledgeState"], "known",
        "the named line keeps its own resolved speaker"
    );
    assert_eq!(units[0]["speaker"]["displayName"], "Ren");
    let narration = &units[1]["speaker"];
    assert_ne!(
        narration["knowledgeState"], "known",
        "tokenless narration after a line boundary must not carry the prior speaker; got {narration}"
    );
    assert_eq!(
        narration["knowledgeState"], "not_applicable",
        "with no inline token anywhere-after and a cleared carry-forward, narration is not_applicable; got {narration}"
    );
}

#[test]
fn speaker_is_not_carried_forward_across_a_text_display_command_to_narration() {
    // FINDING 1 round-2 (stale carry-forward past a display command): a
    // `TextDisplay` / `CharacterTextDisplay` command BEGINS a new visible run,
    // so the tokenless Textout that follows it must NOT inherit the prior
    // line's `【Ren】` speaker. This is the exact re-audit breaking input, built
    // WITHOUT any masking trailing MetaLine between the two runs (the earlier
    // carry-forward test relied on the per-body MetaLine helper, which cleared
    // the state and hid this path).
    let report = parse_gameexe_inventory(
        b"#NAMAE=\"Ren\" = \"Ren\" = (1,016, -1)\n#COLOR_TABLE.016=204,204,255\n",
    );
    let mut bytecode = sjis("\u{3010}Ren\u{3011}Hello");
    // module_msg TextDisplay command (COMMAND, type=1, id=MSG(3), opcode=5):
    // begins a fresh visible run — no MetaLine boundary in between.
    bytecode.extend_from_slice(&[0x23, 0x01, 0x03, 0x05, 0x00, 0x00, 0x00, 0x00]);
    bytecode.extend_from_slice(&sjis("The door closed."));
    bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]); // MetaLine terminator
    let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
        .expect("two-run scene must produce units");
    let units = produced.json["units"].as_array().expect("units array");
    assert_eq!(units.len(), 2, "both text runs must surface");
    assert_eq!(
        units[0]["speaker"]["knowledgeState"], "known",
        "the named run keeps its own resolved speaker"
    );
    assert_eq!(units[0]["speaker"]["displayName"], "Ren");
    let narration = &units[1]["speaker"];
    assert_ne!(
        narration["knowledgeState"], "known",
        "a tokenless run introduced by a display command must not inherit the prior speaker; got {narration}"
    );
    assert_eq!(
        narration["knowledgeState"], "not_applicable",
        "a display command clears carry-forward, so the tokenless narration is not_applicable; got {narration}"
    );
    assert!(
        narration.get("displayName").is_none(),
        "no resolved identity may be fabricated for the narration run; got {narration}"
    );
}

#[test]
fn speaker_is_not_carried_forward_across_a_choice_command_to_narration() {
    // FINDING 1 sibling (round-3): a `module_sel` Choice unambiguously ENDS the
    // open visible run, so the tokenless Textout after it must NOT inherit the
    // prior `【Ren】` speaker. This is the exact re-audit breaking input, built
    // WITHOUT a masking trailing MetaLine before the select.
    let report = parse_gameexe_inventory(
        b"#NAMAE=\"Ren\" = \"Ren\" = (1,016, -1)\n#COLOR_TABLE.016=204,204,255\n",
    );
    let mut bytecode = sjis("\u{3010}Ren\u{3011}Hello");
    // module_sel Choice: COMMAND header + `{ "A" \n+line "B" \n+line }`.
    bytecode.extend_from_slice(&[0x23, 0x00, 0x02, 0x01, 0x00, 0x02, 0x00, 0x00]);
    bytecode.push(b'{');
    bytecode.extend_from_slice(b"A");
    bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]);
    bytecode.extend_from_slice(b"B");
    bytecode.extend_from_slice(&[0x0a, 0x06, 0x00]);
    bytecode.push(b'}');
    bytecode.extend_from_slice(&sjis("The door closed."));
    bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]); // MetaLine terminator
    let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
        .expect("scene with a choice must produce units");
    let units = produced.json["units"].as_array().expect("units array");
    // unit[0] dialogue, unit[1..=2] choice options, unit[3] narration.
    let narration = units
        .iter()
        .find(|u| {
            u["surfaceKind"] == "dialogue" && u["sourceText"].as_str() == Some("The door closed.")
        })
        .expect("the post-choice narration unit must surface");
    let speaker = &narration["speaker"];
    assert_ne!(
        speaker["knowledgeState"], "known",
        "narration after a Choice must not inherit the prior line's speaker; got {speaker}"
    );
    assert_eq!(
        speaker["knowledgeState"], "not_applicable",
        "a Choice ends the open run, so the following tokenless narration is not_applicable; got {speaker}"
    );
    assert!(speaker.get("displayName").is_none());
    // Control: the named line itself is still `known` from its OWN token.
    assert_eq!(units[0]["speaker"]["knowledgeState"], "known");
    assert_eq!(units[0]["speaker"]["displayName"], "Ren");
}

#[test]
fn arbitrary_unhandled_opcode_between_a_named_line_and_narration_clears_the_speaker() {
    // FINDING 1 sibling (round-3), STRUCTURAL: the carry-forward is an
    // ALLOWLIST (only consecutive `Textout` fragments continue a run), so ANY
    // opcode without a dedicated continuation arm — here a bare `Comma` (0x2C),
    // standing in for any unhandled / newly-added opcode routed to the `_` arm
    // — must clear `last_speaker`. This proves the fix is structural, not a
    // per-opcode denylist that a new opcode could slip past. No masking
    // MetaLine sits between the named line and the narration.
    let report = parse_gameexe_inventory(
        b"#NAMAE=\"Ren\" = \"Ren\" = (1,016, -1)\n#COLOR_TABLE.016=204,204,255\n",
    );
    let mut bytecode = sjis("\u{3010}Ren\u{3011}Hello");
    bytecode.push(0x2c); // Comma opener — an opcode with NO continuation arm.
    bytecode.extend_from_slice(&sjis("The door closed."));
    bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]); // MetaLine terminator
    let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
        .expect("scene must produce units");
    let units = produced.json["units"].as_array().expect("units array");
    assert_eq!(
        units.len(),
        2,
        "the Comma emits no unit; two Textout units surface"
    );
    assert_eq!(units[0]["speaker"]["knowledgeState"], "known");
    assert_eq!(units[0]["speaker"]["displayName"], "Ren");
    let narration = &units[1]["speaker"];
    assert_ne!(
        narration["knowledgeState"], "known",
        "an unhandled opcode must NOT carry the speaker to the following narration; got {narration}"
    );
    assert_eq!(
        narration["knowledgeState"], "not_applicable",
        "the `_`-arm opcode cleared the speaker, so the narration is not_applicable; got {narration}"
    );
}

#[test]
fn color_table_out_of_range_row_is_rejected_not_clamped() {
    // FINDING 3 (RGB fabrication): `#COLOR_TABLE.016=300,-1,17` is not a
    // valid 8-bit triple. Clamping it to `[255,0,17]` would emit a colour
    // absent from Gameexe. The row is rejected: the speaker still resolves
    // (`known`), but NO `textColor` is emitted.
    let report = parse_gameexe_inventory(
        b"#NAMAE=\"Ren\" = \"Ren\" = (1,016, -1)\n#COLOR_TABLE.016=300,-1,17\n",
    );
    let bytecode = dialogue_bytecode("\u{3010}Ren\u{3011}hello");
    let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
        .expect("resolved speaker must produce a unit");
    let speaker = &produced.json["units"][0]["speaker"];
    assert_eq!(speaker["knowledgeState"], "known");
    assert!(
        speaker.get("textColor").is_none(),
        "an out-of-range COLOR_TABLE row must omit textColor, never emit a clamped fabricated RGB; got {speaker}"
    );
    // Sanity: a valid in-range row DOES emit the real colour.
    let valid = parse_gameexe_inventory(
        b"#NAMAE=\"Ren\" = \"Ren\" = (1,016, -1)\n#COLOR_TABLE.016=204,204,255\n",
    );
    let produced_valid = produce_bundle(1, &[0u8; 32], &bytecode, &valid, &opts_for_test())
        .expect("valid colour must produce a unit");
    assert_eq!(
        produced_valid.json["units"][0]["speaker"]["textColor"],
        json!([204, 204, 255])
    );
}

#[test]
fn inline_speaker_absent_from_namae_stays_parser_unknown() {
    // Genuinely unresolved: an inline token with no NAMAE row. It must
    // stay parser_unknown and must NOT fabricate a displayName.
    let report = parse_gameexe_inventory(b"#NAMAE=\"Ren\" = \"Ren\" = (1,016, -1)\n");
    let bytecode = dialogue_bytecode("\u{3010}Zzz\u{3011}hello");
    let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
        .expect("unresolved inline speaker must still produce a unit");
    let speaker = &produced.json["units"][0]["speaker"];
    assert_eq!(speaker["knowledgeState"], "parser_unknown");
    assert_eq!(speaker["rawSpeakerText"], "Zzz");
    assert!(
        speaker.get("displayName").is_none(),
        "an unresolved speaker must not fabricate a resolved displayName; got {speaker}"
    );
}

#[test]
fn best_effort_first_line_fallback_is_parser_unknown_never_resolved() {
    // The bounded first-line fallback is a guess, not a resolution: it
    // must surface as parser_unknown, never as a resolved identity.
    let report = parse_gameexe_inventory(b"#NAMAE=\"Ren\" = \"Ren\" = (1,016, -1)\n");
    let bytecode = dialogue_bytecode("hello world");
    let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
        .expect("fallback line must still produce a unit");
    let speaker = &produced.json["units"][0]["speaker"];
    assert_eq!(speaker["knowledgeState"], "parser_unknown");
    assert_eq!(speaker["rawSpeakerText"], "Ren");
    assert_eq!(speaker["evidence"], "namae_first_line_fallback");
}
