//! Real Sweetie HD scene bytecode → v0.2 BridgeBundle
//! producer.
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

/// Caller-supplied knobs for [`produce_bundle`].
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

/// One decoded scene supplied to [`produce_whole_seen_bundle`].
#[derive(Clone, Copy)]
pub struct BridgeSceneInput<'a> {
    /// Scene id from the 10,000-slot SEEN directory.
    pub scene_id: u16,
    /// Raw scene blob (header + compressed bytecode), used for per-asset
    /// source hashes.
    pub scene_bytes: &'a [u8],
    /// Decompressed, post-xor2 scene bytecode.
    pub decompressed_bytecode: &'a [u8],
    /// Number of kidoku-table entries declared in this scene's header.
    pub scene_kidoku_count: u32,
}

impl fmt::Debug for BridgeSceneInput<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let scene_bytes = RedactedContentSummary::from_bytes(self.scene_bytes);
        let decompressed_bytecode = RedactedContentSummary::from_bytes(self.decompressed_bytecode);
        formatter
            .debug_struct("BridgeSceneInput")
            .field("scene_id", &self.scene_id)
            .field("scene_bytes", &scene_bytes)
            .field("decompressed_bytecode", &decompressed_bytecode)
            .field("scene_kidoku_count", &self.scene_kidoku_count)
            .finish()
    }
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
    /// A whole-SEEN extract decoded every scene but found no translatable
    /// units anywhere. This is a refusal rather than an empty bridge.
    #[error(
        "kaifuu.reallive.bridge.whole_seen_no_text_units: decoded {scene_count} scene(s) but found no Textout/TextDisplay/Choice units"
    )]
    WholeSeenNoTextUnits { scene_count: usize },
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
/// `bundle` is the typed [`BridgeBundleV02`] returned by the v0.2
/// validator; `json` is the raw `serde_json::Value` payload the
/// validator accepted. Both are returned because [`BridgeBundleV02`]
/// derives `Deserialize` only — callers writing a JSON file want the
/// validated `Value`.
#[derive(Clone)]
pub struct ProducedBundle {
    pub bundle: BridgeBundleV02,
    pub json: Value,
}

impl fmt::Debug for ProducedBundle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let serialized_json = self.json.to_string();
        let json = RedactedContentSummary::from_text(&serialized_json);
        formatter
            .debug_struct("ProducedBundle")
            .field("bridge_id", &self.bundle.bridge_id)
            .field("unit_count", &self.bundle.units.len())
            .field("json", &json)
            .finish()
    }
}

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

fn extract_name_token_spans(decoded: &str, prefix_offset: u64) -> (Option<String>, Vec<ProtoSpan>) {
    // A speaker name token is the full-width lenticular `【話者】` prefix (the
    // `#NAMAE` lookup key). The `「話者」` corner brackets are the DIALOGUE
    // quote, NOT a name token — matching them here misattributed every
    // quote-only narration line to a speaker, so that fallback is dropped.
    // PROVENANCE (2nd-corpus calibration,
    // `reallive-bridge-second-corpus-protected-span-calibration`): the inline
    // `【】` speaker bracket is a TITLE / ERA-CALIBRATED convention, NOT
    // RealLive-engine-universal. It fires 16,862× on Sweetie HD (an rlBabel-era
    // title) but ZERO times on classic Kanon (1.2.6.8), which does not
    // inline-bracket speaker names. The detector is correct where the
    // convention is used and simply emits no span where it is not — it keys on
    // an exact `【…】` literal, so it cannot MIS-fire on a title that omits it.
    // See `tests/protected_span_second_corpus_real_bytes.rs`. Do NOT re-describe
    // this as an engine-general rule (no-overclaim).
    let candidates = [('【', '】')];
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
                out_of_band: false,
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
    // PROVENANCE (2nd-corpus calibration): TITLE-CALIBRATED, speculative
    // Sweetie-HD vocabulary. These exact tag literals emit ZERO spans on BOTH
    // real corpora (they do not fire even on Sweetie HD's real bytes, and
    // `#GANBMP` in particular is Sweetie authoring vocabulary). Keying on an
    // exact literal, they cannot mis-fire on Kanon. Not RealLive-engine-general.
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
                out_of_band: false,
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
    // PROVENANCE (2nd-corpus calibration): TITLE-CALIBRATED Sweetie-HD
    // vocabulary. These exact tag literals emit ZERO spans on BOTH real corpora
    // (Sweetie HD and Kanon). Keying on an exact literal, they cannot mis-fire
    // on Kanon. Not RealLive-engine-general.
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
                out_of_band: false,
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
    // PROVENANCE (2nd-corpus calibration): TITLE-CALIBRATED heuristic (not an
    // RLDEV-documented marker). Emits ZERO spans on BOTH real corpora — real
    // RealLive selection is carried by `module_sel` Choice opcodes, not inline
    // ASCII-digit bytes in the choice body. Kept bounded (first match only) so
    // it cannot mis-fire; not RealLive-engine-general.
    let mut spans = Vec::new();
    for byte in [0x30u8, 0x31, 0x32, 0x33] {
        let ch = byte as char;
        // Only match the first one to keep the span set bounded.
        if raw_bytes.contains(&byte)
            && let Some(pos) = decoded.find(ch)
        {
            spans.push(ProtoSpan {
                parsed_name: "reallive.choice_marker",
                out_of_band: false,
                start_byte: prefix_offset + pos as u64,
                end_byte: prefix_offset + pos as u64 + 1,
                raw: ch.to_string(),
            });
            break;
        }
    }
    spans
}

/// Compute the typed speaker resolution for one collected unit.
/// Only a `dialogue` line with a pinned speaker box can carry a speaker.
/// A box flagged `speaker_from_fallback` is a bounded guess and stays
/// `parser_unknown`. Otherwise the box is resolved against the NAMAE
/// registry: a UNIQUE row match keeps the resolved identity (`Revealed`
/// when the box name is the character's real name, `Concealed` when the
/// box shows a mask); no match — or an ambiguous match — is
/// `parser_unknown` (never a fabricated identity).
fn resolve_unit_speaker(
    unit: &ProtoUnit,
    gameexe_inventory: &GameexeInventoryReport,
) -> SpeakerResolution {
    if unit.surface_kind != "dialogue" {
        return SpeakerResolution::NotApplicable;
    }
    let Some(raw) = unit.raw_speaker.as_deref() else {
        return SpeakerResolution::NotApplicable;
    };
    if unit.speaker_from_fallback {
        return SpeakerResolution::ParserUnknown {
            raw: raw.to_string(),
            evidence: "namae_first_line_fallback",
        };
    }
    match resolve_namae_row(raw, gameexe_inventory) {
        Some(row) => {
            let canonical_ref = format!("reallive:namae:{}", row.display_key);
            if row.display_key == row.box_name {
                SpeakerResolution::Revealed {
                    display_name: row.display_key,
                    canonical_ref,
                    color: row.color,
                }
            } else {
                SpeakerResolution::Concealed {
                    display_name: row.display_key,
                    reader_label: row.box_name,
                    canonical_ref,
                    color: row.color,
                }
            }
        }
        None => SpeakerResolution::ParserUnknown {
            raw: raw.to_string(),
            evidence: "inline_name_token_unresolved",
        },
    }
}

/// Resolve a raw `【…】` speaker token to a UNIQUE `#NAMAE` row.
/// Matches on EXACT equality against a row's DISPLAY KEY (the first quoted
/// field) ONLY — never the second/box-shown field, and never a substring
/// `contains`. This is the exact lookup the runtime performs
/// (`utsushi-reallive`'s `NamaeResolver::resolve` keys `by_key` on the
/// display string an authored `【…】` prefix carries), so the Bridge cannot
/// invent an identity the engine would not resolve:
/// - A token that equals only a censored box label (e.g. `【？？？】` against
///   `#NAMAE="？？？／凛"="？？？"`) has NO display key `？？？` and stays
///   unresolved, exactly as the runtime leaves it.
/// - With rows `A="???"` and `B="A"`, the token `【A】` uniquely matches row
///   A's display key; row B's box-shown `A` is NOT a second match, so this is
///   a clean single resolution, not spurious `parser_unknown` ambiguity.
///
/// Reveal state is then derived from the matched row's REAL fields (display
/// key vs box-shown name) by the caller, never fabricated. A token that
/// still matches two or more rows on the display key is ambiguous and
/// returns `None`: the producer must not guess which row a duplicated key
/// belongs to.
fn resolve_namae_row(raw: &str, gameexe_inventory: &GameexeInventoryReport) -> Option<NamaeRow> {
    let mut matched: Option<NamaeRow> = None;
    for entry in &gameexe_inventory.entries {
        if !matches!(entry.family, GameexeKeyFamily::Namae) {
            continue;
        }
        let Some(display_key) = namae_display(&entry.value) else {
            continue;
        };
        if display_key == raw {
            if matched.is_some() {
                // Ambiguous exact display-key match — do not guess an identity.
                return None;
            }
            let box_name = namae_second_field(&entry.value).unwrap_or_else(|| display_key.clone());
            let color = namae_color_index(&entry.value)
                .and_then(|index| color_table_rgb(index, gameexe_inventory));
            matched = Some(NamaeRow {
                display_key,
                box_name,
                color,
            });
        }
    }
    matched
}

/// The first `"…"` quoted field of a `#NAMAE` RHS
/// (`"display" = "canonical" = (mode, color_table_index, reserved)`).
fn namae_display(value: &str) -> Option<String> {
    let start = value.find('"')? + 1;
    let end = value[start..].find('"')? + start;
    Some(value[start..end].to_string())
}

/// The second `"…"` quoted field of a `#NAMAE` RHS — the box-shown
/// (reader-facing) name. Absent on a single-quote row, in which case the
/// caller falls back to the display key.
fn namae_second_field(value: &str) -> Option<String> {
    let first_open = value.find('"')? + 1;
    let first_close = value[first_open..].find('"')? + first_open;
    let rest = &value[first_close + 1..];
    let second_open = rest.find('"')? + 1;
    let second_close = rest[second_open..].find('"')? + second_open;
    Some(rest[second_open..second_close].to_string())
}

/// The middle tuple field of a `#NAMAE` RHS — the `#COLOR_TABLE` row
/// index (the speaker's dialogue text colour), NOT a voice slot.
fn namae_color_index(value: &str) -> Option<i32> {
    let open = value.find('(')?;
    let close = value[open..].find(')')? + open;
    let inner = &value[open + 1..close];
    let mut parts = inner.split(',');
    let _mode = parts.next()?;
    parts.next()?.trim().parse::<i32>().ok()
}

/// Look up `#COLOR_TABLE.<index>` in the inventory and parse its
/// `r,g,b` value into an RGB triple. Indices are authored zero-padded
/// to three digits (`#COLOR_TABLE.016`); a bare form is accepted too.
fn color_table_rgb(index: i32, gameexe_inventory: &GameexeInventoryReport) -> Option<[u8; 3]> {
    if index < 0 {
        return None;
    }
    let padded = format!("{index:03}");
    let bare = index.to_string();
    let entry = gameexe_inventory.entries.iter().find(|entry| {
        matches!(&entry.family, GameexeKeyFamily::ColorTable { index: idx } if *idx == padded || *idx == bare)
    })?;
    let mut parts = entry
        .value
        .split(',')
        .map(|part| part.trim().parse::<i32>());
    let r = parts.next()?.ok()?;
    let g = parts.next()?.ok()?;
    let b = parts.next()?.ok()?;
    // Reject an out-of-range row instead of clamping it: a clamped triple
    // (`300,-1,17` → `[255,0,17]`) is a colour that is NOT present in
    // Gameexe, i.e. a fabricated RGB. An 8-bit channel is `0..=255`; any
    // authored value outside that omits the colour (the speaker still
    // resolves, just without a fabricated `textColor`).
    let channel = |v: i32| (0..=255).contains(&v).then_some(v as u8);
    Some([channel(r)?, channel(g)?, channel(b)?])
}

// JSON bundle assembly

struct SceneBundleParts<'a> {
    scene_id: u16,
    scene_bytes: &'a [u8],
    units: Vec<ProtoUnit>,
}

fn build_bundle_json(
    scene_id: u16,
    scene_bytes: &[u8],
    units: &[ProtoUnit],
    opts: &BridgeOpts<'_>,
) -> Result<Value, BridgeProduceError> {
    let bundle_namespace = scene_bundle_namespace(opts.game_id, opts.source_profile_id, scene_id);
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
                "normalization": "utf8-lf-json-stable-v1",
            },
            "sourceBundle": {
                "scope": "source_bundle",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
            "sourceAsset": {
                "scope": "source_asset",
                "algorithm": "sha256",
                "normalization": "bytes",
            },
            "sourceUnit": {
                "scope": "source_unit",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
                "fields": ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
            },
            "patchExport": {
                "scope": "patch_export",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
            "deltaPackage": {
                "scope": "delta_package",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
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

fn build_whole_seen_bundle_json(
    seen_bytes: &[u8],
    scenes: &[SceneBundleParts<'_>],
    opts: &BridgeOpts<'_>,
) -> Result<Value, BridgeProduceError> {
    let bundle_namespace = format!(
        "reallive-bridge:game-id={}:source-profile-id={}:whole-seen",
        opts.game_id, opts.source_profile_id
    );
    let seen_hash = sha256_canonical(seen_bytes);
    let bridge_id = deterministic_uuid7(&bundle_namespace, "bundle");
    let seen_revision_id = deterministic_uuid7(&bundle_namespace, "seen-revision");
    let source_profile_revision_id =
        deterministic_uuid7(&bundle_namespace, "source-profile-revision");
    let source_profile_hash = sha256_canonical(opts.source_profile_id.as_bytes());

    let mut assets = Vec::new();
    let mut units_json = Vec::new();
    for scene in scenes {
        let scene_namespace = format!(
            "reallive-bridge:game-id={}:source-profile-id={}:scene={:04}",
            opts.game_id, opts.source_profile_id, scene.scene_id
        );
        let scene_blob_hash = sha256_canonical(scene.scene_bytes);
        let revision_id = deterministic_uuid7(&scene_namespace, "scene-revision");
        let asset_id = deterministic_uuid7(&scene_namespace, "scene-asset");
        let asset_key = format!("reallive:scene-{:04}", scene.scene_id);

        assets.push(json!({
            "assetId": asset_id,
            "assetKey": asset_key,
            "assetKind": "script",
            "sourceHash": scene_blob_hash,
            "sourceRevision": {
                "revisionId": revision_id,
                "revisionKind": "content_hash",
                "value": scene_blob_hash,
            },
            "path": format!("REALLIVEDATA/Seen.txt#scene-{:04}", scene.scene_id),
        }));

        for unit in &scene.units {
            units_json.push(build_unit_json(
                scene.scene_id,
                &asset_id,
                &asset_key,
                &revision_id,
                &scene_blob_hash,
                &scene_namespace,
                opts,
                unit,
            )?);
        }
    }

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
        "sourceBundleHash": seen_hash,
        "sourceBundleRevision": {
            "revisionId": seen_revision_id,
            "revisionKind": "content_hash",
            "value": seen_hash,
        },
        "sourceLocale": opts.source_locale,
        "hashStrategy": {
            "sourceProfile": {
                "scope": "source_profile",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
            "sourceBundle": {
                "scope": "source_bundle",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
            "sourceAsset": {
                "scope": "source_asset",
                "algorithm": "sha256",
                "normalization": "bytes",
            },
            "sourceUnit": {
                "scope": "source_unit",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
                "fields": ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
            },
            "patchExport": {
                "scope": "patch_export",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
            "deltaPackage": {
                "scope": "delta_package",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
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
                reason: format!("end_byte exceeds sourceText length {}", source_text.len()),
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
                    "byte range covers {} but span.raw is {}",
                    RedactedContentSummary::from_bytes(actual),
                    RedactedContentSummary::from_text(&span.raw),
                ),
            });
        }
        let mut span_json = json!({
            "spanId": deterministic_uuid7(namespace, &format!("span-{}-{}", unit.occurrence_index, idx)),
            "spanKind": "control_markup",
            "raw": span.raw,
            "startByte": span.start_byte,
            "endByte": span.end_byte,
            "preserveMode": "exact",
            "parsedName": span.parsed_name,
        });
        // This flag mirrors `REALLIVE_OUT_OF_BAND_MARKER_OPEN` in patchback:
        // the extractor knows which synthetic spans are re-emitted structurally.
        if span.out_of_band {
            span_json["outOfBand"] = json!(true);
        }
        spans_json.push(span_json);
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

    let speaker = build_speaker_json(namespace, &unit.resolution);

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

/// Build the v0.2 speaker object for one line from its typed resolution.
/// A resolved name is emitted as `known` (reader sees the real name) or
/// `reader_unknown` (reader sees a mask) — NEVER mislabelled as
/// `parser_unknown`, which is reserved for genuinely-unresolved speakers.
/// The `textColor` (RGB) and `revealState` keys are additive extensions:
/// both are derived from real Gameexe data (never a default) and are
/// tolerated by the v0.2 validators (no `deny_unknown_fields`). The
/// reader-safe label is `displayName` for a revealed speaker and
/// `readerLabel` for a concealed one, so a reader-facing surface never has
/// to show a spoiler identity.
fn build_speaker_json(namespace: &str, resolution: &SpeakerResolution) -> Value {
    match resolution {
        SpeakerResolution::Revealed {
            display_name,
            canonical_ref,
            color,
        } => {
            let mut speaker = json!({
                "knowledgeState": "known",
                "speakerId": deterministic_speaker_id(namespace, canonical_ref),
                "displayName": display_name,
                "canonicalNameRef": canonical_ref,
                "revealState": "revealed",
            });
            if let Some([r, g, b]) = color {
                speaker["textColor"] = json!([r, g, b]);
            }
            speaker
        }
        SpeakerResolution::Concealed {
            display_name,
            reader_label,
            canonical_ref,
            color,
        } => {
            let mut speaker = json!({
                "knowledgeState": "reader_unknown",
                "speakerId": deterministic_speaker_id(namespace, canonical_ref),
                "displayName": display_name,
                "readerLabel": reader_label,
                "canonicalNameRef": canonical_ref,
                "revealState": "concealed",
            });
            if let Some([r, g, b]) = color {
                speaker["textColor"] = json!([r, g, b]);
            }
            speaker
        }
        SpeakerResolution::ParserUnknown { raw, evidence } => json!({
            "knowledgeState": "parser_unknown",
            "rawSpeakerText": raw,
            "evidence": evidence,
        }),
        SpeakerResolution::NotApplicable => json!({ "knowledgeState": "not_applicable" }),
    }
}

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests_scene;
#[cfg(test)]
mod tests_speaker;
