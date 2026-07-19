//! Deterministic E0/E1 evidence emitted from plaintext KAG replay.
//!
//! This module composes the bounded plaintext replay with its source-order
//! command trace. The replay establishes which text and choice jumps actually
//! occur; the command trace supplies only bridge references tied to source
//! text. A pure `[jump]` tag has no extracted text unit, so it is deliberately
//! absent from the bridge-linked event stream rather than receiving an invented
//! identifier. A selected `[link]` choice does have an extracted visible-text
//! unit and therefore provides the bridge-linked label-jump event.

use serde::Serialize;
use utsushi_kirikiri::{KagEvent, RowKind, parse_kag, replay_kag, trace_kag_commands};

/// Stable schema label for [`KagReplayE0E1Trace`].
pub const KAG_REPLAY_E0_E1_SCHEMA_VERSION: &str = "utsushi-kirikiri-xp3-kag-replay-e0-e1/0.1.0";

/// Engine-family label emitted in every KAG plaintext replay trace.
pub const KAG_REPLAY_E0_E1_ENGINE_FAMILY: &str = "kirikiri_xp3";

/// Runtime label emitted in every KAG plaintext replay trace.
pub const KAG_PLAINTEXT_RUNTIME: &str = "kag-plaintext";

const SOURCE_EVIDENCE_TIER: &str = "E0";
const REPLAY_EVIDENCE_TIER: &str = "E1";

/// One already-plaintext KAG source passed to
/// [`emit_kag_replay_e0_e1_trace`]. `source_file` must be the same stable
/// filename the extraction adapter uses when it derives bridge-unit ids.
#[derive(Clone, Copy, Debug)]
pub struct KagReplayInput<'a> {
    /// Stable source filename used in the bridge identity namespace.
    pub source_file: &'a str,
    /// Plaintext KAG bytes.
    pub bytes: &'a [u8],
}

/// A deterministic E0 source + E1 replay evidence trace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct KagReplayE0E1Trace {
    /// Equals [`KAG_REPLAY_E0_E1_SCHEMA_VERSION`].
    pub schema_version: String,
    /// The KiriKiri XP3 engine family.
    pub engine_family: String,
    /// The bounded plaintext KAG runtime label.
    pub runtime: String,
    /// Evidence tier of the plaintext source fixture.
    pub source_evidence_tier: String,
    /// Evidence tier of the deterministic replay observations.
    pub evidence_tier: String,
    /// Bridge-linked text and selected-label-jump observations in input order.
    pub events: Vec<KagReplayE0E1Event>,
}

/// One bridge-linked observation from [`KagReplayE0E1Trace`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "event_type", rename_all = "snake_case")]
pub enum KagReplayE0E1Event {
    /// Text observed during the replay and linked to its extracted source unit.
    TextEvent {
        /// Real extraction bridge id for the observed source text.
        bridge_unit_id: String,
        /// Stable extraction source-unit key.
        source_unit_key: String,
        /// Stable source filename.
        source_file: String,
        /// Active speaker, if the source text has one.
        #[serde(skip_serializing_if = "Option::is_none")]
        speaker: Option<String>,
        /// Observed plaintext text.
        text: String,
        /// The replay evidence tier for this observation.
        evidence_tier: String,
    },
    /// A selected `[link]` option followed by its label jump, linked to the
    /// choice caption's extracted source unit.
    LabelJumpEvent {
        /// Real extraction bridge id for the selected choice caption.
        bridge_unit_id: String,
        /// Stable extraction source-unit key for that caption.
        source_unit_key: String,
        /// Stable source filename.
        source_file: String,
        /// Label active before the selected choice jumps.
        #[serde(skip_serializing_if = "Option::is_none")]
        from_label: Option<String>,
        /// Destination label selected by the replay's deterministic policy.
        to_label: String,
        /// Selected choice caption.
        text: String,
        /// The replay evidence tier for this observation.
        evidence_tier: String,
    },
}

impl KagReplayE0E1Trace {
    /// Serialize with recursively sorted keys, yielding byte-identical JSON for
    /// identical inputs. There are intentionally no clock, process, or host
    /// fields in this trace.
    ///
    /// # Errors
    /// Returns a JSON serialization error if this in-memory trace cannot be
    /// represented as JSON.
    pub fn to_deterministic_json(&self) -> serde_json::Result<String> {
        let value = sorted_value(serde_json::to_value(self)?);
        serde_json::to_string_pretty(&value)
    }
}

/// Replay each plaintext input and emit only observations whose bridge ids are
/// supplied by the sibling command trace. This keeps bridge linkage exact:
/// identifiers are never synthesized by this adapter.
#[must_use]
pub fn emit_kag_replay_e0_e1_trace(inputs: &[KagReplayInput<'_>]) -> KagReplayE0E1Trace {
    let mut events = Vec::new();
    for input in inputs {
        append_replay_events(&mut events, input);
    }
    KagReplayE0E1Trace {
        schema_version: KAG_REPLAY_E0_E1_SCHEMA_VERSION.to_string(),
        engine_family: KAG_REPLAY_E0_E1_ENGINE_FAMILY.to_string(),
        runtime: KAG_PLAINTEXT_RUNTIME.to_string(),
        source_evidence_tier: SOURCE_EVIDENCE_TIER.to_string(),
        evidence_tier: REPLAY_EVIDENCE_TIER.to_string(),
        events,
    }
}

fn append_replay_events(events: &mut Vec<KagReplayE0E1Event>, input: &KagReplayInput<'_>) {
    let replay = replay_kag(&parse_kag(input.source_file, input.bytes));
    let command_trace = trace_kag_commands(input.source_file, input.bytes);
    let mut used_message_rows = vec![false; command_trace.rows.len()];

    for replay_event in &replay.events {
        let KagEvent::Message { text, speaker } = replay_event else {
            continue;
        };
        let matching_row = command_trace.rows.iter().enumerate().find(|(index, row)| {
            !used_message_rows[*index]
                && row.kind == RowKind::Message
                && row.text.as_deref() == Some(text)
                && row.speaker.as_deref() == speaker.as_deref()
                && row.bridge_ref.is_some()
        });
        let Some((index, row)) = matching_row else {
            // Macro expansion can create observed text without a direct source
            // row. It remains replay output, but has no direct extraction unit
            // to link, so this bridge evidence must not pretend otherwise.
            continue;
        };
        let Some(bridge_ref) = row.bridge_ref.as_ref() else {
            continue;
        };
        used_message_rows[index] = true;
        events.push(KagReplayE0E1Event::TextEvent {
            bridge_unit_id: bridge_ref.bridge_unit_id.clone(),
            source_unit_key: bridge_ref.source_unit_key.clone(),
            source_file: input.source_file.to_string(),
            speaker: speaker.clone(),
            text: text.clone(),
            evidence_tier: REPLAY_EVIDENCE_TIER.to_string(),
        });
    }

    for pair in replay.events.windows(2) {
        let [
            KagEvent::Choice { options, selected },
            KagEvent::Jump {
                from_label,
                to_label,
            },
        ] = pair
        else {
            continue;
        };
        let Some(option) = options.get(*selected) else {
            continue;
        };
        let matching_row = command_trace.rows.iter().find(|row| {
            row.kind == RowKind::Branch
                && row.label.as_deref() == from_label.as_deref()
                && row.jump_target.as_deref() == Some(to_label)
                && row.text.as_deref() == Some(option.text.as_str())
                && row.bridge_ref.is_some()
        });
        let Some(row) = matching_row else {
            continue;
        };
        let Some(bridge_ref) = row.bridge_ref.as_ref() else {
            continue;
        };
        events.push(KagReplayE0E1Event::LabelJumpEvent {
            bridge_unit_id: bridge_ref.bridge_unit_id.clone(),
            source_unit_key: bridge_ref.source_unit_key.clone(),
            source_file: input.source_file.to_string(),
            from_label: from_label.clone(),
            to_label: to_label.clone(),
            text: option.text.clone(),
            evidence_tier: REPLAY_EVIDENCE_TIER.to_string(),
        });
    }
}

fn sorted_value(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(entries) => {
            let mut entries: Vec<(String, serde_json::Value)> = entries
                .into_iter()
                .map(|(key, value)| (key, sorted_value(value)))
                .collect();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            serde_json::Value::Object(entries.into_iter().collect())
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(sorted_value).collect())
        }
        primitive => primitive,
    }
}
