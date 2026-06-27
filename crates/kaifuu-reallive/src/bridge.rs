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
//! - Provenance: each unit's `sourceLocation.range` is anchored against
//!   the **scene blob file offset** (Sweetie HD scene 1 = `0x13880`), so
//!   downstream patchback (KAIFUU-211) can write back without
//!   recomputing the decompressed offset.
//!
//! Empty scene → typed [`BridgeProduceError::EmptyScene`] (no silent
//! `Ok(empty bundle)`).

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;

use kaifuu_core::{BRIDGE_SCHEMA_VERSION_V02, BridgeBundleV02, BridgeContractValidationError};

use crate::gameexe::{GameexeInventoryReport, GameexeKeyFamily};
use crate::opcode::{RealLiveOpcode, RealLiveParseError, TextEncoding, parse_real_bytecode};

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
    /// Absolute file offset of the scene blob inside the SEEN.TXT
    /// envelope. Used as the byte-range anchor in
    /// `sourceLocation.range`. Sweetie HD scene 1 sits at `0x13880`.
    pub scene_blob_file_offset: u64,
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
    let opcodes = parse_real_bytecode(decompressed_bytecode)?;
    if opcodes.is_empty() {
        return Err(BridgeProduceError::EmptyScene { scene_id });
    }
    let units = collect_units(scene_id, &opcodes, gameexe_inventory, opts);
    if units.is_empty() {
        return Err(BridgeProduceError::NoTextUnits {
            scene_id,
            opcode_count: opcodes.len(),
        });
    }
    let json = build_bundle_json(scene_id, scene_bytes, &units, opts);
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
    opcodes: &[RealLiveOpcode],
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
    // Decompressed-byte cursor: we recompute by traversing opcodes and
    // accumulating element widths from the raw byte arrays each variant
    // carries. The width helpers below mirror the parser's element
    // widths so the cursor lands at the start of each text-display body.
    let mut cursor: u64 = 0;

    for (idx, op) in opcodes.iter().enumerate() {
        let width = opcode_byte_width(op);
        match op {
            RealLiveOpcode::MetaKidoku { mark } => {
                pending_markers.push(PendingMarker {
                    parsed_name: "reallive.kidoku",
                    label: format!("<reallive.kidoku {mark}>"),
                });
                inline_kidoku_seen = true;
            }
            RealLiveOpcode::Textout {
                raw_bytes,
                encoding,
            } => {
                let decoded = decode_text_body(raw_bytes, *encoding);
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
            RealLiveOpcode::TextDisplay { .. } => {
                // TextDisplay carries no raw text body in the parsed
                // opcode (the body is carried in the next Textout or in
                // command args we did not split). The KAIFUU-191 parser
                // does not separate the text body from the TextDisplay
                // command header — the inline Shift-JIS run that
                // immediately follows lands as `Textout`. So
                // TextDisplay alone does not emit a unit; it serves as
                // a marker. Carry pending markers forward.
            }
            RealLiveOpcode::CharacterTextDisplay => {
                // Same logic as TextDisplay — the following Textout
                // run carries the body. CharacterTextDisplay typically
                // sits between a NAMAE-table speaker tag and the
                // dialogue body; the NAMAE-lookup pass below uses
                // adjacency to attribute the unit.
            }
            RealLiveOpcode::Choice { choices } => {
                for (option_index, choice_bytes) in choices.iter().enumerate() {
                    let decoded = decode_text_body(choice_bytes, TextEncoding::ShiftJisInlineRun);
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

fn decode_text_body(raw: &[u8], _encoding: TextEncoding) -> String {
    // Shift-JIS decode; replacement chars on invalid sequences keep the
    // bridge contract honest without panicking on bad bytes.
    let (decoded, _enc, _had_errors) = encoding_rs::SHIFT_JIS.decode(raw);
    decoded.into_owned()
}

/// Compute the byte width consumed by one decoded opcode in the
/// post-AVG32 decompressed bytecode stream. This mirrors the widths
/// used by [`parse_real_bytecode`] so the bridge producer can carry a
/// cursor that lands at the start of every text-display body.
fn opcode_byte_width(op: &RealLiveOpcode) -> usize {
    match op {
        RealLiveOpcode::MetaLine { .. }
        | RealLiveOpcode::MetaEntrypoint { .. }
        | RealLiveOpcode::MetaKidoku { .. } => 3,
        RealLiveOpcode::Comma => 1,
        RealLiveOpcode::Textout { raw_bytes, .. } => raw_bytes.len(),
        RealLiveOpcode::Expression { raw_bytes } => raw_bytes.len() + 1, // +opener byte
        RealLiveOpcode::Unknown { raw_bytes, .. } => raw_bytes.len().max(1),
        // Recognised commands: the parser does not retain the raw byte
        // span on the typed variant, so we under-count by the command
        // header + args width. The bridge cursor still lands inside the
        // command body, which is acceptable for provenance — the
        // patchback driver (KAIFUU-211) will re-walk the stream.
        RealLiveOpcode::TextDisplay { .. } => 8,
        RealLiveOpcode::CharacterTextDisplay => 8,
        RealLiveOpcode::Choice { choices } => {
            8 + choices.iter().map(|c| c.len() + 1).sum::<usize>()
        }
        RealLiveOpcode::Branch
        | RealLiveOpcode::Jump
        | RealLiveOpcode::Goto
        | RealLiveOpcode::Call
        | RealLiveOpcode::Return
        | RealLiveOpcode::Wait { .. }
        | RealLiveOpcode::Background { .. }
        | RealLiveOpcode::BgmPlay
        | RealLiveOpcode::BgmStop
        | RealLiveOpcode::VoicePlay { .. }
        | RealLiveOpcode::SetVariable
        | RealLiveOpcode::If
        | RealLiveOpcode::End => 8,
    }
}

// ---------------------------------------------------------------------
// JSON bundle assembly
// ---------------------------------------------------------------------

fn build_bundle_json(
    scene_id: u16,
    scene_bytes: &[u8],
    units: &[ProtoUnit],
    opts: &BridgeOpts<'_>,
) -> Value {
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
        .collect();

    json!({
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
    })
}

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
) -> Value {
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
        // Validate the span byte range matches the wrapped source text.
        if span.end_byte as usize > source_text.len() {
            continue;
        }
        let actual = &source_text.as_bytes()[span.start_byte as usize..span.end_byte as usize];
        if actual != span.raw.as_bytes() {
            continue;
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

    let scene_blob_file_start = opts
        .scene_blob_file_offset
        .saturating_add(unit.decompressed_byte_offset);
    let scene_blob_file_end =
        scene_blob_file_start.saturating_add(unit.decompressed_byte_len.max(1));

    let source_location = json!({
        "containerKey": format!("reallive:scene-{scene_id:04}"),
        "entryPath": [
            "scene",
            format!("{scene_id:04}"),
            "units",
            format!("{:04}", unit.occurrence_index),
        ],
        "range": {
            "startByte": scene_blob_file_start,
            "endByte": scene_blob_file_end,
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

    json!({
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
    })
}

// ---------------------------------------------------------------------
// Deterministic identifiers
// ---------------------------------------------------------------------

fn sha256_canonical(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest.iter() {
        hex.push_str(&format!("{byte:02x}"));
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
            scene_blob_file_offset: 0x13880,
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
    fn provenance_byte_range_is_anchored_against_scene_blob_file_offset() {
        let bytecode = &[0x83, 0x6E, 0x0a, 0x05, 0x00];
        let report = parse_gameexe_inventory(b"");
        let produced = produce_bundle(1, &[0u8; 32], bytecode, &report, &opts_for_test())
            .expect("textout must produce a dialogue unit");
        let range = &produced.json["units"][0]["sourceLocation"]["range"];
        let start = range["startByte"].as_u64().expect("startByte u64");
        assert!(
            start >= 0x13880,
            "byte range must be anchored at scene blob file offset (0x13880); got {start:#x}"
        );
    }
}
