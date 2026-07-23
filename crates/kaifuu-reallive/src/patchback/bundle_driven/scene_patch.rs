use super::*;

/// Re-emit a scene blob with the given edits applied.
/// - Parses the existing scene header.
/// - Decompresses the existing bytecode.
/// - Re-walks the decompressed bytecode via [`parse_real_bytecode`] to
///   recover authoritative `(start_byte, end_byte)` ranges for every
///   text-emitting opcode (Textout body + Choice option bytes).
/// - Matches each edit to its opcode by `occurrence_index`.
/// - Applies edits in **descending opcode-offset order** so earlier
///   splices do not shift later ones.
/// - Re-compresses the new bytecode via [`compress_avg32_literal`].
/// - Rewrites the header's `bytecode_compressed_size` field in place.
/// - Returns `[header || compressed_bytecode]` concatenation.
pub(super) fn patch_scene_blob(
    scene_id: u16,
    original_blob: &[u8],
    edits: &[ResolvedEdit],
    xor2_cipher: Option<&Xor2Cipher>,
) -> Result<Vec<u8>, PatchbackError> {
    let header = SceneHeader::parse(original_blob).map_err(|err| match err {
        SceneHeaderError::TruncatedHeader { .. } => PatchbackError::SceneHeaderInvalid {
            scene_id,
            message: err.to_string(),
        },
    })?;

    let bytecode_start = header.bytecode_offset as usize;
    // The re-emit always writes a full SCENE_HEADER_BYTE_LEN-byte header
    // and preserves bytecode_offset (0x20) verbatim. If the header
    // declares an offset *inside* the header region, the preserved offset
    // would point at header bytes while the compressed payload is written
    // at SCENE_HEADER_BYTE_LEN — any decompressor would then read bytecode
    // from inside the header and corrupt the scene. Reject it up front
    // with a typed error instead of silently emitting a corrupt blob.
    if bytecode_start < SCENE_HEADER_BYTE_LEN {
        return Err(PatchbackError::SceneHeaderInvalid {
            scene_id,
            message: format!(
                "scene header declares bytecode_offset={bytecode_start} inside the {SCENE_HEADER_BYTE_LEN}-byte header region (must be >= {SCENE_HEADER_BYTE_LEN})"
            ),
        });
    }
    let bytecode_end = bytecode_start + header.bytecode_compressed_size as usize;
    if bytecode_end > original_blob.len() {
        return Err(PatchbackError::SceneHeaderInvalid {
            scene_id,
            message: format!(
                "scene header declares bytecode_offset={bytecode_start} + compressed_size={size} past blob length {blob_len}",
                size = header.bytecode_compressed_size,
                blob_len = original_blob.len()
            ),
        });
    }
    let compressed = &original_blob[bytecode_start..bytecode_end];
    let mut decompressed = decompress_avg32(compressed, header.bytecode_uncompressed_size as usize)
        .map_err(|err| PatchbackError::DecompressFailure {
            scene_id,
            message: format!("{err}"),
        })?;

    // Second-level `xor_2`: if this scene sets `use_xor_2`, the decompressed
    // bytecode is still ciphertext over `[256, 513)`. Decrypt it with the
    // archive-recovered cipher BEFORE the re-walk/splice so the parser reads
    // real command boundaries; the same cipher re-encrypts the spliced
    // bytecode below, before recompression, so the scene stays
    // encrypted-at-rest. Self-inverse XOR, so decrypt and re-encrypt are the
    // same call.
    let xor2_cipher = if compiler_version_uses_xor2(header.compiler_version) {
        let cipher = xor2_cipher.ok_or_else(|| PatchbackError::DecompressFailure {
            scene_id,
            message: "kaifuu.reallive.patchback_xor2_missing_cipher: scene sets use_xor_2 but \
                      no xor_2 cipher was recovered for the archive"
                .to_string(),
        })?;
        cipher.apply_segment(&mut decompressed);
        Some(cipher)
    } else {
        None
    };

    // Re-walk the bytecode to recover the exact byte range of every
    // text-emitting opcode. The producer cursored
    // approximate offsets that don't survive Command-with-arglist
    // widths; the authoritative key is `occurrence_index`.
    let text_unit_positions = collect_text_unit_positions(scene_id, &decompressed)?;

    // Build occurrence-index -> position lookup. Match each edit to
    // its position; any unmatched edit surfaces a typed provenance
    // mismatch BEFORE we mutate the bytecode.
    let mut planned_splices: Vec<PlannedSplice> = Vec::with_capacity(edits.len());
    for edit in edits {
        let position = text_unit_positions
            .iter()
            .find(|pos| pos.occurrence_index == edit.occurrence_index)
            .ok_or_else(|| PatchbackError::ProvenanceMismatch {
                bridge_unit_id: edit.bridge_unit_id.clone(),
                start_byte: edit.occurrence_index as u64,
                end_byte: 0,
                reason: format!(
                    "occurrence_index {} not found in scene {scene_id:04} after bytecode re-walk \
                     ({} text positions observed)",
                    edit.occurrence_index,
                    text_unit_positions.len()
                ),
            })?;
        if position.surface_kind != edit.surface_kind {
            return Err(PatchbackError::ProvenanceMismatch {
                bridge_unit_id: edit.bridge_unit_id.clone(),
                start_byte: position.start_byte as u64,
                end_byte: position.end_byte as u64,
                reason: format!(
                    "occurrence {} surface_kind mismatch: bundle says {} but bytecode opcode at this position is {}",
                    edit.occurrence_index, edit.surface_kind, position.surface_kind
                ),
            });
        }
        planned_splices.push(PlannedSplice {
            start_byte: position.start_byte,
            end_byte: position.end_byte,
            new_bytes: edit.new_textout_bytes.clone(),
        });
    }

    // LENGTH-CHANGING SUPPORT — jump-target recalculation.
    // A text splice that changes byte length shifts every byte AFTER the
    // edit. RealLive control-flow commands (`goto`/`goto_if`/`goto_on`/
    // `goto_case`/`gosub*`/`farcall*`) carry trailing `i32 LE` pointers whose
    // value is the ABSOLUTE byte offset of the jump destination within this
    // same decompressed scene bytecode (rlvm resolves each against the scene
    // `Pointers` byte-offset table). Left untouched they would point at stale
    // offsets — into the middle of a command after a longer edit, or past a
    // now-shorter body. Re-base every pointer whose destination sits at/after
    // an edit by the cumulative delta of the splices that precede it. The
    // pointer VALUES are rewritten in place at their PRE-splice offsets; the
    // subsequent `splice` calls then carry those (already-corrected) pointer
    // bytes to their new positions verbatim (goto pointers live in Command
    // bodies, disjoint from the Textout / choice bodies being spliced, so no
    // splice range overlaps a pointer's 4 bytes).
    rebase_goto_targets(scene_id, &mut decompressed, &planned_splices)?;

    // Apply splices highest-offset-first so earlier splices don't
    // shift later ones.
    planned_splices.sort_by_key(|splice| std::cmp::Reverse(splice.start_byte));
    for splice in planned_splices {
        decompressed.splice(splice.start_byte..splice.end_byte, splice.new_bytes);
    }

    // Re-encrypt the `[256, 513)` segment of the SPLICED bytecode so the scene
    // is written back encrypted-at-rest (the retail interpreter decrypts it on
    // load exactly as it does the untouched scenes). Self-inverse with the
    // decrypt above.
    if let Some(cipher) = xor2_cipher {
        cipher.apply_segment(&mut decompressed);
    }

    // Re-compress and re-emit the blob.
    let compressed_new = compress_avg32_literal(&decompressed).map_err(|err| match err {
        CompressError::InputTooLarge { .. } | CompressError::OutputTooLarge { .. } => {
            PatchbackError::CompressFailure {
                scene_id,
                message: err.to_string(),
            }
        }
    })?;

    // Rewrite the header in place:
    // - bytecode_uncompressed_size at 0x24
    // - bytecode_compressed_size at 0x28
    let mut new_header_bytes = original_blob[..SCENE_HEADER_BYTE_LEN].to_vec();
    let new_uncompressed: u32 =
        decompressed
            .len()
            .try_into()
            .map_err(|_| PatchbackError::CompressFailure {
                scene_id,
                message: format!(
                    "patched bytecode uncompressed length {} exceeds u32::MAX",
                    decompressed.len()
                ),
            })?;
    let new_compressed: u32 =
        compressed_new
            .len()
            .try_into()
            .map_err(|_| PatchbackError::CompressFailure {
                scene_id,
                message: format!(
                    "patched bytecode compressed length {} exceeds u32::MAX",
                    compressed_new.len()
                ),
            })?;
    new_header_bytes[0x24..0x28].copy_from_slice(&new_uncompressed.to_le_bytes());
    new_header_bytes[0x28..0x2c].copy_from_slice(&new_compressed.to_le_bytes());

    // Re-emit: new header + compressed bytecode. The
    // bytecode_offset stays at its original value (most commonly the
    // immediate post-header offset, but the format allows other layouts
    // where pre-bytecode tables sit between the header and the
    // compressed payload). Preserve the bytes between the header end
    // and `bytecode_offset` verbatim so any pre-bytecode tables
    // (kidoku, etc.) survive unchanged.
    let mut output = Vec::with_capacity(bytecode_start + compressed_new.len());
    output.extend_from_slice(&new_header_bytes);
    if bytecode_start > SCENE_HEADER_BYTE_LEN {
        output.extend_from_slice(&original_blob[SCENE_HEADER_BYTE_LEN..bytecode_start]);
    }
    output.extend_from_slice(&compressed_new);
    Ok(output)
}

/// Re-base every goto-family jump-target pointer in `decompressed` for the
/// length change the `splices` introduce, writing the corrected `i32 LE`
/// value in place at each pointer's PRE-splice byte offset.
/// Coordinate space: pointer offsets and pointer target values, and the
/// splice `start_byte`/`end_byte`, are all absolute within the same
/// pre-splice decompressed bytecode stream. A splice replaces `[s, e)` with
/// `new_bytes` (length `n`), a per-splice delta of `n - (e - s)`.
/// For a jump target `T`:
/// - `T <= s` for a splice: that splice is entirely at/after `T`, so it does
///   NOT move `T` (a jump to the very start `s` of an edited element still
///   lands at the new start of the replacement text).
/// - `T >= e` for a splice: the whole edited body sits before `T`, so `T`
///   shifts by that splice's delta.
/// - `s < T < e`: the target lands strictly inside the bytes being replaced
///   — a jump into the middle of an edited text body. This is not
///   recalculable (the interior offset has no stable image), so it is a
///   typed [`PatchbackError::GotoTargetUnresolvable`] rather than a silent
///   mis-patch.
///   The corrected value is `T + Σ delta_i` over every splice with `e_i <= T`.
///   Negative sentinels (`T < 0`) and out-of-splice targets are left unchanged
///   (no splice satisfies `e_i <= T` for a negative `T`). Pointer bytes never
///   overlap a splice range (goto pointers live in Command bodies, splices in
///   Textout / choice bodies — disjoint elements), so writing at the pre-splice
///   offset and then splicing carries the corrected pointer to its new home
///   verbatim.
fn rebase_goto_targets(
    scene_id: u16,
    decompressed: &mut [u8],
    splices: &[PlannedSplice],
) -> Result<(), PatchbackError> {
    // No length change ⇒ nothing to re-base (length-preserving fast path).
    if splices
        .iter()
        .all(|s| s.new_bytes.len() == s.end_byte - s.start_byte)
    {
        return Ok(());
    }

    let sites = crate::opcode::collect_goto_pointer_sites(decompressed).map_err(|err| {
        PatchbackError::DecompressFailure {
            scene_id,
            message: format!("goto-pointer collection failed during jump recalculation: {err}"),
        }
    })?;

    for site in &sites {
        let target = site.target;
        // Negative / null sentinel: never a byte offset into this stream;
        // leave verbatim.
        if target < 0 {
            continue;
        }
        let target_usize = target as usize;

        let mut cumulative_delta: i64 = 0;
        for splice in splices {
            let delta =
                splice.new_bytes.len() as i64 - (splice.end_byte - splice.start_byte) as i64;
            if delta == 0 {
                continue;
            }
            if target_usize > splice.start_byte && target_usize < splice.end_byte {
                // Strictly inside an edited body — unresolvable.
                return Err(PatchbackError::GotoTargetUnresolvable {
                    scene_id,
                    pointer_offset: site.pointer_offset,
                    target: target as i64,
                    body_start: splice.start_byte,
                    body_end: splice.end_byte,
                });
            }
            if splice.end_byte <= target_usize {
                cumulative_delta += delta;
            }
        }

        if cumulative_delta == 0 {
            continue;
        }

        let new_target = target as i64 + cumulative_delta;
        let new_target_i32: i32 =
            new_target
                .try_into()
                .map_err(|_| PatchbackError::GotoTargetUnresolvable {
                    scene_id,
                    pointer_offset: site.pointer_offset,
                    target: target as i64,
                    body_start: 0,
                    body_end: 0,
                })?;
        let ptr = site.pointer_offset;
        decompressed[ptr..ptr + 4].copy_from_slice(&new_target_i32.to_le_bytes());
    }

    Ok(())
}

/// Authoritative byte-range record for one text-emitting opcode in a
/// scene's decompressed bytecode, recovered by re-walking the bytecode
/// with [`parse_real_bytecode`].
#[derive(Debug, Clone)]
struct TextUnitPosition {
    /// Occurrence sequence within the scene (Textout + Choice options
    /// each consume one occurrence index, in encounter order — matches
    /// the producer's `occurrence_index`).
    occurrence_index: usize,
    /// Surface kind (`"dialogue"` or `"choice_label"`).
    surface_kind: &'static str,
    /// Byte offset (within decompressed bytecode) where the text body
    /// starts.
    start_byte: usize,
    /// Byte offset (within decompressed bytecode) where the text body
    /// ends (exclusive).
    end_byte: usize,
}

/// Splice prepared from a `(ResolvedEdit, TextUnitPosition)` pair.
struct PlannedSplice {
    start_byte: usize,
    end_byte: usize,
    new_bytes: Vec<u8>,
}

/// Walk the decompressed bytecode and record exact byte ranges for
/// every text-emitting opcode. The walker mirrors the lead-byte switch
/// in [`parse_real_bytecode`] but tracks cursor positions so we can
/// pair each Textout / Choice-option with an authoritative byte range.
/// The walker is intentionally narrow: it tracks only the lead bytes
/// and element widths needed to advance past non-text opcodes. Any
/// truncation or unrecognised opener surfaces a typed
/// [`PatchbackError::DecompressFailure`] — partial walks would let
/// edits target the wrong bytes.
fn collect_text_unit_positions(
    scene_id: u16,
    decompressed: &[u8],
) -> Result<Vec<TextUnitPosition>, PatchbackError> {
    let opcodes =
        parse_real_bytecode(decompressed).map_err(|err| PatchbackError::DecompressFailure {
            scene_id,
            message: format!("scene bytecode re-walk failed: {err}"),
        })?;

    // We re-derive byte ranges by re-scanning the byte stream in
    // parallel with the opcode list. The opcode list's order matches
    // the stream's element order; we use the same lead-byte switch to
    // advance.
    let mut out: Vec<TextUnitPosition> = Vec::new();
    let mut pos: usize = 0;
    let mut occurrence: usize = 0;
    let mut opcode_iter = opcodes.iter();

    while pos < decompressed.len() {
        // Pull the next opcode for sanity (should mirror the lead-byte
        // switch perfectly). If the opcode iterator runs out before we
        // exhaust the byte stream, surface a typed error.
        let op = opcode_iter
            .next()
            .ok_or_else(|| PatchbackError::DecompressFailure {
                scene_id,
                message: format!(
                    "bytecode re-walk drift: opcode list exhausted at byte {pos} of {len}",
                    len = decompressed.len()
                ),
            })?;
        let lead = decompressed[pos];
        let (new_pos, recorded) = advance_one_element(scene_id, decompressed, pos, op, lead)?;
        if let Some((surface_kind, start_byte, end_byte)) = recorded {
            // A Textout run is only a translatable unit when its bytes are
            // readable Shift-JIS dialogue. Binary / control-byte catch-all
            // runs are NOT surfaced by the producer
            // (`collect_units` applies the same `decode_dialogue_textout`
            // gate) and must NOT consume an occurrence index here either —
            // otherwise every later unit's occurrence_index would drift and
            // edits would splice into the wrong opcode. Skipping in both
            // paths keeps the binary run out of the edit plan, so it
            // survives patchback byte-identical.
            if decode_dialogue_textout(&decompressed[start_byte..end_byte]).is_some() {
                out.push(TextUnitPosition {
                    occurrence_index: occurrence,
                    surface_kind,
                    start_byte,
                    end_byte,
                });
                occurrence += 1;
            }
        }
        if let RealLiveOpcode::Choice { choices } = op {
            // Each non-empty Choice option is one `choice_label` unit,
            // anchored at the option's authoritative scene-relative byte
            // offset captured by the decoder (`parse_arg_list` for the
            // `(…)` form, `decode_select` for the `module_sel`
            // `SelectElement` `{ … }` block form). Sourcing the positions
            // from the typed `choices` keeps this patch-back re-walk
            // identical to the bridge producer (`bridge.rs`) for BOTH
            // framings — the previous `(arg0, arg1, …)` byte re-scan was
            // correct only for the comma form and would mis-anchor every
            // `{ … }` select option.
            for choice in choices {
                // A choice option is a translatable unit only when its bytes
                // decode as readable Shift-JIS dialogue (`decode_dialogue_textout`
                // — valid decode AND no control bytes). `None` covers an empty
                // interior `,,` segment AND a non-dialogue option such as an
                // rlBabel `###PRINT(<expr>)` runtime interpolation (compiled
                // expression bytes, not static text). The bridge producer
                // (`collect_units`) applies the SAME gate, so both paths skip
                // the identical options and the occurrence_index never drifts.
                if decode_dialogue_textout(&choice.bytes).is_none() {
                    continue;
                }
                let start_byte = choice.byte_offset as usize;
                let end_byte = start_byte + choice.bytes.len();
                out.push(TextUnitPosition {
                    occurrence_index: occurrence,
                    surface_kind: "choice_label",
                    start_byte,
                    end_byte,
                });
                occurrence += 1;
            }
        }
        if new_pos <= pos {
            // No forward progress: defensive guard against infinite
            // loops on a malformed stream.
            return Err(PatchbackError::DecompressFailure {
                scene_id,
                message: format!(
                    "bytecode re-walk made no forward progress at byte {pos}; \
                     opcode={label}",
                    label = op.label()
                ),
            });
        }
        pos = new_pos;
    }
    Ok(out)
}

/// Returned by [`advance_one_element`] when the advanced-past element
/// was a Textout — carries the surface-kind tag plus the body byte
/// range. `None` for every other element (Meta, Command, Expression,
/// Unknown).
type AdvancedTextRange = Option<(&'static str, usize, usize)>;

/// Advance one element in the byte stream. Returns the new byte
/// position and (if the element was a Textout) the `(surface_kind,
/// start, end)` of its body bytes.
fn advance_one_element(
    scene_id: u16,
    bytes: &[u8],
    pos: usize,
    op: &RealLiveOpcode,
    _lead: u8,
) -> Result<(usize, AdvancedTextRange), PatchbackError> {
    // Drive off the single source-of-truth element decoder so the re-walk
    // cursor can never drift from `parse_real_bytecode`'s boundaries.
    let (_decoded, consumed) = crate::opcode::decode_element(bytes, pos).map_err(|err| {
        PatchbackError::DecompressFailure {
            scene_id,
            message: format!("bytecode re-walk failed to decode element at byte {pos}: {err}"),
        }
    })?;
    let new_pos = pos + consumed;
    // A Textout carries a dialogue surface; every other element kind does
    // not. The caller's `op` and the freshly decoded element agree
    // because both originate from the same decoder.
    let recorded = match op {
        RealLiveOpcode::Textout { .. } => Some(("dialogue", pos, new_pos)),
        _ => None,
    };
    Ok((new_pos, recorded))
}
