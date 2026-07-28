fn resolve_edit(
    target: &TranslatedUnitTarget,
    unit: &kaifuu_core::LocalizationUnitV02,
    scene_index: &RealLiveSceneIndex,
    opts: PatchbackOpts,
) -> Result<ResolvedEdit, PatchbackError> {
    if target.bridge_unit_id != unit.bridge_unit_id {
        return Err(PatchbackError::BundleSchemaInvalid {
            message: format!(
                "translated bundle target bridgeUnitId {target_id} does not match unit bridgeUnitId {unit_id}",
                target_id = target.bridge_unit_id,
                unit_id = unit.bridge_unit_id,
            ),
        });
    }

    // Pull (startByte, endByte) from the source-location range. Per the
    // producer the range is a DECOMPRESSED-bytecode-stream
    // interval — a single coordinate space. It is NOT used to identify
    // the owning scene (a decompressed offset has no meaning across the
    // compressed file layout); we keep it only for a positive-width
    // sanity check and typed-error context. The exact in-bytecode
    // position is recovered by re-walking [`parse_real_bytecode`] in
    // [`patch_scene_blob`], keyed on `occurrence_index`.
    let range = unit
        .source_location
        .get("range")
        .and_then(Value::as_object)
        .ok_or_else(|| PatchbackError::ProvenanceMismatch {
            bridge_unit_id: target.bridge_unit_id.clone(),
            start_byte: 0,
            end_byte: 0,
            reason: "sourceLocation has no `range` object".into(),
        })?;
    let start_byte = range
        .get("startByte")
        .and_then(Value::as_u64)
        .ok_or_else(|| PatchbackError::ProvenanceMismatch {
            bridge_unit_id: target.bridge_unit_id.clone(),
            start_byte: 0,
            end_byte: 0,
            reason: "sourceLocation.range.startByte must be a u64".into(),
        })?;
    let end_byte = range
        .get("endByte")
        .and_then(Value::as_u64)
        .ok_or_else(|| PatchbackError::ProvenanceMismatch {
            bridge_unit_id: target.bridge_unit_id.clone(),
            start_byte,
            end_byte: 0,
            reason: "sourceLocation.range.endByte must be a u64".into(),
        })?;
    if end_byte <= start_byte {
        return Err(PatchbackError::ProvenanceMismatch {
            bridge_unit_id: target.bridge_unit_id.clone(),
            start_byte,
            end_byte,
            reason: "endByte must be greater than startByte".into(),
        });
    }

    // Identify the owning scene AND the unit's occurrence index from the
    // v0.2 sourceUnitKey shape `reallive:scene-NNNN#OOOO`. The scene id
    // is the only honest scene key: it is invariant under the
    // decompressed/compressed coordinate split, so a unit deep in the
    // decompressed stream always resolves to its true scene (the prior
    // file-offset-containment path mis-resolved such units into a later
    // scene). `occurrence_index` is the authoritative in-scene
    // positioning key.
    let (scene_id, occurrence_index) = parse_scene_and_occurrence(&unit.source_unit_key)
        .ok_or_else(|| PatchbackError::ProvenanceMismatch {
            bridge_unit_id: target.bridge_unit_id.clone(),
            start_byte,
            end_byte,
            reason: format!(
                "sourceUnitKey {key:?} does not match the canonical \
                     `reallive:scene-NNNN#OOOO` shape",
                key = unit.source_unit_key
            ),
        })?;

    // Locate the scene entry whose slot id matches the unit's scene id.
    let (scene_entry_index, _entry) = scene_index
        .entries
        .iter()
        .enumerate()
        .find(|(_, entry)| entry.scene_id == scene_id)
        .ok_or_else(|| PatchbackError::ProvenanceMismatch {
            bridge_unit_id: target.bridge_unit_id.clone(),
            start_byte,
            end_byte,
            reason: format!(
                "no scene {scene_id:04} in archive directory \
                 (archive has {scene_count} populated scenes)",
                scene_count = scene_index.entries.len()
            ),
        })?;

    // Strip the producer's OUT-OF-BAND control markup (`<reallive.kidoku …>`)
    // from the translated body before encoding. That marker is a synthetic
    // readable representation of a read-flag that lives OUTSIDE the Textout
    // body (a `MetaKidoku` opcode / the header kidoku table), which the
    // re-packer carries byte-identical without any splice. Leaving the literal
    // in the spliced body is the control-markup round-trip bug. See
    // [`REALLIVE_OUT_OF_BAND_MARKER_OPEN`]. In-body protected markup (name
    // token, asset ref, font tone) is NOT stripped — it is real Textout body
    // content that re-encodes Shift-JIS byte-identical.
    let body_target_text = strip_out_of_band_control_markup(&target.target_text);
    if body_target_text.is_empty() {
        return Err(PatchbackError::ControlMarkupOnlyTarget {
            bridge_unit_id: target.bridge_unit_id.clone(),
        });
    }

    // Encode the target text per the named PatchbackOpts policy. A
    // `choice_label` (`module_sel` option) MUST be NextString-safe: a raw
    // Shift-JIS splice of a translation carrying `[` / `,` / `.` / `!` /
    // `(` … would truncate the option and let the trailing bytes be
    // misread as select structure, corrupting the command. Dialogue
    // Textout bodies have no such framing and take the plain Shift-JIS
    // slot encoding.
    let new_textout_bytes = match opts.target_encoding {
        PatchbackEncoding::ShiftJis => {
            let encoded = if unit.surface_kind == "choice_label" {
                encode_choice_option_next_string_safe(&body_target_text)
            } else {
                encode_shift_jis_slot(&body_target_text)
            };
            encoded.map_err(
                |err: ShiftJisEncodeError| PatchbackError::TargetEncodeFailure {
                    bridge_unit_id: target.bridge_unit_id.clone(),
                    message: err.message,
                },
            )?
        }
    };

    Ok(ResolvedEdit {
        scene_entry_index,
        bridge_unit_id: target.bridge_unit_id.clone(),
        surface_kind: unit.surface_kind.clone(),
        occurrence_index,
        new_textout_bytes,
    })
}

/// Parse the `(scene_id, occurrence_index)` pair out of a v0.2
/// `sourceUnitKey`. Returns `None` if the key does not match the
/// canonical `reallive:scene-NNNN#OOOO` shape.
fn parse_scene_and_occurrence(key: &str) -> Option<(u16, usize)> {
    // `reallive:scene-{scene_id:04}#{occ:04}`.
    let rest = key.strip_prefix("reallive:scene-")?;
    let (scene_str, occurrence_str) = rest.split_once('#')?;
    let scene_id = scene_str.parse::<u16>().ok()?;
    let occurrence_index = occurrence_str.parse::<usize>().ok()?;
    Some((scene_id, occurrence_index))
}

/// Remove every OUT-OF-BAND control-markup marker (`<reallive.kidoku …>`)
/// from a translated body string.
/// The markers are the producer's synthetic readable
/// representation of RealLive read-flag (kidoku) state, which is stored as a
/// separate `MetaKidoku` opcode / the scene-header kidoku table — NOT as bytes
/// inside the Textout body. The producer prepends them to `sourceText` and the
/// translation prompt reproduces every protected span inline, so a unit's
/// `target.text` carries the literal. The patchback must NOT splice it into the
/// Textout body (see [`REALLIVE_OUT_OF_BAND_MARKER_OPEN`]); the kidoku control
/// bytes are re-emitted byte-identical from the untouched bytecode instead.
/// The strip keys on the reserved marker SYNTAX rather than a specific unit's
/// `span.raw`, so it is robust to a translated body that carries any kidoku
/// index (or several) — every `<reallive.kidoku …>` run, whatever its
/// argument, is removed. A prose translation never legitimately contains the
/// reserved marker prefix.
pub fn strip_out_of_band_control_markup(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find(REALLIVE_OUT_OF_BAND_MARKER_OPEN) {
        // Everything up to the marker survives verbatim.
        out.push_str(&rest[..open]);
        let after_open = &rest[open + REALLIVE_OUT_OF_BAND_MARKER_OPEN.len()..];
        if let Some(close) = after_open.find('>') {
            // Drop `<reallive.kidoku …>` (open-prefix.. close `>` inclusive).
            rest = &after_open[close + 1..];
        } else {
            // Unterminated marker: nothing more to strip; keep the remainder
            // verbatim so we never silently truncate real content.
            out.push_str(&rest[open..]);
            return out;
        }
    }
    out.push_str(rest);
    out
}

/// True when the translated `target.text` carries NO body change versus the
/// source unit's `sourceText` — i.e. after removing the OUT-OF-BAND control
/// markup (`<reallive.kidoku …>`) from BOTH, the remaining translatable body is
/// byte-equal. Such a unit is a byte no-op: skipping it lets the re-packer carry
/// the owning scene's original blob byte-identical (no decompress/recompress).
fn is_source_identical_target(
    target: &TranslatedUnitTarget,
    unit: &kaifuu_core::LocalizationUnitV02,
) -> bool {
    strip_out_of_band_control_markup(&target.target_text)
        == strip_out_of_band_control_markup(&unit.source_text)
}


