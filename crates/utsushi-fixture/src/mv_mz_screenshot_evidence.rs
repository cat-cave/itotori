//! UTSUSHI-065: attach narrow SCREENSHOT CAPTURE evidence to MV/MZ runtime
//! traces.
//!
//! This module builds a *narrow* runtime-evidence report that links RPG Maker
//! MV/MZ map / common-event command ids to runtime trace event ids and, in
//! turn, to screenshot artifact references. It is deliberately NOT the broad
//! runtime conformance manifest: it proves only that a run emitted (a) runtime
//! trace events for a set of MV/MZ commands and (b) one screenshot artifactRef
//! per traced command, with the two sides linked by a shared `bridgeUnitRef`
//! and `frame` id, plus an explicit `evidencesTraceEventId` back-reference.
//!
//! ## What links to what
//!
//! ```text
//! map / common-event command id     trace event id           screenshot artifactRef
//! (mvCommandRef + sourceUnitKey) -> (traceEventId, frame) -> (artifactRef.uri, artifactId)
//!                    \___________ shared bridgeUnitRef + frame ___________/
//! ```
//!
//! Every command produces exactly one trace event and one screenshot capture.
//! They carry the SAME `bridgeUnitRef` (the deterministic KAIFUU-109 bridge
//! unit id derived from the command's `rpgmaker:<file>#<pointer>` source key)
//! and the SAME `frame` id, and the capture additionally records
//! `evidencesTraceEventId` so the screenshot -> trace link is explicit rather
//! than positional.
//!
//! ## Capture metadata
//!
//! The report records a top-level [`capture metadata`](CaptureMetadata) block —
//! the browser viewport, device scale factor, and capture adapter — describing
//! the screenshot capture context. Each screenshot capture repeats the same
//! metadata inline so an isolated capture entry is self-describing.
//!
//! ## Builds on UTSUSHI-006 + runtime artifact storage
//!
//! The screenshot side reuses the UTSUSHI-006 browser capture path shape: the
//! screenshot artifactRef is a managed [`RuntimeArtifactKind::Screenshot`]
//! reference under the runtime artifact root (via [`runtime_artifact_uri`]),
//! and a frame `observationHookEvent` mirrors
//! `browser_frame_observation_hook_event`. A [`ScreenshotEvidenceRef`] can be
//! built either synthetically (the deterministic, browser-free fixture path) or
//! [`from a real captured artifact`](ScreenshotEvidenceRef::from_captured_artifact)
//! produced by the browser adapter — so the REAL screenshot is env-gated behind
//! Chromium while the artifactRef / linkage / metadata logic here is exercised
//! without a live browser.

use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use utsushi_core::{
    EvidenceTier, RuntimeArtifactKind, RuntimeArtifactRoot, RuntimeCapturedArtifact, UtsushiResult,
    runtime_artifact_uri,
};

use crate::FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL;

/// KAIFUU-109 fixture-profile id the bridge-unit id derivation is namespaced
/// with. Matching the value `kaifuu-rpgmaker` stamps its map / common-event
/// units with means the bridge unit ids this fixture emits are byte-identical
/// to the ones the decompiler would emit for the same command — the linkage is
/// faithful to the real MV/MZ bridge, not a fixture-local invention.
const KAIFUU_MV_MZ_FIXTURE_PROFILE_ID: &str = "KAIFUU-109";

/// Namespace for the runtime-report / trace / capture / screenshot uuid7s this
/// module mints. Distinct from the KAIFUU-109 bridge namespace so runtime ids
/// never collide with bridge unit ids.
const EVIDENCE_UUID_NAMESPACE: &str = "utsushi-u065:mvmz-screenshot-evidence";

/// The deterministic synthetic screenshot payload the browser-free fixture
/// path materializes into the runtime artifact root. It is a minimal PNG magic
/// prefix followed by a clearly-synthetic marker: no raw copyrighted pixels are
/// ever committed or written — a real screenshot is produced only on the
/// env-gated browser capture path.
const SYNTHETIC_SCREENSHOT_BYTES: &[u8] =
    b"\x89PNG\r\n\x1a\nutsushi mvmz synthetic screenshot placeholder\n";

/// The screenshot capture context recorded alongside the evidence: the browser
/// viewport, device scale factor, and capture adapter.
#[derive(Clone, Debug, PartialEq)]
pub struct CaptureMetadata {
    pub viewport_width: u64,
    pub viewport_height: u64,
    pub device_scale_factor: f64,
    pub adapter: String,
}

impl CaptureMetadata {
    fn to_json(&self) -> Value {
        json!({
            "viewport": {
                "width": self.viewport_width,
                "height": self.viewport_height,
            },
            "deviceScaleFactor": self.device_scale_factor,
            "adapter": self.adapter,
        })
    }
}

/// A portable screenshot artifact reference the evidence attaches to a trace.
///
/// It is deliberately a subset of the runtime artifactRef wire shape so it can
/// be built from either a deterministic synthetic screenshot or a real
/// [`RuntimeCapturedArtifact`] the UTSUSHI-006 browser adapter produced.
#[derive(Clone, Debug, PartialEq)]
pub struct ScreenshotEvidenceRef {
    pub artifact_id: String,
    pub uri: String,
    pub media_type: String,
    pub byte_size: u64,
}

impl ScreenshotEvidenceRef {
    /// Build a screenshot reference from a real captured artifact (e.g. the one
    /// the browser adapter persisted to the runtime artifact root). The artifact
    /// MUST be a screenshot; any other kind is a hard error rather than a
    /// silently mislabelled reference.
    pub fn from_captured_artifact(artifact: &RuntimeCapturedArtifact) -> UtsushiResult<Self> {
        if artifact.artifact_kind != RuntimeArtifactKind::Screenshot {
            return Err(format!(
                "screenshot evidence requires a screenshot artifact, got {}",
                artifact.artifact_kind.artifact_kind()
            )
            .into());
        }
        Ok(Self {
            artifact_id: artifact.artifact_id.clone(),
            uri: artifact.uri.clone(),
            media_type: artifact
                .media_type
                .clone()
                .unwrap_or_else(|| "image/png".to_string()),
            byte_size: artifact.byte_size,
        })
    }

    fn to_artifact_ref_json(&self) -> Value {
        json!({
            "artifactId": self.artifact_id,
            "artifactKind": RuntimeArtifactKind::Screenshot.artifact_kind(),
            "uri": self.uri,
            "mediaType": self.media_type,
            "byteSize": self.byte_size,
        })
    }
}

/// A single MV/MZ command lifted from the fixture, resolved to its stable
/// pointer / source key / bridge unit id (the KAIFUU-109 scheme).
struct MvMzCommand {
    source_file: String,
    container_kind: &'static str,
    container_id: i64,
    container_index: usize,
    page_index: Option<usize>,
    command_index: usize,
    option_index: Option<usize>,
    code: i64,
    text_role: String,
    source_text: String,
    pointer: String,
    source_unit_key: String,
    bridge_unit_id: String,
}

impl MvMzCommand {
    fn parse(command: &Value, index: usize) -> UtsushiResult<Self> {
        let source_file = require_str(command, "sourceFile", index)?.to_string();
        let command_index = require_usize(command, "commandIndex", index)?;
        let option_index = match command.get("optionIndex") {
            Some(value) => Some(usize::try_from(value.as_u64().ok_or_else(|| {
                format!("mvmz command[{index}].optionIndex must be a non-negative integer")
            })?)?),
            None => None,
        };
        let code = command
            .get("code")
            .and_then(Value::as_i64)
            .ok_or_else(|| format!("mvmz command[{index}].code must be an integer"))?;
        let text_role = require_str(command, "textRole", index)?.to_string();
        let source_text = require_str(command, "sourceText", index)?.to_string();

        let container = command
            .get("container")
            .ok_or_else(|| format!("mvmz command[{index}].container is required"))?;
        let kind = require_str(container, "kind", index)?;

        let (container_kind, container_id, container_index, page_index, pointer_base) = match kind {
            "map_event" => {
                let event_id = require_i64(container, "eventId", index)?;
                let event_index = require_usize(container, "eventIndex", index)?;
                let page_index = require_usize(container, "pageIndex", index)?;
                // Matches kaifuu-rpgmaker::map_common_event::extract_map:
                // /events/<event_index>/pages/<page_index>/list
                let base = vec![
                    "events".to_string(),
                    event_index.to_string(),
                    "pages".to_string(),
                    page_index.to_string(),
                    "list".to_string(),
                ];
                ("map_event", event_id, event_index, Some(page_index), base)
            }
            "common_event" => {
                let common_event_id = require_i64(container, "commonEventId", index)?;
                let entry_index = require_usize(container, "entryIndex", index)?;
                // Matches kaifuu-rpgmaker::extract_common_events:
                // /<entry_index>/list
                let base = vec![entry_index.to_string(), "list".to_string()];
                ("common_event", common_event_id, entry_index, None, base)
            }
            other => {
                return Err(format!(
                    "mvmz command[{index}].container.kind must be map_event or common_event, got {other}"
                )
                .into());
            }
        };

        // Command-text pointer suffix, mirroring the KAIFUU-109 extractor:
        // show_text -> list/<cmd>/parameters/0
        // choice_option -> list/<cmd>/parameters/0/<option_index>
        let mut pointer_tokens = pointer_base;
        pointer_tokens.push(command_index.to_string());
        pointer_tokens.push("parameters".to_string());
        pointer_tokens.push("0".to_string());
        if let Some(option_index) = option_index {
            pointer_tokens.push(option_index.to_string());
        }
        let pointer = rfc6901_pointer(&pointer_tokens);
        let source_unit_key = format!("rpgmaker:{source_file}#{pointer}");
        let bridge_unit_id = deterministic_uuid7(
            &format!("rpgmaker-k109:{KAIFUU_MV_MZ_FIXTURE_PROFILE_ID}"),
            &format!("unit-{source_unit_key}"),
        );

        Ok(Self {
            source_file,
            container_kind,
            container_id,
            container_index,
            page_index,
            command_index,
            option_index,
            code,
            text_role,
            source_text,
            pointer,
            source_unit_key,
            bridge_unit_id,
        })
    }

    fn bridge_unit_ref(&self) -> Value {
        json!({
            "bridgeUnitId": self.bridge_unit_id,
            "sourceUnitKey": self.source_unit_key,
        })
    }

    /// The MV/MZ command coordinate block: the map / common-event command id
    /// the trace event and screenshot both evidence.
    fn mv_command_ref(&self) -> Value {
        let mut value = json!({
            "sourceFile": self.source_file,
            "containerKind": self.container_kind,
            "containerId": self.container_id,
            "containerIndex": self.container_index,
            "commandIndex": self.command_index,
            "code": self.code,
            "textRole": self.text_role,
            "pointer": self.pointer,
        });
        let object = value.as_object_mut().expect("mvCommandRef is an object");
        if let Some(page_index) = self.page_index {
            object.insert("pageIndex".to_string(), json!(page_index));
        }
        if let Some(option_index) = self.option_index {
            object.insert("optionIndex".to_string(), json!(option_index));
        }
        value
    }
}

/// Build the narrow MV/MZ screenshot-evidence report from the parsed fixture
/// document and one screenshot reference per command.
///
/// The linkage is positional-by-frame: command `i` (frame `i + 1`) produces the
/// trace event and screenshot capture that share command `i`'s bridge unit ref,
/// and `screenshots[i]` is the artifactRef that capture points at. The pure
/// builder performs NO IO and needs NO browser — the same report is produced
/// whether `screenshots` come from synthetic placeholders or a live capture.
pub fn build_mv_mz_screenshot_evidence(
    fixture: &Value,
    screenshots: &[ScreenshotEvidenceRef],
    capture_metadata: &CaptureMetadata,
) -> UtsushiResult<Value> {
    let game_id = fixture
        .get("gameId")
        .and_then(Value::as_str)
        .ok_or("mvmz fixture missing gameId")?;
    let source_locale = fixture
        .get("sourceLocale")
        .and_then(Value::as_str)
        .unwrap_or("und");
    let adapter = fixture
        .get("adapter")
        .ok_or("mvmz fixture missing adapter")?;
    let adapter_name = adapter
        .get("name")
        .and_then(Value::as_str)
        .ok_or("mvmz fixture adapter missing name")?;
    let adapter_version = adapter
        .get("version")
        .and_then(Value::as_str)
        .ok_or("mvmz fixture adapter missing version")?;

    let commands = fixture
        .get("commands")
        .and_then(Value::as_array)
        .ok_or("mvmz fixture missing commands array")?;
    if commands.is_empty() {
        return Err("mvmz fixture commands must not be empty".into());
    }
    if commands.len() != screenshots.len() {
        return Err(format!(
            "mvmz screenshot evidence needs one screenshot per command: {} commands, {} screenshots",
            commands.len(),
            screenshots.len()
        )
        .into());
    }

    let runtime_report_id =
        deterministic_uuid7(EVIDENCE_UUID_NAMESPACE, &format!("report-{game_id}"));

    let mut trace_events = Vec::with_capacity(commands.len());
    let mut captures = Vec::with_capacity(commands.len());
    let mut observation_events = Vec::with_capacity(commands.len());
    let mut bridge_refs = Vec::with_capacity(commands.len());
    let capture_metadata_json = capture_metadata.to_json();

    for (index, command_value) in commands.iter().enumerate() {
        let command = MvMzCommand::parse(command_value, index)?;
        let frame = u64::try_from(index + 1)?;
        let bridge_unit_ref = command.bridge_unit_ref();
        let mv_command_ref = command.mv_command_ref();
        let screenshot = &screenshots[index];

        let trace_event_id = deterministic_uuid7(
            EVIDENCE_UUID_NAMESPACE,
            &format!("trace-{}", command.source_unit_key),
        );
        let capture_id = deterministic_uuid7(
            EVIDENCE_UUID_NAMESPACE,
            &format!("capture-{}", command.source_unit_key),
        );
        let observation_id = deterministic_uuid7(
            EVIDENCE_UUID_NAMESPACE,
            &format!("frame-observation-{}", command.source_unit_key),
        );

        trace_events.push(json!({
            "traceEventId": trace_event_id,
            "eventKind": "text_observed",
            "bridgeUnitRef": bridge_unit_ref,
            "frame": frame,
            "traceKey": command.source_unit_key,
            "observedText": command.source_text,
            "mvCommandRef": mv_command_ref,
        }));

        // The screenshot capture links back to the trace event it evidences
        // (evidencesTraceEventId) and forward to the managed screenshot
        // artifactRef, sharing the trace's bridgeUnitRef + frame.
        captures.push(json!({
            "captureId": capture_id,
            "bridgeUnitRef": bridge_unit_ref,
            "evidenceTier": EvidenceTier::E2.as_str(),
            "frame": frame,
            "width": capture_metadata.viewport_width,
            "height": capture_metadata.viewport_height,
            "evidencesTraceEventId": trace_event_id,
            "mvCommandRef": mv_command_ref,
            "captureMetadata": capture_metadata_json,
            "artifactRef": screenshot.to_artifact_ref_json(),
        }));

        // Frame observation-hook event, mirroring the UTSUSHI-006 browser
        // capture path so the screenshot evidence is also attached on the
        // observation-hook surface.
        observation_events.push(json!({
            "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
            "eventId": observation_id,
            "observedAt": "2026-06-17T00:00:00.000Z",
            "eventKind": "frame",
            "runtimeTargetId": format!("mvmz:{game_id}"),
            "adapterId": {
                "name": adapter_name,
                "version": adapter_version,
            },
            "evidenceTier": EvidenceTier::E2.as_str(),
            "environment": {
                "runtime": "mvmz-screenshot-evidence",
                "engine": "rpg_maker_mv_mz",
                "display": capture_metadata.adapter,
                "locale": source_locale,
            },
            "sourceRevision": {
                "sourceId": game_id,
                "revisionId": "mvmz-screenshot-evidence-v0.1",
            },
            "bridgeRefs": [bridge_unit_ref],
            "redaction": {"status": "not_required"},
            "payload": {
                "payloadKind": "frame",
                "frame": frame,
                "width": capture_metadata.viewport_width,
                "height": capture_metadata.viewport_height,
                "evidencesTraceEventId": trace_event_id,
                "artifactRef": screenshot.to_artifact_ref_json(),
            },
        }));

        bridge_refs.push(bridge_unit_ref);
    }

    Ok(json!({
        "schemaVersion": "0.2.0",
        "runtimeReportId": runtime_report_id,
        "sourceLocale": source_locale,
        "adapterName": adapter_name,
        "adapterVersion": adapter_version,
        "fidelityTier": "layout_probe",
        "evidenceTier": EvidenceTier::E2.as_str(),
        "status": "passed",
        "createdAt": "2026-06-17T00:00:00.000Z",
        "captureMetadata": capture_metadata_json,
        "traceEvents": trace_events,
        "observationHookEvents": observation_events,
        "branchEvents": [],
        "captures": captures,
        "recordings": [],
        "approximations": [
            {
                "approximationId": deterministic_uuid7(EVIDENCE_UUID_NAMESPACE, &format!("approximation-{game_id}")),
                "approximationTier": "layout_probe",
                "scope": "mvmz screenshot evidence",
                "description": "MV/MZ map / common-event command trace events are linked to screenshot artifactRefs by bridge unit ref + frame; this narrow evidence proves screenshot attachment, not reference-runtime fidelity.",
                "affectedBridgeUnitRefs": bridge_refs,
                "evidenceTierCeiling": EvidenceTier::E2.as_str(),
            }
        ],
        "validationFindings": [],
        "limitations": [
            "Synthetic public MV/MZ fixture; screenshot artifactRefs reference managed runtime artifacts, not live commercial-engine pixels.",
            "Narrow screenshot-evidence attachment only; not the broad runtime conformance manifest.",
        ],
    }))
}

/// Read the synthetic MV/MZ fixture at `input_root` and build its
/// screenshot-evidence report.
///
/// When `artifact_root` is provided the deterministic synthetic screenshot for
/// each command is materialized into the managed runtime artifact root (proving
/// the runtime artifact storage integration); the reference always points at the
/// managed [`runtime_artifact_uri`] regardless. No browser is launched — the
/// synthetic screenshot stands in for the env-gated real capture.
pub fn mv_mz_screenshot_evidence_report(
    input_root: &Path,
    artifact_root: Option<&Path>,
) -> UtsushiResult<Value> {
    let fixture: Value =
        serde_json::from_str(&fs::read_to_string(input_root.join("commands.json"))?)?;
    let capture_metadata = capture_metadata_from_fixture(&fixture)?;

    let game_id = fixture
        .get("gameId")
        .and_then(Value::as_str)
        .ok_or("mvmz fixture missing gameId")?;
    let runtime_report_id =
        deterministic_uuid7(EVIDENCE_UUID_NAMESPACE, &format!("report-{game_id}"));

    let commands = fixture
        .get("commands")
        .and_then(Value::as_array)
        .ok_or("mvmz fixture missing commands array")?;

    let prepared_root = match artifact_root {
        Some(root) => {
            let root = RuntimeArtifactRoot::new(root);
            root.prepare()?;
            Some(root)
        }
        None => None,
    };

    let mut screenshots = Vec::with_capacity(commands.len());
    for (index, command_value) in commands.iter().enumerate() {
        let command = MvMzCommand::parse(command_value, index)?;
        let artifact_id = deterministic_uuid7(
            EVIDENCE_UUID_NAMESPACE,
            &format!("screenshot-{}", command.source_unit_key),
        );
        let uri = runtime_artifact_uri(
            &runtime_report_id,
            RuntimeArtifactKind::Screenshot,
            &artifact_id,
        )?;
        if let Some(root) = &prepared_root {
            root.write_bytes(&uri, SYNTHETIC_SCREENSHOT_BYTES)?;
        }
        screenshots.push(ScreenshotEvidenceRef {
            artifact_id,
            uri,
            media_type: "image/png".to_string(),
            byte_size: u64::try_from(SYNTHETIC_SCREENSHOT_BYTES.len())?,
        });
    }

    build_mv_mz_screenshot_evidence(&fixture, &screenshots, &capture_metadata)
}

/// Parse the [`CaptureMetadata`] block from the fixture document.
pub fn capture_metadata_from_fixture(fixture: &Value) -> UtsushiResult<CaptureMetadata> {
    let metadata = fixture
        .get("captureMetadata")
        .ok_or("mvmz fixture missing captureMetadata")?;
    let viewport = metadata
        .get("viewport")
        .ok_or("mvmz fixture captureMetadata missing viewport")?;
    let viewport_width = viewport
        .get("width")
        .and_then(Value::as_u64)
        .ok_or("mvmz captureMetadata.viewport.width must be a positive integer")?;
    let viewport_height = viewport
        .get("height")
        .and_then(Value::as_u64)
        .ok_or("mvmz captureMetadata.viewport.height must be a positive integer")?;
    let device_scale_factor = metadata
        .get("deviceScaleFactor")
        .and_then(Value::as_f64)
        .ok_or("mvmz captureMetadata.deviceScaleFactor must be a number")?;
    let adapter = metadata
        .get("adapter")
        .and_then(Value::as_str)
        .ok_or("mvmz captureMetadata.adapter must be a string")?
        .to_string();
    if viewport_width == 0 || viewport_height == 0 {
        return Err("mvmz captureMetadata.viewport dimensions must be positive".into());
    }
    Ok(CaptureMetadata {
        viewport_width,
        viewport_height,
        device_scale_factor,
        adapter,
    })
}

fn require_str<'a>(value: &'a Value, key: &str, index: usize) -> UtsushiResult<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| format!("mvmz command[{index}].{key} must be a non-empty string").into())
}

fn require_i64(value: &Value, key: &str, index: usize) -> UtsushiResult<i64> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("mvmz command[{index}].{key} must be an integer").into())
}

fn require_usize(value: &Value, key: &str, index: usize) -> UtsushiResult<usize> {
    let raw =
        value
            .get(key)
            .and_then(Value::as_u64)
            .ok_or_else(|| -> Box<dyn std::error::Error> {
                format!("mvmz command[{index}].{key} must be a non-negative integer").into()
            })?;
    Ok(usize::try_from(raw)?)
}

/// Encode RFC6901 pointer tokens into a `/`-joined pointer string, escaping `~`
/// and `/` per the spec — identical to the KAIFUU-109 pointer encoding.
fn rfc6901_pointer(tokens: &[String]) -> String {
    let mut out = String::new();
    for token in tokens {
        out.push('/');
        out.push_str(&token.replace('~', "~0").replace('/', "~1"));
    }
    out
}

/// Deterministic uuid7-shaped id derived from a namespace + role via SHA-256.
/// Byte-for-byte identical to the derivation `kaifuu-rpgmaker` uses for its
/// bridge unit ids, so the two agree on the same command's bridge unit id.
fn deterministic_uuid7(namespace: &str, role: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(namespace.as_bytes());
    hasher.update(b":");
    hasher.update(role.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0F) | 0x70;
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
