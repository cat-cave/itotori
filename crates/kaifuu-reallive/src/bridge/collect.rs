use super::*;

pub(super) fn collect_units(
    _scene_id: u16,
    opcode_spans: &[(RealLiveOpcode, usize)],
    gameexe_inventory: &GameexeInventoryReport,
    opts: &BridgeOpts<'_>,
) -> Vec<ProtoUnit> {
    let mut units: Vec<ProtoUnit> = Vec::new();
    let mut occurrence: usize = 0;
    let mut choice_group: usize = 0;
    let mut inline_kidoku_seen = false;

    // Pending control markers that should attach to the next text unit.
    let mut pending_markers: Vec<PendingMarker> = Vec::new();
    // Last speaker raw label seen, carried forward until voice attach.
    let mut last_speaker: Option<String> = None;
    // Decompressed-byte cursor. Each element's width comes from the
    // authoritative width-carrying decode ([`parse_real_bytecode_spans`]),
    // so the cursor lands at the exact start of every text-display body
    // and can never drift from `decode_command`'s real boundaries.
    let mut cursor: u64 = 0;

    for (idx, (op, width)) in opcode_spans.iter().enumerate() {
        let width = *width;
        match op {
            RealLiveOpcode::MetaKidoku { mark } => {
                pending_markers.push(PendingMarker {
                    parsed_name: "reallive.kidoku",
                    out_of_band: true,
                    label: format!("<reallive.kidoku {mark}>"),
                });
                inline_kidoku_seen = true;
            }
            RealLiveOpcode::Textout { raw_bytes, .. } => {
                // `Textout` is the decoder's catch-all, not a semantic
                // dialogue opcode: every non-structural byte run lands here,
                // so a run is only a translatable dialogue unit when its
                // bytes decode as readable Shift-JIS dialogue — valid decode
                // AND no control bytes ([`decode_dialogue_textout`]). A
                // binary / control-byte data run (e.g. a periodic-record
                // table that sits after a 2nd MetaEntrypoint, or a low-byte
                // block that decodes cleanly into C0 control characters)
                // returns `None`: we DO NOT emit a unit and DO NOT consume an
                // occurrence index. The patchback re-walk
                // (collect_text_unit_positions) applies the SAME predicate,
                // so both paths skip the run identically and every later
                // unit's occurrence_index stays aligned. Pending control
                // markers are left intact so they carry forward to the next
                // real dialogue unit; the cursor still advances by `width`
                // below so the run's bytes are accounted for in provenance.
                if let Some(decoded) = decode_dialogue_textout(raw_bytes) {
                    let (control_prefix, prefix_spans) =
                        build_control_prefix(&mut pending_markers, &decoded);
                    let (raw_speaker, name_token_spans) =
                        extract_name_token_spans(&decoded, control_prefix.len() as u64);
                    let asset_ref_spans = extract_inline_tag_spans(
                        &decoded,
                        control_prefix.len() as u64,
                        RLDEV_ASSET_REF_TAGS,
                        "reallive.asset_ref",
                    );
                    let font_tone_spans = extract_inline_tag_spans(
                        &decoded,
                        control_prefix.len() as u64,
                        RLDEV_FONT_TONE_TAGS,
                        "reallive.font_tone",
                    );
                    let mut spans = prefix_spans;
                    spans.extend(name_token_spans);
                    spans.extend(asset_ref_spans);
                    spans.extend(font_tone_spans);
                    if let Some(ref speaker) = raw_speaker {
                        last_speaker = Some(speaker.clone());
                    }
                    let unit = ProtoUnit {
                        surface_kind: "dialogue",
                        decoded_text: decoded,
                        control_prefix,
                        spans,
                        raw_speaker: raw_speaker.or_else(|| last_speaker.clone()),
                        speaker_from_fallback: false,
                        resolution: SpeakerResolution::NotApplicable,
                        decompressed_byte_offset: cursor,
                        decompressed_byte_len: raw_bytes.len() as u64,
                        voice_archive_id: None,
                        voice_sample_id: None,
                        occurrence_index: occurrence,
                        choice_group_index: None,
                        choice_option_index: None,
                    };
                    occurrence += 1;
                    units.push(unit);
                }
            }
            RealLiveOpcode::Choice { choices } => {
                for (option_index, choice) in choices.iter().enumerate() {
                    let choice_bytes = choice.bytes.as_slice();
                    // A choice option is a translatable unit only when its
                    // bytes decode as readable Shift-JIS dialogue — valid
                    // decode AND no control bytes (`decode_dialogue_textout`,
                    // the same invariant the Textout path uses). `None`
                    // covers BOTH an empty interior `,,` segment AND an
                    // option that carries no static dialogue, e.g. an rlBabel
                    // `###PRINT(<expr>)` runtime interpolation whose displayed
                    // text is computed from a memory-bank variable at run time
                    // (its body is compiled expression bytes, not text). Such
                    // an option is NOT a translatable unit and must NOT
                    // consume an occurrence index — the patchback re-walk
                    // (collect_text_unit_positions) applies the SAME gate, so
                    // both paths skip the identical options and every later
                    // unit's occurrence_index stays aligned (no
                    // ProvenanceMismatch).
                    let Some(decoded) = decode_dialogue_textout(choice_bytes) else {
                        continue;
                    };
                    let (control_prefix, prefix_spans) =
                        build_control_prefix(&mut pending_markers, &decoded);
                    // Choice marker bytes inside the choice body
                    // (`0x30..0x34` per spec) — search the raw bytes for
                    // those control markers.
                    let mut spans = prefix_spans;
                    let choice_marker_spans = extract_choice_marker_spans(
                        choice_bytes,
                        &decoded,
                        control_prefix.len() as u64,
                    );
                    spans.extend(choice_marker_spans);
                    let unit = ProtoUnit {
                        surface_kind: "choice_label",
                        decoded_text: decoded,
                        control_prefix,
                        spans,
                        raw_speaker: None,
                        speaker_from_fallback: false,
                        resolution: SpeakerResolution::NotApplicable,
                        // Anchor the choice unit at the OPTION's own scene-
                        // relative byte offset — the same authoritative offset
                        // patchback splices at (`collect_text_unit_positions`
                        // uses `choice.byte_offset`, never the command opener).
                        // Using `cursor` (the Choice command opener) made every
                        // option in a `select` share the command offset, so the
                        // bundle's `sourceLocation.range` disagreed with both
                        // the actual option bytes and the narrative structure's
                        // decoded per-option offset (a byte-range join failure).
                        decompressed_byte_offset: choice.byte_offset,
                        decompressed_byte_len: choice_bytes.len() as u64,
                        voice_archive_id: None,
                        voice_sample_id: None,
                        occurrence_index: occurrence,
                        choice_group_index: Some(choice_group),
                        choice_option_index: Some(option_index),
                    };
                    occurrence += 1;
                    units.push(unit);
                }
                choice_group += 1;
            }
            RealLiveOpcode::VoicePlay {
                voice_id: Some(voice_id),
            } => {
                // Look-ahead-pin onto the most recent text unit if it
                // hasn't already been pinned to a different voice.
                if let Some(unit) = units.last_mut()
                    && unit.surface_kind == "dialogue"
                    && unit.voice_archive_id.is_none()
                {
                    let archive_id = format!("z{:04}", (voice_id >> 16) as u16);
                    let sample_id = voice_id & 0xFFFF;
                    unit.voice_archive_id = Some(archive_id);
                    unit.voice_sample_id = Some(sample_id);
                }
            }
            _ => {}
        }
        cursor = cursor.saturating_add(width as u64);
        let _ = idx; // kept for future per-opcode diagnostics

        // Carry the attributed speaker forward ONLY across a genuine within-
        // line continuation: another raw `Textout` fragment of the SAME
        // already-open visible run (consecutive `Textout`s with no intervening
        // boundary). This is an ALLOWLIST, not a denylist: EVERY other opcode
        // clears `last_speaker` — a line/page/scene boundary
        // (`MetaLine`/`MetaEntrypoint`), a display command
        // (`TextDisplay`/`CharacterTextDisplay`), a `module_sel` `Choice` or a
        // `VoicePlay` (all of which END the open run), AND any unhandled opcode
        // (the `_` arm above). So a tokenless narration run can never inherit a
        // prior line's speaker, and a newly-added or unrecognised opcode can
        // never silently preserve it — the structural robustness a per-opcode
        // denylist lacked. The `Textout` arm itself SETS `last_speaker` from a
        // line's own inline `【…】` token; that assignment survives precisely
        // because `Textout` is the one arm on this allowlist.
        if !matches!(op, RealLiveOpcode::Textout { .. }) {
            last_speaker = None;
        }
    }

    // Resolve speakers through NAMAE.
    //
    // Attribution uses ONLY authoritative display-key evidence: the inline
    // `【…】` name token captured during the walk (`raw_speaker` set on the
    // Textout arm), optionally carried across a single displayed line's
    // Textout fragments and CLEARED at every line/page/scene boundary and
    // after voice attachment (so tokenless narration is never attributed).
    // There is deliberately NO `decoded_text.contains(namae)` substring scan:
    // that fabricated a speaker for any narration whose body merely embedded
    // a registered name (`"I saw Ren & Ken leave."` → known Ren), which the
    // real runtime — an EXACT `【…】`-key lookup (`NamaeResolver::resolve`) —
    // never does.
    //
    // Bounded best-effort fallback: when NO dialogue unit carries an inline
    // token anywhere in the scene, the first tokenless dialogue unit is
    // pinned to the first NAMAE display key AND flagged
    // `speaker_from_fallback`. A flagged guess is emitted as `parser_unknown`
    // (never promoted to a resolved identity) — the honest shape for "a
    // speaker exists but the per-line attribution is uncertain", which the
    // runtime/QA loop can refine.
    //
    // Resolution: each pinned raw speaker is resolved to a typed
    // [`SpeakerResolution`] via the NAMAE registry (see
    // `resolve_unit_speaker`). A name that resolves keeps its resolved
    // identity; only genuinely-unresolved speakers stay `parser_unknown`.
    let namae_values: Vec<String> = gameexe_inventory
        .entries
        .iter()
        .filter(|entry| matches!(entry.family, GameexeKeyFamily::Namae))
        .filter_map(|entry| {
            entry
                .value
                .split('=')
                .next()
                .map(|head| head.trim().trim_matches('"').to_string())
        })
        .filter(|value| !value.is_empty())
        .collect();
    let any_inline_speaker = units
        .iter()
        .any(|unit| unit.surface_kind == "dialogue" && unit.raw_speaker.is_some());
    if !any_inline_speaker
        && let Some(first_namae) = namae_values.first()
        && let Some(unit) = units
            .iter_mut()
            .find(|unit| unit.surface_kind == "dialogue" && unit.raw_speaker.is_none())
    {
        unit.raw_speaker = Some(first_namae.clone());
        unit.speaker_from_fallback = true;
    }
    for unit in &mut units {
        unit.resolution = resolve_unit_speaker(unit, gameexe_inventory);
    }

    // Synthesise a reallive.kidoku span when the scene header declares
    // kidoku entries but the inline walk produced none. RealLive's
    // read-tracking can be table-driven; the declared count is the canonical
    // proof a kidoku surface exists.
    if !inline_kidoku_seen
        && opts.scene_kidoku_count > 0
        && let Some(unit) = units.first_mut()
    {
        let marker = format!("<reallive.kidoku table:{}>", opts.scene_kidoku_count);
        let start = unit.control_prefix.len() as u64;
        let new_prefix = format!("{}{marker}", unit.control_prefix);
        let end = new_prefix.len() as u64;
        // Shift downstream span byte ranges to account for the prepended
        // marker.
        let shift = end - start;
        for span in &mut unit.spans {
            span.start_byte += shift;
            span.end_byte += shift;
        }
        unit.spans.insert(
            0,
            ProtoSpan {
                parsed_name: "reallive.kidoku",
                out_of_band: true,
                start_byte: start,
                end_byte: end,
                raw: marker,
            },
        );
        unit.control_prefix = new_prefix;
    }

    units
}
