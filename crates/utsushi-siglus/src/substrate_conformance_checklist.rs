//! Cross-engine substrate-conformance checklist for the Siglus port.
//!
//! Each row names a **concrete substrate facade method** (for example
//! [`TextSurfaceSink::emit_line`](utsushi_core::substrate::TextSurfaceSink::emit_line))
//! and the **Siglus-side expected event shape** that must land on that method.
//! Lineage notes are not free-form marketing: they are validated against the
//! existing AVG32 → RealLive → Siglus conformance framework (Appendix M in
//! `docs/research/reallive-engine.md`, the facade contract, and the
//! cross-engine alignment fixture).
//!
//! A malformed lineage note — empty carrier, unknown facade method, missing
//! framework anchor, or a reuse claim that does not cite the carrier — fails
//! [`validate_checklist_entry`].

use thiserror::Error;

/// Framework anchors a lineage note may cite.
const ALLOWED_FRAMEWORK_ANCHORS: &[&str] = &[
    "docs/research/reallive-engine.md",
    "docs/utsushi-substrate-facade.md",
    "crates/utsushi-siglus/tests/cross_engine_substrate_alignment.rs",
    "crates/utsushi-core/src/substrate.rs",
];

/// Substrate facade methods the checklist may name.
const KNOWN_FACADE_METHODS: &[&str] = &[
    "TextSurfaceSink::emit_line",
    "TextSurfaceSink::drain_lines",
    "FrameArtifactSink::emit_frame",
    "AudioEventSink::emit_event",
    "AssetPackage::open",
    "AssetPackage::resolve",
    "EnginePort::launch",
    "EnginePort::observe",
    "EnginePort::capture",
    "EnginePort::shutdown",
    "EnginePort::sink_set",
    "Inspectable::inspect_state",
    "take_snapshot",
    "SinkSet::drain_text",
    "SinkSet::drain_frame",
];

/// Substrate carrier type/trait names Appendix M and the facade contract use.
const KNOWN_SUBSTRATE_CARRIERS: &[&str] = &[
    "TextSurfaceSink",
    "TextLine",
    "FrameArtifactSink",
    "FrameArtifact",
    "AudioEventSink",
    "AudioEvent",
    "AssetPackage",
    "EnginePort",
    "PortManifest",
    "SinkSet",
    "CaptureOutcome",
    "Inspectable",
    "Restorable",
    "SnapshotStore",
    "ReplayLog",
    "LogicalClockTick",
    "StateTree",
    "StatePath",
    "ChoiceIndex",
];

/// Payload types the Siglus side may claim as an expected event shape.
const KNOWN_EVENT_PAYLOADS: &[&str] = &[
    "TextLine",
    "FrameArtifact",
    "AudioEvent",
    "CaptureOutcome",
    "AssetBytes",
    "Snapshot",
    "StateTree",
];

/// How the carrier is consumed today relative to the Appendix M vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineageConsumption {
    /// Both RealLive and Siglus import/use the carrier today (scaffold baseline).
    Scaffold,
    /// RealLive consumes the carrier; Siglus has a forward expectation only.
    RealliveOnly,
    /// Siglus now wires the carrier for a real (or smoke) behavioural path.
    SiglusWired,
    /// Engine-local surface with no facade carrier (not allowed on checklist rows).
    EngineLocal,
}

/// Siglus-side expected event shape for one facade method.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SiglusExpectedEventShape {
    /// Substrate payload type name (e.g. `TextLine`, `CaptureOutcome`).
    pub payload_type: &'static str,
    /// Field-level shape the Siglus side produces (engine-neutral payload).
    pub fields: &'static str,
    /// Evidence-tier ceiling the event is admitted at (e.g. `E1`, `E2`).
    pub evidence_tier: &'static str,
    /// Siglus producer that feeds the facade method (module path or type).
    pub siglus_source: &'static str,
}

/// A lineage note that must validate against the existing conformance framework.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineageNote {
    /// Path into the existing framework (may include a `#fragment`).
    pub framework_anchor: &'static str,
    /// Concrete substrate type/trait that carries the reuse claim.
    pub substrate_carrier: &'static str,
    /// Consumption class from the Appendix M vocabulary.
    pub consumption: LineageConsumption,
    /// Code-reuse citation. Must mention `substrate_carrier` by name.
    pub code_reuse_point: &'static str,
}

/// One checklist row: facade method + Siglus event shape + validated lineage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChecklistEntry {
    /// Concrete substrate facade method, e.g. `TextSurfaceSink::emit_line`.
    pub facade_method: &'static str,
    /// Siglus-side expected event shape for that method.
    pub expected_event_shape: SiglusExpectedEventShape,
    /// Lineage note validated against the existing framework.
    pub lineage: LineageNote,
}

/// Why a checklist entry or lineage note failed validation.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ChecklistError {
    /// Facade method string is empty or not in the known-facade-method set.
    #[error("unknown or empty facade method: {0}")]
    UnknownFacadeMethod(String),
    /// Expected event payload type is empty or not in the known payload set.
    #[error("unknown or empty event payload type: {0}")]
    UnknownEventPayload(String),
    /// Event-shape field description is empty.
    #[error("expected event shape fields description is empty")]
    EmptyEventFields,
    /// Evidence tier token is empty.
    #[error("expected event shape evidence_tier is empty")]
    EmptyEvidenceTier,
    /// Siglus source producer path is empty.
    #[error("expected event shape siglus_source is empty")]
    EmptySiglusSource,
    /// Lineage framework anchor is empty or not under an allowed path.
    #[error("lineage framework_anchor is not under the existing framework: {0}")]
    InvalidFrameworkAnchor(String),
    /// Lineage substrate carrier is empty or not a known facade carrier.
    #[error("lineage substrate_carrier is unknown or empty: {0}")]
    UnknownSubstrateCarrier(String),
    /// Reuse claim is empty or does not cite the carrier (marketing-only).
    #[error("lineage code_reuse_point must cite substrate_carrier {carrier:?}; got: {claim:?}")]
    MarketingOnlyReuseClaim {
        /// Expected carrier name that must appear in the claim.
        carrier: String,
        /// The claim text that failed the citation check.
        claim: String,
    },
    /// Engine-local rows do not belong on the substrate checklist.
    #[error("engine-local lineage consumption is not a substrate checklist row")]
    EngineLocalNotAllowed,
    /// Facade method's type name and lineage carrier disagree.
    #[error("facade method type {method_type:?} does not match lineage carrier {carrier:?}")]
    FacadeCarrierMismatch {
        /// Type portion of the facade method (before `::`).
        method_type: String,
        /// Lineage substrate carrier.
        carrier: String,
    },
}

/// Allowed framework anchor paths (for tests and external lints).
pub fn allowed_framework_anchors() -> &'static [&'static str] {
    ALLOWED_FRAMEWORK_ANCHORS
}

/// The committed Siglus cross-engine substrate-conformance checklist.
pub fn siglus_substrate_conformance_checklist() -> &'static [ChecklistEntry] {
    SIGLUS_CHECKLIST
}

const SIGLUS_CHECKLIST: &[ChecklistEntry] = &[
    ChecklistEntry {
        facade_method: "TextSurfaceSink::emit_line",
        expected_event_shape: SiglusExpectedEventShape {
            payload_type: "TextLine",
            fields: "line_id=utsushi-siglus-vm/line/{n}; evidence_tier=E1; text; optional speaker; \
                     text_surface=Some(\"adv\"); color/bridge_ref/source_asset/body_shift_jis=None",
            evidence_tier: "E1",
            siglus_source: "crates/utsushi-siglus/src/vm.rs::SiglusTraceVm::run \
                            (SiglusTraceOp::EmitText → TextSurfaceSink::emit_line)",
        },
        lineage: LineageNote {
            framework_anchor: "docs/research/reallive-engine.md#m-1-reusable-across-engines",
            substrate_carrier: "TextSurfaceSink",
            consumption: LineageConsumption::SiglusWired,
            code_reuse_point: "Appendix M.1 headless sink pipeline: TextSurfaceSink carries \
                               engine-neutral TextLine; Siglus VM smoke emits through \
                               TextSurfaceSink::emit_line (RealLive module_msg opcodes do not transfer).",
        },
    },
    ChecklistEntry {
        facade_method: "EnginePort::capture",
        expected_event_shape: SiglusExpectedEventShape {
            payload_type: "CaptureOutcome",
            fields: "artifact URI under artifacts/utsushi/runtime/.../siglus-g00-redacted; \
                     optional host path from RuntimeArtifactRoot::write_bytes; \
                     summary=siglus-g00 capture: {w}x{h} layers={n} redacted=true",
            evidence_tier: "E2",
            siglus_source: "crates/utsushi-siglus/src/cg_port.rs::UtsushiSiglusPort::capture \
                            (decode_siglus_g00 → render_siglus_cg EdgeOutline → encode_siglus_png)",
        },
        lineage: LineageNote {
            framework_anchor: "docs/research/reallive-engine.md#m-1-reusable-across-engines",
            substrate_carrier: "EnginePort",
            consumption: LineageConsumption::SiglusWired,
            code_reuse_point: "Appendix M.1 port-shape row: EnginePort + REQUIRED_LIFECYCLE_STAGES \
                               are shared; Siglus wires Launch/Capture/Shutdown for the G00 CG slice \
                               while Observe remains Pending (parity profile).",
        },
    },
    ChecklistEntry {
        facade_method: "AssetPackage::open",
        expected_event_shape: SiglusExpectedEventShape {
            payload_type: "AssetBytes",
            fields: "VfsResult<AssetBytes> from package.open after package.resolve(logical G00 path): \
                     package-relative G00 bytes; no host path on the VFS surface; \
                     decode feeds EnginePort::capture",
            evidence_tier: "E2",
            siglus_source: "crates/utsushi-siglus/src/cg_port.rs::UtsushiSiglusPort::load_image",
        },
        lineage: LineageNote {
            framework_anchor: "docs/utsushi-substrate-facade.md",
            substrate_carrier: "AssetPackage",
            consumption: LineageConsumption::Scaffold,
            code_reuse_point: "Facade Runtime VFS row: AssetPackage is the shared open/resolve \
                               surface; Siglus G00 path uses AssetPackage::open for package-relative \
                               CG bytes (RealLive Seen.txt layout does not transfer).",
        },
    },
    ChecklistEntry {
        facade_method: "Inspectable::inspect_state",
        expected_event_shape: SiglusExpectedEventShape {
            payload_type: "StateTree",
            fields: "port.halted; port.program-counter; port.emitted-line-count; \
                     port.program-digest; port.flag.*; port.int.* (StatePath segments)",
            evidence_tier: "E1",
            siglus_source: "crates/utsushi-siglus/src/vm.rs::SiglusTraceVm (Inspectable impl)",
        },
        lineage: LineageNote {
            framework_anchor: "docs/research/reallive-engine.md#m-1-reusable-across-engines",
            substrate_carrier: "Inspectable",
            consumption: LineageConsumption::SiglusWired,
            code_reuse_point: "Appendix M.1 variable banks / snapshot row: Inspectable + StateTree \
                               are bank-shape-neutral; Siglus VM smoke implements Inspectable for \
                               flag/int banks (26-letter bank extension is a forward RealLive→Siglus claim).",
        },
    },
];

/// Validate one checklist entry against the facade method set and lineage framework.
pub fn validate_checklist_entry(entry: &ChecklistEntry) -> Result<(), ChecklistError> {
    if entry.facade_method.is_empty() || !KNOWN_FACADE_METHODS.contains(&entry.facade_method) {
        return Err(ChecklistError::UnknownFacadeMethod(
            entry.facade_method.to_string(),
        ));
    }
    validate_event_shape(&entry.expected_event_shape)?;
    validate_lineage_note(&entry.lineage)?;
    ensure_facade_matches_carrier(entry.facade_method, entry.lineage.substrate_carrier)?;
    Ok(())
}

/// Validate every entry in a checklist slice.
pub fn validate_checklist(entries: &[ChecklistEntry]) -> Result<(), ChecklistError> {
    for entry in entries {
        validate_checklist_entry(entry)?;
    }
    Ok(())
}

fn validate_event_shape(shape: &SiglusExpectedEventShape) -> Result<(), ChecklistError> {
    if shape.payload_type.is_empty() || !KNOWN_EVENT_PAYLOADS.contains(&shape.payload_type) {
        return Err(ChecklistError::UnknownEventPayload(
            shape.payload_type.to_string(),
        ));
    }
    if shape.fields.trim().is_empty() {
        return Err(ChecklistError::EmptyEventFields);
    }
    if shape.evidence_tier.trim().is_empty() {
        return Err(ChecklistError::EmptyEvidenceTier);
    }
    if shape.siglus_source.trim().is_empty() {
        return Err(ChecklistError::EmptySiglusSource);
    }
    Ok(())
}

/// Validate a lineage note against the existing conformance framework.
pub fn validate_lineage_note(note: &LineageNote) -> Result<(), ChecklistError> {
    if matches!(note.consumption, LineageConsumption::EngineLocal) {
        return Err(ChecklistError::EngineLocalNotAllowed);
    }
    if !framework_anchor_allowed(note.framework_anchor) {
        return Err(ChecklistError::InvalidFrameworkAnchor(
            note.framework_anchor.to_string(),
        ));
    }
    if note.substrate_carrier.is_empty()
        || !KNOWN_SUBSTRATE_CARRIERS.contains(&note.substrate_carrier)
    {
        return Err(ChecklistError::UnknownSubstrateCarrier(
            note.substrate_carrier.to_string(),
        ));
    }
    if note.code_reuse_point.trim().is_empty()
        || !note.code_reuse_point.contains(note.substrate_carrier)
    {
        return Err(ChecklistError::MarketingOnlyReuseClaim {
            carrier: note.substrate_carrier.to_string(),
            claim: note.code_reuse_point.to_string(),
        });
    }
    Ok(())
}

fn framework_anchor_allowed(anchor: &str) -> bool {
    if anchor.is_empty() {
        return false;
    }
    let path = anchor.split('#').next().unwrap_or(anchor);
    ALLOWED_FRAMEWORK_ANCHORS.contains(&path)
}

fn ensure_facade_matches_carrier(facade_method: &str, carrier: &str) -> Result<(), ChecklistError> {
    let Some((method_type, _)) = facade_method.split_once("::") else {
        return Ok(());
    };
    if method_type == carrier {
        return Ok(());
    }
    let related = matches!(
        (method_type, carrier),
        ("EnginePort" | "AssetPackage", "CaptureOutcome")
            | ("EnginePort", "PortManifest")
            | ("Inspectable", "StateTree" | "SnapshotStore")
            | ("TextSurfaceSink", "TextLine")
            | ("FrameArtifactSink", "FrameArtifact")
            | ("AudioEventSink", "AudioEvent")
            | ("AssetPackage", "EnginePort")
    );
    if related {
        return Ok(());
    }
    Err(ChecklistError::FacadeCarrierMismatch {
        method_type: method_type.to_string(),
        carrier: carrier.to_string(),
    })
}

/// Compile-time witness: checklist-named types resolve through the facade.
fn _facade_method_types_resolve() {
    use utsushi_core::substrate::{
        AssetPackage, CaptureOutcome, EnginePort, Inspectable, TextLine, TextSurfaceSink,
    };
    // EnginePort is not dyn-compatible (associated consts); the trait bound
    // witness below is enough to pin the facade re-export.
    fn assert_engine_port_bound<P: EnginePort>() {
        let _ = P::MANIFEST;
    }
    let _: Option<&dyn TextSurfaceSink> = None;
    let _: Option<&dyn AssetPackage> = None;
    let _: Option<&dyn Inspectable> = None;
    let _: Option<TextLine> = None;
    let _: Option<CaptureOutcome> = None;
    let _ = assert_engine_port_bound::<crate::UtsushiSiglusPort>;
}
