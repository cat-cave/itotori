//! KAIFUU-210 — Real Sweetie HD scene bytecode → v0.2 BridgeBundle
//! producer.
//!
//! Walks a [`Vec<RealLiveOpcode>`] (from [`parse_real_bytecode`]) into a
//! [`kaifuu_core::BridgeBundleV02`] keyed against the v0.2 schema:
//!
//! - Each [`RealLiveOpcode::Textout`] / [`RealLiveOpcode::TextDisplay`] /
//!   [`RealLiveOpcode::CharacterTextDisplay`] yields one `dialogue` unit.
//! - Each choice in a [`RealLiveOpcode::Choice`] yields one `choice_label`
//!   unit.
//! - Per-unit protected spans are computed from the **surrounding**
//!   control bytes that the opcode walker saw before the text body:
//!     * `MetaKidoku` markers → `parsedName = "reallive.kidoku"`.
//!     * Inline name-token bytes (Shift-JIS bracket-enclosed speaker
//!       prefix) → `parsedName = "reallive.name_token"`.
//!     * Choice-marker bytes (`0x30..0x34`) → `parsedName = "reallive.choice_marker"`.
//!     * Font-tone bytes (`#FONT_*` Shift-JIS tag run) →
//!       `parsedName = "reallive.font_tone"`.
//!     * Asset-ref tags (`#FACE`, `#GANBMP`) → `parsedName = "reallive.asset_ref"`.
//!
//!   The control bytes are surfaced as inline `<reallive.kidoku N>`-style
//!   markers prepended to the Shift-JIS-decoded text body, so the v0.2
//!   schema's "span byte range must match sourceText" invariant holds.
//! - Speaker resolution: looks up the NAMAE Gameexe table; an entry whose
//!   value matches the inline name-token text resolves the unit's
//!   speaker. A missing match emits `knowledgeState = "parser_unknown"`
//!   carrying the raw nametoken text, never an error.
//! - Voice-line refs: a [`RealLiveOpcode::VoicePlay`] that follows a
//!   text unit before the next text from a different speaker slot is
//!   attached to the preceding text unit's `runtimeExpectation.traceKey`
//!   payload as a `z<NNNN>` archive id.
//! - Provenance: each unit's `sourceLocation.range` is anchored in the
//!   **decompressed bytecode stream** — the same space
//!   [`parse_real_bytecode`] and the KAIFUU-211 patchback re-walk
//!   operate in ("caller owns decompression"). The owning scene is
//!   identified by its scene id (`containerKey` / `sourceUnitKey`),
//!   never by adding a decompressed cursor to a compressed file offset:
//!   that earlier mixing pushed any unit whose decompressed offset
//!   exceeded its scene's compressed `byte_len` into a *later* scene.
//!
//! Empty scene → typed [`BridgeProduceError::EmptyScene`] (no silent
//! `Ok(empty bundle)`).

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;

use kaifuu_core::{BRIDGE_SCHEMA_VERSION_V02, BridgeBundleV02, BridgeContractValidationError};

use crate::gameexe::{GameexeInventoryReport, GameexeKeyFamily};
use crate::opcode::{
    RealLiveOpcode, RealLiveParseError, decode_dialogue_textout, parse_real_bytecode_spans,
};

/// Caller-supplied knobs for [`produce_bundle`].
///
/// All fields are required; there are no silent defaults that would
/// hide a mis-specified call site.
#[derive(Debug, Clone)]
pub struct BridgeOpts<'a> {
    /// Stable game id (e.g. `"sweetie-hd"`).
    pub game_id: &'a str,
    /// Human-readable game version label.
    pub game_version: &'a str,
    /// Source-profile id (stable per kaifuu extractor profile).
    pub source_profile_id: &'a str,
    /// Source locale tag for the decoded text (`"ja-JP"` for Sweetie HD).
    pub source_locale: &'a str,
    /// Extractor name embedded in `extractor.name`.
    pub extractor_name: &'a str,
    /// Extractor version embedded in `extractor.version`.
    pub extractor_version: &'a str,
    /// Number of kidoku-table entries declared in the scene header.
    /// Sweetie HD's scene 1 declares `kidoku_count = 1` even though no
    /// inline `0x40` MetaKidoku markers appear in the decompressed
    /// bytecode — RealLive's kidoku read-tracking is table-driven, not
    /// always inline. When `> 0` and the inline walk produced no
    /// MetaKidoku markers, the bridge producer synthesises a single
    /// `reallive.kidoku` span on the first text unit so the read-
    /// tracking surface is represented in the bundle.
    pub scene_kidoku_count: u32,
}

/// Fatal errors raised by [`produce_bundle`].
#[derive(Debug, Clone, Error)]
pub enum BridgeProduceError {
    /// The scene decoded to zero opcodes.
    #[error("kaifuu.reallive.bridge.empty_scene: scene {scene_id} produced no opcodes")]
    EmptyScene { scene_id: u16 },
    /// The scene decoded cleanly but contained no
    /// Textout/TextDisplay/Choice opcodes — refusing to emit an empty
    /// bundle keeps the contract honest.
    #[error(
        "kaifuu.reallive.bridge.no_text_units: scene {scene_id} decoded to {opcode_count} opcodes but no Textout/TextDisplay/Choice"
    )]
    NoTextUnits { scene_id: u16, opcode_count: usize },
    /// Wrapped bytecode parse error.
    #[error("kaifuu.reallive.bridge.bytecode_parse: {0}")]
    BytecodeParse(#[from] RealLiveParseError),
    /// Wrapped schema validation error. Surfaced when the producer
    /// builds a JSON value that fails [`BridgeBundleV02::validate_json`]
    /// — this is a producer-internal regression, not a user-facing
    /// bug.
    #[error("kaifuu.reallive.bridge.schema_validation: {0}")]
    SchemaValidation(String),
    /// A computed protected span (kidoku / name_token / asset_ref /
    /// font_tone) failed its byte-range / raw-bytes equality check
    /// against the wrapped `sourceText`. The 100%-fidelity contract
    /// forbids silently dropping it (that would let a translate+patchback
    /// pass rewrite a protected `#FACE(...)` / `【NAMAE】` region) — the
    /// mismatch is surfaced as a producer regression instead.
    #[error(
        "kaifuu.reallive.bridge.protected_span_invalid: scene {scene_id} unit {occurrence_index} span #{span_index} (parsedName={parsed_name}) byte range {start_byte}..{end_byte} does not match sourceText: {reason}"
    )]
    ProtectedSpanInvalid {
        scene_id: u16,
        occurrence_index: usize,
        span_index: usize,
        parsed_name: &'static str,
        start_byte: u64,
        end_byte: u64,
        reason: String,
    },
}

impl From<BridgeContractValidationError> for BridgeProduceError {
    fn from(value: BridgeContractValidationError) -> Self {
        Self::SchemaValidation(value.to_string())
    }
}

/// Output of [`produce_bundle`].
///
/// `bundle` is the typed [`BridgeBundleV02`] returned by the v0.2
/// validator; `json` is the raw `serde_json::Value` payload the
/// validator accepted. Both are returned because [`BridgeBundleV02`]
/// derives `Deserialize` only — callers writing a JSON file want the
/// validated `Value`.
#[derive(Debug, Clone)]
pub struct ProducedBundle {
    pub bundle: BridgeBundleV02,
    pub json: Value,
}

/// Walk a scene's decompressed bytecode into a v0.2 BridgeBundle.
///
/// `scene_id` is the 1-based scene index (matches the SEEN.TXT slot
/// index); `scene_bytes` is the raw scene blob (header + compressed
/// bytecode) the archive layer handed us; `decompressed_bytecode` is the
/// post-AVG32 bytecode the caller already produced;
/// `gameexe_inventory` is the parsed Gameexe.ini key inventory used for
/// NAMAE speaker resolution.
pub fn produce_bundle(
    scene_id: u16,
    scene_bytes: &[u8],
    decompressed_bytecode: &[u8],
    gameexe_inventory: &GameexeInventoryReport,
    opts: &BridgeOpts<'_>,
) -> Result<ProducedBundle, BridgeProduceError> {
    if decompressed_bytecode.is_empty() {
        return Err(BridgeProduceError::EmptyScene { scene_id });
    }
    // Drive the provenance cursor off the authoritative width-carrying
    // decode: each element's byte width is exactly what the single
    // source of truth `decode_element` / `decode_command` consumed. The
    // producer must NOT re-derive widths from a hand-maintained table —
    // that table silently drifted (undercounting every command at 8) and
    // mis-placed each unit's `decompressed_byte_offset`.
    let opcode_spans = parse_real_bytecode_spans(decompressed_bytecode)?;
    if opcode_spans.is_empty() {
        return Err(BridgeProduceError::EmptyScene { scene_id });
    }
    let units = collect_units(scene_id, &opcode_spans, gameexe_inventory, opts);
    if units.is_empty() {
        return Err(BridgeProduceError::NoTextUnits {
            scene_id,
            opcode_count: opcode_spans.len(),
        });
    }
    let json = build_bundle_json(scene_id, scene_bytes, &units, opts)?;
    let bundle = BridgeBundleV02::validate_json(&json)?;
    Ok(ProducedBundle { bundle, json })
}

// ---------------------------------------------------------------------
// Unit collection
// ---------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ProtoUnit {
    /// `dialogue` | `choice_label`.
    surface_kind: &'static str,
    /// Raw decoded text body (UTF-8, post-Shift-JIS-decode).
    decoded_text: String,
    /// Inline control-marker prefix prepended to `sourceText` to keep
    /// span byte ranges valid (`<reallive.kidoku N>` etc.).
    control_prefix: String,
    /// Computed protected spans (anchored against the wrapped
    /// `sourceText` UTF-8 bytes).
    spans: Vec<ProtoSpan>,
    /// Resolved speaker text, if any (raw nametoken contents).
    raw_speaker: Option<String>,
    /// Scene-blob-relative byte offset of the text-display body.
    decompressed_byte_offset: u64,
    /// Length of the text-display body bytes (in the decompressed
    /// bytecode).
    decompressed_byte_len: u64,
    /// Look-ahead-pinned voice-line ref (archive id like `z0001`).
    voice_archive_id: Option<String>,
    /// Look-ahead-pinned voice-line sample id.
    voice_sample_id: Option<u32>,
    /// Per-unit occurrence sequence number (0-based across the scene).
    occurrence_index: usize,
    /// Choice-group sequence number (only set for `choice_label`).
    choice_group_index: Option<usize>,
    /// Choice option index within its group.
    choice_option_index: Option<usize>,
}

#[derive(Debug, Clone)]
struct ProtoSpan {
    /// Parsed name on the v0.2 span (e.g. `"reallive.kidoku"`).
    parsed_name: &'static str,
    /// Raw byte range within the wrapped UTF-8 sourceText.
    start_byte: u64,
    /// End byte (exclusive).
    end_byte: u64,
    /// Raw substring.
    raw: String,
}

fn collect_units(
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
                    let asset_ref_spans =
                        extract_asset_ref_spans(&decoded, control_prefix.len() as u64);
                    let font_tone_spans =
                        extract_font_tone_spans(&decoded, control_prefix.len() as u64);
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
                        decompressed_byte_offset: cursor,
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
            RealLiveOpcode::VoicePlay { voice_id } => {
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
            // Non-emitting opcodes (no translatable unit). Notably
            // `TextDisplay` / `CharacterTextDisplay` carry no raw text body in
            // the parsed opcode — they serve as markers and the inline
            // Shift-JIS run that follows lands as `Textout`, which emits the
            // unit — so they, like every other opcode here, are a no-op.
            _ => {}
        }
        cursor = cursor.saturating_add(width as u64);
        let _ = idx; // kept for future per-opcode diagnostics
    }

    // Resolve speakers through NAMAE.
    //
    // Pass 1: per-unit scan — every dialogue unit's decoded text is
    // checked for an inline NAMAE display-name occurrence. When the
    // walker has already pinned a raw_speaker from a `【...】`
    // name-token bracket, normalise it through the NAMAE table.
    //
    // Pass 2 (best-effort fallback): when the per-unit scan finds no
    // match for any unit AND the NAMAE table is populated, attribute
    // the first dialogue unit to the first NAMAE display name. This
    // surfaces NAMAE resolution as `parser_unknown` carrying
    // `rawSpeakerText` — the v0.2 schema's documented shape for
    // "speaker is known to exist but the per-line attribution is
    // uncertain" — so the runtime/QA loop can refine the attribution
    // later. The fallback is bounded to **one** unit per scene so the
    // bundle never claims a speaker for lines that aren't dialogue.
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
    let mut per_unit_match = false;
    for unit in &mut units {
        if unit.raw_speaker.is_none()
            && unit.surface_kind == "dialogue"
            && let Some(matched) = namae_values
                .iter()
                .find(|value| !value.is_empty() && unit.decoded_text.contains(value.as_str()))
        {
            unit.raw_speaker = Some(matched.clone());
            per_unit_match = true;
        }
    }
    if !per_unit_match
        && let Some(first_namae) = namae_values.first()
        && let Some(unit) = units
            .iter_mut()
            .find(|unit| unit.surface_kind == "dialogue")
    {
        unit.raw_speaker = Some(first_namae.clone());
    }
    for unit in &mut units {
        if let Some(speaker) = unit.raw_speaker.clone() {
            unit.raw_speaker = Some(normalize_speaker(&speaker, gameexe_inventory));
        }
    }

    // Synthesise a reallive.kidoku span when the scene header declares
    // kidoku entries but the inline walk produced none. RealLive's
    // read-tracking is table-driven for Sukara-branch titles; the
    // declared count is the canonical proof a kidoku surface exists.
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
                start_byte: start,
                end_byte: end,
                raw: marker,
            },
        );
        unit.control_prefix = new_prefix;
    }

    units
}

#[derive(Debug, Clone)]
struct PendingMarker {
    parsed_name: &'static str,
    label: String,
}

fn build_control_prefix(
    pending: &mut Vec<PendingMarker>,
    _decoded_body: &str,
) -> (String, Vec<ProtoSpan>) {
    if pending.is_empty() {
        return (String::new(), Vec::new());
    }
    let mut prefix = String::new();
    let mut spans: Vec<ProtoSpan> = Vec::new();
    for marker in pending.drain(..) {
        let start = prefix.len() as u64;
        prefix.push_str(&marker.label);
        let end = prefix.len() as u64;
        spans.push(ProtoSpan {
            parsed_name: marker.parsed_name,
            start_byte: start,
            end_byte: end,
            raw: marker.label,
        });
    }
    (prefix, spans)
}

fn extract_name_token_spans(decoded: &str, prefix_offset: u64) -> (Option<String>, Vec<ProtoSpan>) {
    // Sweetie HD name tokens appear as `【話者】` (full-width bracketed)
    // or `「話者」`. We look for the first occurrence and pin a span
    // around it.
    let candidates = [('【', '】'), ('「', '」')];
    for (open, close) in candidates {
        if let Some(open_pos) = decoded.find(open)
            && let Some(close_offset) = decoded[open_pos + open.len_utf8()..].find(close)
        {
            let close_pos = open_pos + open.len_utf8() + close_offset + close.len_utf8();
            let raw_speaker =
                decoded[open_pos + open.len_utf8()..close_pos - close.len_utf8()].to_string();
            let raw_bracketed = decoded[open_pos..close_pos].to_string();
            let span = ProtoSpan {
                parsed_name: "reallive.name_token",
                start_byte: prefix_offset + open_pos as u64,
                end_byte: prefix_offset + close_pos as u64,
                raw: raw_bracketed,
            };
            return (Some(raw_speaker), vec![span]);
        }
    }
    (None, Vec::new())
}

fn extract_asset_ref_spans(decoded: &str, prefix_offset: u64) -> Vec<ProtoSpan> {
    // `#FACE(...)` and `#GANBMP(...)` inline asset-ref tags. Match the
    // tag name and any immediately-following `(...)` arg group.
    let mut spans = Vec::new();
    for tag in ["#FACE", "#GANBMP"] {
        let mut start = 0usize;
        while let Some(rel) = decoded[start..].find(tag) {
            let tag_start = start + rel;
            let mut tag_end = tag_start + tag.len();
            // Optional bracketed arg list.
            if decoded[tag_end..].starts_with('(')
                && let Some(close_rel) = decoded[tag_end..].find(')')
            {
                tag_end += close_rel + 1;
            }
            let raw = decoded[tag_start..tag_end].to_string();
            spans.push(ProtoSpan {
                parsed_name: "reallive.asset_ref",
                start_byte: prefix_offset + tag_start as u64,
                end_byte: prefix_offset + tag_end as u64,
                raw,
            });
            start = tag_end;
        }
    }
    spans
}

fn extract_font_tone_spans(decoded: &str, prefix_offset: u64) -> Vec<ProtoSpan> {
    // Font-tone tags such as `#FONT_BIG` or `#COLOR(123)` — keep the
    // scan narrow to the documented Sweetie HD vocabulary.
    let mut spans = Vec::new();
    for tag in ["#FONT_BIG", "#FONT_SMALL", "#COLOR"] {
        let mut start = 0usize;
        while let Some(rel) = decoded[start..].find(tag) {
            let tag_start = start + rel;
            let mut tag_end = tag_start + tag.len();
            if decoded[tag_end..].starts_with('(')
                && let Some(close_rel) = decoded[tag_end..].find(')')
            {
                tag_end += close_rel + 1;
            }
            let raw = decoded[tag_start..tag_end].to_string();
            spans.push(ProtoSpan {
                parsed_name: "reallive.font_tone",
                start_byte: prefix_offset + tag_start as u64,
                end_byte: prefix_offset + tag_end as u64,
                raw,
            });
            start = tag_end;
        }
    }
    spans
}

fn extract_choice_marker_spans(
    raw_bytes: &[u8],
    decoded: &str,
    prefix_offset: u64,
) -> Vec<ProtoSpan> {
    // Choice markers are control bytes `0x30..0x34` per spec — when
    // present they survive Shift-JIS decode as ASCII digits `'0'..'4'`.
    let mut spans = Vec::new();
    for byte in [0x30u8, 0x31, 0x32, 0x33] {
        let ch = byte as char;
        // Only match the first one to keep the span set bounded.
        if raw_bytes.contains(&byte)
            && let Some(pos) = decoded.find(ch)
        {
            spans.push(ProtoSpan {
                parsed_name: "reallive.choice_marker",
                start_byte: prefix_offset + pos as u64,
                end_byte: prefix_offset + pos as u64 + 1,
                raw: ch.to_string(),
            });
            break;
        }
    }
    spans
}

fn normalize_speaker(raw: &str, gameexe_inventory: &GameexeInventoryReport) -> String {
    // Walk the NAMAE entries; if any entry's value contains the raw
    // speaker text, surface the canonical NAMAE value.
    for entry in &gameexe_inventory.entries {
        if matches!(entry.family, GameexeKeyFamily::Namae) && entry.value.contains(raw) {
            return entry.value.clone();
        }
    }
    raw.to_string()
}

// ---------------------------------------------------------------------
// JSON bundle assembly
// ---------------------------------------------------------------------

fn build_bundle_json(
    scene_id: u16,
    scene_bytes: &[u8],
    units: &[ProtoUnit],
    opts: &BridgeOpts<'_>,
) -> Result<Value, BridgeProduceError> {
    let bundle_namespace = format!(
        "reallive-bridge:game-id={}:source-profile-id={}:scene={scene_id:04}",
        opts.game_id, opts.source_profile_id
    );
    let scene_blob_hash = sha256_canonical(scene_bytes);
    let revision_id = deterministic_uuid7(&bundle_namespace, "scene-revision");

    let asset_id = deterministic_uuid7(&bundle_namespace, "scene-asset");
    let asset_key = format!("reallive:scene-{scene_id:04}");

    let bridge_id = deterministic_uuid7(&bundle_namespace, "bundle");
    let source_profile_revision_id =
        deterministic_uuid7(&bundle_namespace, "source-profile-revision");
    let source_profile_hash = sha256_canonical(opts.source_profile_id.as_bytes());

    let assets = json!([
        {
            "assetId": asset_id,
            "assetKey": asset_key,
            "assetKind": "script",
            "sourceHash": scene_blob_hash,
            "sourceRevision": {
                "revisionId": revision_id,
                "revisionKind": "content_hash",
                "value": scene_blob_hash,
            },
            "path": format!("REALLIVEDATA/Seen.txt#scene-{scene_id:04}"),
        }
    ]);

    let units_json: Vec<Value> = units
        .iter()
        .map(|unit| {
            build_unit_json(
                scene_id,
                &asset_id,
                &asset_key,
                &revision_id,
                &scene_blob_hash,
                &bundle_namespace,
                opts,
                unit,
            )
        })
        .collect::<Result<Vec<Value>, BridgeProduceError>>()?;

    Ok(json!({
        "schemaVersion": BRIDGE_SCHEMA_VERSION_V02,
        "bridgeId": bridge_id,
        "sourceGame": {
            "gameId": opts.game_id,
            "gameVersion": opts.game_version,
            "sourceProfileId": opts.source_profile_id,
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
        "sourceLocale": opts.source_locale,
        "hashStrategy": {
            "sourceProfile": {
                "scope": "source_profile",
                "algorithm": "sha256",
                "normalization": "utf8-nfc-lf-json-stable-v1",
            },
            "sourceBundle": {
                "scope": "source_bundle",
                "algorithm": "sha256",
                "normalization": "utf8-nfc-lf-json-stable-v1",
            },
            "sourceAsset": {
                "scope": "source_asset",
                "algorithm": "sha256",
                "normalization": "bytes",
            },
            "sourceUnit": {
                "scope": "source_unit",
                "algorithm": "sha256",
                "normalization": "utf8-nfc-lf-json-stable-v1",
                "fields": ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
            },
            "patchExport": {
                "scope": "patch_export",
                "algorithm": "sha256",
                "normalization": "utf8-nfc-lf-json-stable-v1",
            },
            "deltaPackage": {
                "scope": "delta_package",
                "algorithm": "sha256",
                "normalization": "utf8-nfc-lf-json-stable-v1",
            },
        },
        "extractor": {
            "name": opts.extractor_name,
            "version": opts.extractor_version,
        },
        "assets": assets,
        "units": units_json,
        "policyRecords": [],
    }))
}

// reason: cohesive bridge-unit JSON builder over distinct wire fields; a params struct would relocate the arity without clarity.
#[allow(clippy::too_many_arguments)]
fn build_unit_json(
    scene_id: u16,
    asset_id: &str,
    asset_key: &str,
    revision_id: &str,
    scene_blob_hash: &str,
    namespace: &str,
    opts: &BridgeOpts<'_>,
    unit: &ProtoUnit,
) -> Result<Value, BridgeProduceError> {
    let source_text = format!("{}{}", unit.control_prefix, unit.decoded_text);
    let bridge_unit_id = deterministic_uuid7(namespace, &format!("unit-{}", unit.occurrence_index));
    let surface_id = deterministic_uuid7(namespace, &format!("surface-{}", unit.occurrence_index));
    let source_unit_key = format!(
        "reallive:scene-{scene_id:04}#{occ:04}",
        occ = unit.occurrence_index
    );
    let occurrence_id = format!("scene-{scene_id:04}-occ-{:04}", unit.occurrence_index);

    let source_hash = sha256_canonical(source_text.as_bytes());

    let mut spans_json: Vec<Value> = Vec::new();
    for (idx, span) in unit.spans.iter().enumerate() {
        // Validate the span byte range matches the wrapped source text. A
        // failure is a producer regression (an off-by-one in the span
        // arithmetic, or a span that no longer covers its protected
        // region), NOT something to silently drop: dropping it would lose
        // the `preserveMode=exact` guard and let a translate+patchback
        // pass rewrite a protected `#FACE(...)` / `【NAMAE】` region. Surface
        // a typed error per the 100%-fidelity contract.
        if span.end_byte as usize > source_text.len() {
            return Err(BridgeProduceError::ProtectedSpanInvalid {
                scene_id,
                occurrence_index: unit.occurrence_index,
                span_index: idx,
                parsed_name: span.parsed_name,
                start_byte: span.start_byte,
                end_byte: span.end_byte,
                reason: format!(
                    "end_byte {} exceeds sourceText length {}",
                    span.end_byte,
                    source_text.len()
                ),
            });
        }
        let actual = &source_text.as_bytes()[span.start_byte as usize..span.end_byte as usize];
        if actual != span.raw.as_bytes() {
            return Err(BridgeProduceError::ProtectedSpanInvalid {
                scene_id,
                occurrence_index: unit.occurrence_index,
                span_index: idx,
                parsed_name: span.parsed_name,
                start_byte: span.start_byte,
                end_byte: span.end_byte,
                reason: format!(
                    "byte range covers {:?} but span.raw is {:?}",
                    String::from_utf8_lossy(actual),
                    span.raw
                ),
            });
        }
        spans_json.push(json!({
            "spanId": deterministic_uuid7(namespace, &format!("span-{}-{}", unit.occurrence_index, idx)),
            "spanKind": "control_markup",
            "raw": span.raw,
            "startByte": span.start_byte,
            "endByte": span.end_byte,
            "preserveMode": "exact",
            "parsedName": span.parsed_name,
        }));
    }

    // `range` is a DECOMPRESSED-bytecode-stream interval — the only
    // honest per-unit coordinate, since a unit has no fixed offset
    // inside the LZSS-compressed scene blob. We must NOT add the scene's
    // compressed file offset here: a unit whose decompressed offset
    // exceeds its scene's compressed `byte_len` would then resolve into
    // a later scene during patchback. The owning scene is recovered from
    // `containerKey` / `sourceUnitKey` (its scene id), not from this
    // range.
    let unit_decompressed_start = unit.decompressed_byte_offset;
    let unit_decompressed_end =
        unit_decompressed_start.saturating_add(unit.decompressed_byte_len.max(1));

    let source_location = json!({
        "containerKey": format!("reallive:scene-{scene_id:04}"),
        "entryPath": [
            "scene",
            format!("{scene_id:04}"),
            "units",
            format!("{:04}", unit.occurrence_index),
        ],
        "range": {
            "startByte": unit_decompressed_start,
            "endByte": unit_decompressed_end,
        },
    });

    let speaker = match (&unit.raw_speaker, unit.surface_kind) {
        (Some(speaker), "dialogue") => json!({
            "knowledgeState": "parser_unknown",
            "rawSpeakerText": speaker,
            "evidence": "namae_lookup_or_inline_name_token",
        }),
        _ => json!({"knowledgeState": "not_applicable"}),
    };

    let context = match unit.surface_kind {
        "choice_label" => {
            let group = unit.choice_group_index.unwrap_or(0);
            let option = unit.choice_option_index.unwrap_or(0);
            json!({
                "choice": {
                    "choiceGroupId": deterministic_uuid7(
                        namespace,
                        &format!("choice-group-{group}")
                    ),
                    "choiceId": deterministic_uuid7(
                        namespace,
                        &format!("choice-{group}-{option}")
                    ),
                    "optionIndex": option,
                },
                "route": {
                    "sceneKey": format!("scene-{scene_id:04}"),
                    "position": format!("choice-{group}-{option}"),
                },
            })
        }
        _ => json!({
            "route": {
                "sceneKey": format!("scene-{scene_id:04}"),
                "position": format!("line-{:04}", unit.occurrence_index),
            },
        }),
    };

    let mut runtime_expectation = json!({
        "expectationKind": "trace_text",
        "traceKey": occurrence_id.clone(),
    });
    if let (Some(archive_id), Some(sample_id)) = (&unit.voice_archive_id, unit.voice_sample_id) {
        runtime_expectation = json!({
            "expectationKind": "trace_text",
            "traceKey": format!("{occurrence_id}#voice={archive_id}:{sample_id}"),
        });
    }

    Ok(json!({
        "bridgeUnitId": bridge_unit_id,
        "surfaceId": surface_id,
        "surfaceKind": unit.surface_kind,
        "sourceUnitKey": source_unit_key,
        "occurrenceId": occurrence_id,
        "sourceLocale": opts.source_locale,
        "sourceText": source_text,
        "sourceHash": source_hash,
        "sourceRevision": {
            "revisionId": revision_id,
            "revisionKind": "content_hash",
            "value": scene_blob_hash,
        },
        "sourceAssetRef": {
            "assetId": asset_id,
            "assetKey": asset_key,
        },
        "sourceLocation": source_location,
        "speaker": speaker,
        "context": context,
        "spans": spans_json,
        "patchRef": {
            "assetId": asset_id,
            "writeMode": "replace",
            "sourceUnitKey": source_unit_key,
            "sourceRevision": {
                "revisionId": revision_id,
                "revisionKind": "content_hash",
                "value": scene_blob_hash,
            },
        },
        "runtimeExpectation": runtime_expectation,
    }))
}

// ---------------------------------------------------------------------
// Deterministic identifiers
// ---------------------------------------------------------------------

fn sha256_canonical(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in &digest {
        let _ = write!(hex, "{byte:02x}");
    }
    format!("sha256:{hex}")
}

/// Produce a deterministic UUID7-shaped string from `(namespace, role)`.
///
/// UUID7's structural constraints (`version=7` at byte 14,
/// `variant ∈ {8,9,a,b}` at byte 19) are satisfied by truncating a
/// SHA-256 digest of `namespace || ':' || role` and overlaying the
/// version/variant nibbles. The remaining bytes are random-from-hash
/// hex which is sufficient for our schema-validation needs (UUID7's
/// time-ordered ms-prefix property is not consumed by this producer).
fn deterministic_uuid7(namespace: &str, role: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(namespace.as_bytes());
    hasher.update(b":");
    hasher.update(role.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // Force version=7 at byte 6 (UUID layout: nibble at byte 6 high
    // nibble carries version).
    bytes[6] = (bytes[6] & 0x0F) | 0x70;
    // Force variant = 10xx at byte 8 (top two bits).
    bytes[8] = (bytes[8] & 0x3F) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gameexe::parse_gameexe_inventory;

    fn opts_for_test() -> BridgeOpts<'static> {
        BridgeOpts {
            game_id: "synthetic-bridge-test",
            game_version: "test",
            source_profile_id: "kaifuu-reallive-synthetic-bridge-test",
            source_locale: "ja-JP",
            extractor_name: "kaifuu-reallive-bridge",
            extractor_version: "0.1.0",
            scene_kidoku_count: 0,
        }
    }

    #[test]
    fn empty_decompressed_bytecode_raises_typed_empty_scene_not_silent_ok() {
        let report = parse_gameexe_inventory(b"");
        let err = produce_bundle(1, &[0u8; 32], &[], &report, &opts_for_test())
            .expect_err("empty decompressed must error");
        assert!(matches!(
            err,
            BridgeProduceError::EmptyScene { scene_id: 1 }
        ));
    }

    #[test]
    fn meta_only_scene_surfaces_no_text_units_not_empty_bundle() {
        // MetaLine(2), MetaLine(3), MetaEntrypoint(0).
        let bytecode = &[0x0a, 0x02, 0x00, 0x0a, 0x03, 0x00, 0x21, 0x00, 0x00];
        let report = parse_gameexe_inventory(b"");
        let err = produce_bundle(1, &[0u8; 32], bytecode, &report, &opts_for_test())
            .expect_err("meta-only bytecode produces no text units");
        assert!(matches!(err, BridgeProduceError::NoTextUnits { .. }));
    }

    #[test]
    fn shift_jis_textout_emits_dialogue_unit_with_decoded_source_text() {
        // Shift-JIS for "ハ" (0x83 0x6E) followed by MetaLine to bound.
        let bytecode = &[0x83, 0x6E, 0x0a, 0x05, 0x00];
        let report = parse_gameexe_inventory(b"");
        let produced = produce_bundle(1, &[0u8; 32], bytecode, &report, &opts_for_test())
            .expect("textout must produce a dialogue unit");
        assert_eq!(produced.bundle.units.len(), 1);
        let unit = &produced.bundle.units[0];
        assert_eq!(unit.surface_kind, "dialogue");
        assert!(unit.source_text.contains('ハ'));
    }

    #[test]
    fn kidoku_marker_before_textout_emits_protected_span_kind_reallive_kidoku() {
        // MetaKidoku(42), Shift-JIS textout, MetaLine to bound.
        let bytecode = &[0x40, 0x2a, 0x00, 0x83, 0x6E, 0x0a, 0x05, 0x00];
        let report = parse_gameexe_inventory(b"");
        let produced = produce_bundle(1, &[0u8; 32], bytecode, &report, &opts_for_test())
            .expect("kidoku+textout must produce a unit");
        let unit_json = &produced.json["units"][0];
        let spans = unit_json["spans"].as_array().expect("spans array present");
        assert!(
            spans
                .iter()
                .any(|span| span["parsedName"] == "reallive.kidoku"),
            "at least one span with parsedName=reallive.kidoku must be emitted; got {spans:?}"
        );
    }

    #[test]
    fn provenance_byte_range_is_a_decompressed_stream_interval_not_a_file_offset() {
        // The first (and only) text unit starts at decompressed offset 0.
        // The range must be a pure decompressed-stream interval — NOT
        // anchored at any scene blob file offset (the prior bug added the
        // file offset, which pushed deep units into a later scene during
        // patchback).
        let bytecode = &[0x83, 0x6E, 0x0a, 0x05, 0x00];
        let report = parse_gameexe_inventory(b"");
        let produced = produce_bundle(1, &[0u8; 32], bytecode, &report, &opts_for_test())
            .expect("textout must produce a dialogue unit");
        let range = &produced.json["units"][0]["sourceLocation"]["range"];
        let start = range["startByte"].as_u64().expect("startByte u64");
        let end = range["endByte"].as_u64().expect("endByte u64");
        assert_eq!(
            start, 0,
            "first unit must start at decompressed offset 0, not a file offset; got {start:#x}"
        );
        assert!(
            end > start && end <= bytecode.len() as u64,
            "range must be a positive-width interval inside the decompressed bytecode; got {start}..{end}"
        );
    }

    #[test]
    fn empty_choice_option_does_not_drift_occurrence_index_of_later_units() {
        // Bytecode: Textout(ハ), select{ "A", <empty>, "B" }, Textout(ニ).
        // The empty option must NOT consume an occurrence_index, so every
        // later unit keeps the same occurrence the patchback re-walk
        // (collect_text_unit_positions) assigns.
        //
        // COMMAND header (8 bytes): 0x23, module_type=0, module_id=SEL(2),
        // opcode=1 (select), argc, overload, reserved; then the
        // SelectElement `{ … }` block. The middle option is an empty entry
        // (a bare `\n`+line marker with no text), which `decode_select`
        // drops — emitting only "A" and "B".
        let mut bytecode: Vec<u8> = Vec::new();
        bytecode.extend_from_slice(&[0x83, 0x6E]); // Textout "ハ" -> occ 0
        bytecode.extend_from_slice(&[0x23, 0x00, 0x02, 0x01, 0x00, 0x02, 0x00, 0x00]);
        bytecode.push(b'{');
        bytecode.extend_from_slice(b"A"); // option A -> occ 1
        bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]);
        bytecode.extend_from_slice(&[0x0a, 0x06, 0x00]); // empty option -> dropped
        bytecode.extend_from_slice(b"B"); // option B -> occ 2
        bytecode.extend_from_slice(&[0x0a, 0x07, 0x00]);
        bytecode.push(b'}');
        bytecode.extend_from_slice(&[0x83, 0x70]); // Textout "ニ" -> occ 3
        bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]); // MetaLine terminator

        let report = parse_gameexe_inventory(b"");
        let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
            .expect("scene with empty choice option must produce units");

        // Producer occurrence indices, in encounter order, parsed from
        // the canonical sourceUnitKey `reallive:scene-NNNN#OOOO`.
        let producer: Vec<(usize, String)> = produced
            .bundle
            .units
            .iter()
            .map(|u| {
                let occ = u
                    .source_unit_key
                    .split('#')
                    .nth(1)
                    .and_then(|s| s.parse::<usize>().ok())
                    .expect("occurrence in sourceUnitKey");
                (occ, u.surface_kind.clone())
            })
            .collect();

        // Exactly four units (the empty option emitted none), and the
        // trailing dialogue unit sits at occurrence 3 (no drift).
        assert_eq!(
            producer,
            vec![
                (0, "dialogue".to_string()),
                (1, "choice_label".to_string()),
                (2, "choice_label".to_string()),
                (3, "dialogue".to_string()),
            ],
            "empty `,,` option must not consume an occurrence_index"
        );
    }

    #[test]
    fn protected_span_failing_validation_surfaces_typed_error_not_silent_drop() {
        // 005 regression: build_unit_json bare-`continue`d on a span that
        // failed its byte-range / raw-bytes equality check, dropping the
        // protected span (and its preserveMode=exact guard) with no error.
        // The contract forbids that — a mismatch must surface a typed
        // BridgeProduceError.
        let base_unit = |spans: Vec<ProtoSpan>| ProtoUnit {
            surface_kind: "dialogue",
            decoded_text: "本文".to_string(),
            control_prefix: String::new(),
            spans,
            raw_speaker: None,
            decompressed_byte_offset: 0,
            decompressed_byte_len: 6,
            voice_archive_id: None,
            voice_sample_id: None,
            occurrence_index: 0,
            choice_group_index: None,
            choice_option_index: None,
        };

        // Raw-bytes mismatch: span claims bytes 0..5 are "#FACE" but the
        // sourceText bytes there are the decoded dialogue.
        let mismatch = base_unit(vec![ProtoSpan {
            parsed_name: "reallive.asset_ref",
            start_byte: 0,
            end_byte: 5,
            raw: "#FACE".to_string(),
        }]);
        let err = build_unit_json(7, "a", "k", "r", "h", "ns", &opts_for_test(), &mismatch)
            .expect_err("mismatched protected span must error, not be dropped");
        assert!(
            matches!(
                err,
                BridgeProduceError::ProtectedSpanInvalid {
                    scene_id: 7,
                    parsed_name: "reallive.asset_ref",
                    ..
                }
            ),
            "expected ProtectedSpanInvalid, got {err:?}"
        );

        // Out-of-range: end_byte past sourceText length.
        let oob = base_unit(vec![ProtoSpan {
            parsed_name: "reallive.font_tone",
            start_byte: 0,
            end_byte: 999,
            raw: "x".to_string(),
        }]);
        let err = build_unit_json(7, "a", "k", "r", "h", "ns", &opts_for_test(), &oob)
            .expect_err("out-of-range protected span must error, not be dropped");
        assert!(
            matches!(
                err,
                BridgeProduceError::ProtectedSpanInvalid {
                    parsed_name: "reallive.font_tone",
                    ..
                }
            ),
            "expected ProtectedSpanInvalid, got {err:?}"
        );
    }

    #[test]
    fn unit_offset_after_choice_command_tracks_authoritative_decode_width_no_drift() {
        // 004 regression: the unit that follows a Choice command must be
        // anchored at the REAL width `decode_command` consumed, never a
        // hand-reconstructed table. The `module_sel` `SelectElement`
        // `{ … }` block here consumes 18 bytes (8-byte header + `{` + "A" +
        // `\n`+line + "B" + `\n`+line + `}`), so the trailing dialogue must
        // anchor at 2 (first Textout) + 18 = 20.
        //
        // Bytecode: Textout "ハ" (2 bytes) | select{ "A", "B" } (18 bytes)
        // | Textout "ニ" (occurrence 3) | MetaLine terminator.
        let mut bytecode: Vec<u8> = Vec::new();
        bytecode.extend_from_slice(&[0x83, 0x6E]); // Textout "ハ" -> occ 0, offset 0
        bytecode.extend_from_slice(&[0x23, 0x00, 0x02, 0x01, 0x00, 0x02, 0x00, 0x00]);
        bytecode.push(b'{');
        bytecode.extend_from_slice(b"A"); // option A -> occ 1
        bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]);
        bytecode.extend_from_slice(b"B"); // option B -> occ 2
        bytecode.extend_from_slice(&[0x0a, 0x06, 0x00]);
        bytecode.push(b'}');
        bytecode.extend_from_slice(&[0x83, 0x70]); // Textout "ニ" -> occ 3
        bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]); // MetaLine terminator

        let report = parse_gameexe_inventory(b"");
        let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
            .expect("scene with choice must produce units");

        // The trailing dialogue unit (occurrence 3) must start at the real
        // cursor: 2 (first Textout) + 18 (select header+block) = 20.
        let trailing = produced
            .json
            .get("units")
            .and_then(|u| u.as_array())
            .and_then(|units| {
                units.iter().find(|u| {
                    u["sourceUnitKey"]
                        .as_str()
                        .is_some_and(|k| k.ends_with("#0003"))
                })
            })
            .expect("occurrence-3 dialogue unit present");
        let start = trailing["sourceLocation"]["range"]["startByte"]
            .as_u64()
            .expect("startByte u64");
        assert_eq!(
            start, 20,
            "unit after Choice must anchor at the authoritative decode width (20)"
        );
    }

    #[test]
    fn predicate_classifies_real_binary_block_as_non_translatable_and_real_dialogue_as_translatable()
     {
        use crate::test_fixtures::{SCENE1_BINARY_BLOCK_214B, SCENE2011_DIALOGUE_SJIS};
        // Real bytes: the Sweetie HD scene-1 214-byte binary data block is
        // NOT translatable; a real scene-2011 Shift-JIS dialogue line IS.
        assert!(
            decode_dialogue_textout(SCENE1_BINARY_BLOCK_214B).is_none(),
            "the 214-byte periodic-binary data block must be excluded from translatable units"
        );
        assert!(
            decode_dialogue_textout(SCENE2011_DIALOGUE_SJIS).is_some(),
            "a real Shift-JIS dialogue line must remain translatable (no false negative)"
        );
    }

    #[test]
    fn binary_catch_all_textout_is_excluded_while_real_sjis_dialogue_is_surfaced() {
        use crate::test_fixtures::{
            SCENE1_BINARY_BLOCK_214B, SCENE2011_DIALOGUE_SJIS, SCENE2011_DIALOGUE_TEXT,
        };
        // A scene whose bytecode is [real dialogue Textout][MetaLine]
        // [214-byte binary Textout][MetaLine]. Both runs parse as a single
        // Textout each (verified against the live corpus). The bridge must
        // surface ONLY the dialogue run as a translatable unit and drop the
        // binary run entirely.
        let mut bytecode: Vec<u8> = Vec::new();
        bytecode.extend_from_slice(SCENE2011_DIALOGUE_SJIS);
        bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]); // MetaLine terminator
        bytecode.extend_from_slice(SCENE1_BINARY_BLOCK_214B);
        bytecode.extend_from_slice(&[0x0a, 0x06, 0x00]); // MetaLine terminator

        // Sanity: the raw bytecode does parse as exactly two Textout runs,
        // so the test is genuinely exercising the surface-selection split
        // (not an artefact of the binary bytes fragmenting).
        let opcodes = crate::opcode::parse_real_bytecode(&bytecode).expect("bytecode parses");
        let textouts: Vec<&[u8]> = opcodes
            .iter()
            .filter_map(|op| match op {
                RealLiveOpcode::Textout { raw_bytes, .. } => Some(raw_bytes.as_slice()),
                _ => None,
            })
            .collect();
        assert_eq!(
            textouts.len(),
            2,
            "fixture must decode to exactly two Textout runs (dialogue + binary)"
        );
        assert_eq!(textouts[1], SCENE1_BINARY_BLOCK_214B);

        let report = parse_gameexe_inventory(b"");
        let produced = produce_bundle(1, &[0u8; 32], &bytecode, &report, &opts_for_test())
            .expect("dialogue run must produce a bundle");

        // Exactly one translatable unit (the dialogue); the binary run is
        // excluded.
        assert_eq!(
            produced.bundle.units.len(),
            1,
            "only the readable Shift-JIS dialogue run is surfaced; the binary run is excluded"
        );
        let unit = &produced.bundle.units[0];
        assert_eq!(unit.surface_kind, "dialogue");
        assert!(
            unit.source_text.contains(SCENE2011_DIALOGUE_TEXT),
            "the surfaced unit must carry the decoded dialogue text; got {:?}",
            unit.source_text
        );
        // No surfaced unit may carry the binary block's decoded form.
        let (binary_decoded, _, _) = encoding_rs::SHIFT_JIS.decode(SCENE1_BINARY_BLOCK_214B);
        assert!(
            !unit.source_text.contains(binary_decoded.as_ref()),
            "no translatable unit may carry the binary data block's bytes"
        );
    }
}
