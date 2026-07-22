//! RealLive scene bytecode → v0.2 BridgeBundle producer.
//! Walks a [`Vec<RealLiveOpcode>`] (from [`parse_real_bytecode`]) into a
//! [`kaifuu_core::BridgeBundleV02`] keyed against the v0.2 schema:
//! - Each [`RealLiveOpcode::Textout`] / [`RealLiveOpcode::TextDisplay`] /
//!   [`RealLiveOpcode::CharacterTextDisplay`] yields one `dialogue` unit.
//! - Each choice in a [`RealLiveOpcode::Choice`] yields one `choice_label`
//!   unit.
//! - Per-unit protected spans are computed from the **surrounding**
//!   control bytes that the opcode walker saw before the text body:
//! * `MetaKidoku` markers → `parsedName = "reallive.kidoku"`.
//! * Inline name-token bytes (Shift-JIS bracket-enclosed speaker
//!   prefix) → `parsedName = "reallive.name_token"`.
//! * Choice-marker bytes (`0x30..0x34`) → `parsedName = "reallive.choice_marker"`.
//! * Font-tone bytes (`#FONT_*` Shift-JIS tag run) →
//!   `parsedName = "reallive.font_tone"`.
//! * Asset-ref tags (`#FACE`, `#GANBMP`) → `parsedName = "reallive.asset_ref"`.
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
//!   [`parse_real_bytecode`] and the patchback re-walk
//!   operate in ("caller owns decompression"). The owning scene is
//!   identified by its scene id (`containerKey` / `sourceUnitKey`),
//!   never by adding a decompressed cursor to a compressed file offset:
//!   that earlier mixing pushed any unit whose decompressed offset
//!   exceeded its scene's compressed `byte_len` into a *later* scene.
//!   Empty scene → typed [`BridgeProduceError::EmptyScene`] (no silent
//!   `Ok(empty bundle)`).

use std::fmt;

use serde_json::{Value, json};
use thiserror::Error;

use kaifuu_core::{
    BRIDGE_SCHEMA_VERSION_V02, BridgeBundleV02, BridgeContractValidationError,
    RedactedContentSummary,
};

use crate::bridge_ids::{
    deterministic_speaker_id, deterministic_uuid7, scene_bundle_namespace, sha256_canonical,
};
use crate::gameexe::{GameexeInventoryReport, GameexeKeyFamily};
use crate::opcode::{
    RealLiveOpcode, RealLiveParseError, decode_dialogue_textout, parse_real_bytecode_spans,
};

const RLDEV_ASSET_REF_TAGS: &[&str] = &["#FACE", "#GANBMP"];
const RLDEV_FONT_TONE_TAGS: &[&str] = &["#FONT_BIG", "#FONT_SMALL", "#COLOR"];

#[path = "bridge/api.rs"]
mod api;
pub use api::{BridgeOpts, BridgeProduceError, BridgeSceneInput, ProducedBundle};

#[path = "bridge/collect.rs"]
mod collect;
use collect::collect_units;

#[path = "bridge/metadata.rs"]
mod metadata;
use metadata::{
    extract_choice_marker_spans, extract_inline_tag_spans, extract_name_token_spans,
    resolve_unit_speaker,
};

#[path = "bridge/json.rs"]
mod json_builder;
#[cfg(test)]
use json_builder::build_unit_json;
use json_builder::{build_bundle_json, build_whole_seen_bundle_json};

/// Walk a scene's decompressed bytecode into a v0.2 BridgeBundle.
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

/// Walk all decoded scenes from one SEEN.TXT archive into one v0.2
/// BridgeBundle.
/// The top-level source bundle hash/revision is the whole `Seen.txt`, while
/// each scene remains a distinct script asset and every unit keeps its
/// canonical scene-scoped key (`reallive:scene-NNNN#OOOO`). A scene that
/// decodes but carries no translatable units contributes an asset and no
/// units; a scene that fails bytecode decode returns a scene-specific error.
pub fn produce_whole_seen_bundle(
    seen_bytes: &[u8],
    scenes: &[BridgeSceneInput<'_>],
    gameexe_inventory: &GameexeInventoryReport,
    opts: &BridgeOpts<'_>,
) -> Result<ProducedBundle, BridgeProduceError> {
    let mut scene_outputs = Vec::new();
    let mut total_units = 0usize;
    for scene in scenes {
        if scene.decompressed_bytecode.is_empty() {
            return Err(BridgeProduceError::EmptyScene {
                scene_id: scene.scene_id,
            });
        }
        let opcode_spans = parse_real_bytecode_spans(scene.decompressed_bytecode)?;
        if opcode_spans.is_empty() {
            return Err(BridgeProduceError::EmptyScene {
                scene_id: scene.scene_id,
            });
        }
        let scene_opts = BridgeOpts {
            game_id: opts.game_id,
            game_version: opts.game_version,
            source_profile_id: opts.source_profile_id,
            source_locale: opts.source_locale,
            extractor_name: opts.extractor_name,
            extractor_version: opts.extractor_version,
            scene_kidoku_count: scene.scene_kidoku_count,
        };
        let units = collect_units(
            scene.scene_id,
            &opcode_spans,
            gameexe_inventory,
            &scene_opts,
        );
        total_units += units.len();
        scene_outputs.push(SceneBundleParts {
            scene_id: scene.scene_id,
            scene_bytes: scene.scene_bytes,
            units,
        });
    }
    if total_units == 0 {
        return Err(BridgeProduceError::WholeSeenNoTextUnits {
            scene_count: scenes.len(),
        });
    }
    let json = build_whole_seen_bundle_json(seen_bytes, &scene_outputs, opts)?;
    let bundle = BridgeBundleV02::validate_json(&json)?;
    Ok(ProducedBundle { bundle, json })
}

// Unit collection

/// Typed per-line speaker resolution outcome.
/// The v0.2 bridge speaker object is emitted directly from this. Refining
/// the producer away from its old "every resolved name is `parser_unknown`"
/// emission is the point of this pass: a name that resolved through the
/// NAMAE registry keeps its resolved identity (`known` when the reader is
/// shown the character's real name, `reader_unknown` when the box shows a
/// mask the reader has not yet seen through), and ONLY a genuinely
/// unresolved speaker is `parser_unknown`. The reveal state is carried by
/// which arm is chosen — `Revealed` vs `Concealed` — never fabricated.
#[derive(Clone)]
enum SpeakerResolution {
    /// Resolved to a NAMAE row whose box-shown name equals the registry
    /// identity: the reader sees the character's real name.
    Revealed {
        display_name: String,
        canonical_ref: String,
        color: Option<[u8; 3]>,
    },
    /// Resolved to a NAMAE row whose box-shown name differs from the
    /// registry identity (a censored / alias row): the parser knows who
    /// this is, but the reader is shown a mask and does not yet.
    Concealed {
        display_name: String,
        reader_label: String,
        canonical_ref: String,
        color: Option<[u8; 3]>,
    },
    /// A speaker box was observed but did not resolve to exactly one NAMAE
    /// row (no match, an ambiguous match, or a bounded best-effort guess):
    /// genuinely unresolved.
    ParserUnknown { raw: String, evidence: &'static str },
    /// No speaker applies (non-dialogue surface, or no speaker box at all).
    NotApplicable,
}

impl fmt::Debug for SpeakerResolution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Speaker names are source content — redact them in diagnostics.
        let redact = RedactedContentSummary::from_text;
        match self {
            Self::Revealed {
                display_name,
                canonical_ref,
                color,
            } => formatter
                .debug_struct("Revealed")
                .field("display_name", &redact(display_name))
                .field("canonical_ref", &redact(canonical_ref))
                .field("color", color)
                .finish(),
            Self::Concealed {
                display_name,
                reader_label,
                canonical_ref,
                color,
            } => formatter
                .debug_struct("Concealed")
                .field("display_name", &redact(display_name))
                .field("reader_label", &redact(reader_label))
                .field("canonical_ref", &redact(canonical_ref))
                .field("color", color)
                .finish(),
            Self::ParserUnknown { raw, evidence } => formatter
                .debug_struct("ParserUnknown")
                .field("raw", &redact(raw))
                .field("evidence", evidence)
                .finish(),
            Self::NotApplicable => formatter.write_str("NotApplicable"),
        }
    }
}

/// One parsed `#NAMAE` registry row.
struct NamaeRow {
    /// First quoted field — the registry display key (the character's
    /// canonical identity token, the `【…】` lookup key).
    display_key: String,
    /// Second quoted field — the box-shown name the reader actually sees
    /// (equal to `display_key` for a plain named speaker; a mask such as a
    /// censored placeholder for a not-yet-revealed character).
    box_name: String,
    /// Resolved dialogue text colour from the row's `#COLOR_TABLE` index.
    color: Option<[u8; 3]>,
}

#[derive(Clone)]
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
    /// Raw speaker box text observed for this line (inline `【…】` token
    /// contents or a carried-forward prior speaker). Input to the typed
    /// [`SpeakerResolution`]; never emitted verbatim once resolved.
    raw_speaker: Option<String>,
    /// True when `raw_speaker` was assigned by the bounded best-effort
    /// first-line fallback (a guess), not by a real NAMAE / inline-token
    /// match. A guess stays `parser_unknown` — it must never be promoted
    /// to a resolved identity.
    speaker_from_fallback: bool,
    /// Typed speaker resolution for this line, computed after the NAMAE
    /// passes. A name that resolved keeps its resolved identity; only a
    /// genuinely-unresolved speaker is `parser_unknown`.
    resolution: SpeakerResolution,
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

#[derive(Clone)]
struct ProtoSpan {
    /// Parsed name on the v0.2 span (e.g. `"reallive.kidoku"`).
    parsed_name: &'static str,
    /// True when the span is carried structurally rather than spliced into the body.
    out_of_band: bool,
    /// Raw byte range within the wrapped UTF-8 sourceText.
    start_byte: u64,
    /// End byte (exclusive).
    end_byte: u64,
    /// Raw substring.
    raw: String,
}

impl fmt::Debug for ProtoUnit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let decoded_text = RedactedContentSummary::from_text(&self.decoded_text);
        let control_prefix = RedactedContentSummary::from_text(&self.control_prefix);
        let raw_speaker = self
            .raw_speaker
            .as_deref()
            .map(RedactedContentSummary::from_text);
        formatter
            .debug_struct("ProtoUnit")
            .field("surface_kind", &self.surface_kind)
            .field("decoded_text", &decoded_text)
            .field("control_prefix", &control_prefix)
            .field("spans", &self.spans)
            .field("raw_speaker", &raw_speaker)
            .field("speaker_from_fallback", &self.speaker_from_fallback)
            .field("resolution", &self.resolution)
            .field("decompressed_byte_offset", &self.decompressed_byte_offset)
            .field("decompressed_byte_len", &self.decompressed_byte_len)
            .field("voice_archive_id", &self.voice_archive_id)
            .field("voice_sample_id", &self.voice_sample_id)
            .field("occurrence_index", &self.occurrence_index)
            .field("choice_group_index", &self.choice_group_index)
            .field("choice_option_index", &self.choice_option_index)
            .finish()
    }
}

impl fmt::Debug for ProtoSpan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let raw = RedactedContentSummary::from_text(&self.raw);
        formatter
            .debug_struct("ProtoSpan")
            .field("parsed_name", &self.parsed_name)
            .field("out_of_band", &self.out_of_band)
            .field("start_byte", &self.start_byte)
            .field("end_byte", &self.end_byte)
            .field("raw", &raw)
            .finish()
    }
}

#[derive(Debug, Clone)]
struct PendingMarker {
    parsed_name: &'static str,
    out_of_band: bool,
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
            out_of_band: marker.out_of_band,
            start_byte: start,
            end_byte: end,
            raw: marker.label,
        });
    }
    (prefix, spans)
}

struct SceneBundleParts<'a> {
    scene_id: u16,
    scene_bytes: &'a [u8],
    units: Vec<ProtoUnit>,
}

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests_scene;
#[cfg(test)]
mod tests_speaker;
