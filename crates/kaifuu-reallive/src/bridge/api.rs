use super::*;

/// Caller-supplied knobs for [`produce_bundle`].
/// All fields are required; there are no silent defaults that would
/// hide a mis-specified call site.
#[derive(Debug, Clone)]
pub struct BridgeOpts<'a> {
    /// Stable game id (e.g. `"example-game"`).
    pub game_id: &'a str,
    /// Human-readable game version label.
    pub game_version: &'a str,
    /// Source-profile id (stable per kaifuu extractor profile).
    pub source_profile_id: &'a str,
    /// Source locale tag for the decoded text (for example, `"ja-JP"`).
    pub source_locale: &'a str,
    /// Extractor name embedded in `extractor.name`.
    pub extractor_name: &'a str,
    /// Extractor version embedded in `extractor.version`.
    pub extractor_version: &'a str,
    /// Number of kidoku-table entries declared in the scene header.
    /// A scene can declare `kidoku_count > 0` without an inline `0x40`
    /// MetaKidoku marker: RealLive's read-tracking is table-driven as well
    /// as inline. When the inline walk produced no
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
