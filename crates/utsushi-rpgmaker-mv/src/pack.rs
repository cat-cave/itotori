//! Message + choice event-command **replay PACK** for RPG Maker MV/MZ.
//!
//! # What a pack adds on top of the [`crate::replay`] skeleton
//!
//! The [`crate::replay`] module threads deterministic switch/variable state
//! across the declared command subset and emits plain `text` / `choice`
//! `state` trace events. It has no notion of *where a line came from* nor of
//! *where a choice branch leads* — those two Itotori linkages were left for a
//! follow-up. This module is that follow-up.
//!
//! A **replay pack** bundles a raw MV/MZ event `list[]` with two Itotori
//! overlays that the deterministic structure decode already knows:
//!
//! - **Source unit links** — each message window (`Show Text` 101 setup + its
//!   401 body lines) links back to the *source bridge unit* it was decoded
//!   into. The linkage is the same `bridgeRef` shape the
//!   observation envelope carries: `{ sourceUnitKey, bridgeUnitId }`. A text
//!   trace event that does not name its source unit cannot be fed the richer
//!   structure-informed context, so the pack makes the link first-class.
//! - **Route-map alignment** — each `Show Choices` (102) option aligns to an
//!   Itotori **route-map id** (`routeKey`, the same id the
//!   `route-choice-map` agent emits as `RouteChoiceOption.targetRouteKey`).
//!   A branch that names its destination route lets a downstream summariser
//!   know which arc the player is stepping into.
//!
//! The pack reuses the [`replay_event_list`] verbatim for the base
//! outcome — final switch/variable state **and** the typed unsupported-command
//! diagnostics — so a command outside the declared subset surfaces exactly the
//! same [`ReplayDiagnostic`] here as it does in the bare skeleton: never a
//! silent skip. On top of that base the pack walks the same list a second time
//! to emit the enriched, link-carrying **message + choice** event stream.
//!
//! All fixtures exercising this module are SYNTHETIC — hand-authored
//! `{code, parameters}` lists plus hand-authored Itotori overlays. No
//! copyrighted game bytes inform the module.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::replay::{
    OBSERVATION_SOURCE_STATIC_REPLAY, REPLAY_TRACE_SCHEMA, ReplayDiagnostic, ReplayOutcome,
    UnknownPolicy, replay_event_list,
};

/// A link from a replayed runtime event back to the source bridge unit it was
/// decoded into. Mirrors the envelope's `bridgeRef` shape
/// (`{ sourceUnitKey, bridgeUnitId }`); `bridge_unit_id` is optional so a
/// pack authored before the bridge units are minted still names *something*.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceUnitLink {
    /// Stable decode-time key identifying the source unit (e.g.
    /// `mvmz.map012.ev003.p0.msg000`).
    pub source_unit_key: String,
    /// The minted bridge unit id, when known.
    pub bridge_unit_id: Option<String>,
}

impl SourceUnitLink {
    fn to_json(&self) -> Value {
        match &self.bridge_unit_id {
            Some(id) => json!({
                "sourceUnitKey": self.source_unit_key,
                "bridgeUnitId": id,
            }),
            None => json!({ "sourceUnitKey": self.source_unit_key }),
        }
    }

    fn from_json(value: &Value) -> Result<Self, PackError> {
        let source_unit_key = value
            .get("sourceUnitKey")
            .and_then(Value::as_str)
            .ok_or_else(|| PackError::MalformedOverlay {
                detail: "link entry missing string `sourceUnitKey`".to_string(),
            })?
            .to_string();
        let bridge_unit_id = value
            .get("bridgeUnitId")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        Ok(Self {
            source_unit_key,
            bridge_unit_id,
        })
    }
}

/// The Itotori alignment for one `Show Choices` option: which route-map id the
/// branch leads to, plus an optional source unit link for the option label.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OptionAlignment {
    /// The route-map id (`routeKey`) this option branches into, when the
    /// option is a route branch. `None` for cosmetic/flag options.
    pub route_key: Option<String>,
    /// Source unit link for the option label text.
    pub link: Option<SourceUnitLink>,
}

/// One enriched message window: its speaker/lines plus the source unit link.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkedTextEvent {
    pub speaker: Option<String>,
    pub lines: Vec<String>,
    pub link: Option<SourceUnitLink>,
}

/// One enriched choice option: its label, the route-map id it aligns to, and
/// its source unit link.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkedChoiceOption {
    pub label: String,
    pub route_key: Option<String>,
    pub link: Option<SourceUnitLink>,
}

/// One enriched choice event: options in declaration order, each aligned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkedChoiceEvent {
    pub options: Vec<LinkedChoiceOption>,
}

/// An enriched message-or-choice event produced by replaying a pack.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkedEvent {
    Text(LinkedTextEvent),
    Choice(LinkedChoiceEvent),
}

impl LinkedEvent {
    /// Envelope-compatible JSON. Text events carry `bridgeRefs` at the event
    /// level and choice options carry a per-option `bridgeRef`, mirroring the
    /// live-observation hook events.
    fn to_json(&self) -> Value {
        match self {
            Self::Text(event) => {
                let bridge_refs: Vec<Value> =
                    event.link.iter().map(SourceUnitLink::to_json).collect();
                json!({
                    "eventKind": "text",
                    "bridgeRefs": bridge_refs,
                    "payload": {
                        "payloadKind": "text",
                        "speaker": event.speaker,
                        "lines": event.lines,
                    },
                })
            }
            Self::Choice(event) => {
                let options: Vec<Value> = event
                    .options
                    .iter()
                    .map(|option| {
                        json!({
                            "label": option.label,
                            "routeKey": option.route_key,
                            "bridgeRef": option.link.as_ref().map(SourceUnitLink::to_json),
                        })
                    })
                    .collect();
                json!({
                    "eventKind": "choice",
                    "payload": {
                        "payloadKind": "choice",
                        "options": options,
                    },
                })
            }
        }
    }
}

/// A parse error for a malformed replay pack. Kept distinct from a
/// [`ReplayDiagnostic`]: a diagnostic is an *expected, visible* gap in the
/// declared subset, whereas this is a structurally invalid pack document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PackError {
    /// The top-level pack document is not a JSON object or is missing
    /// `eventList`.
    MalformedPack { detail: String },
    /// A `sourceUnitLinks` / `routeAlignments` entry was ill-formed.
    MalformedOverlay { detail: String },
}

impl std::fmt::Display for PackError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MalformedPack { detail } => write!(formatter, "malformed replay pack: {detail}"),
            Self::MalformedOverlay { detail } => {
                write!(formatter, "malformed pack overlay: {detail}")
            }
        }
    }
}

impl std::error::Error for PackError {}

/// A replay pack: a raw MV/MZ event `list[]` plus the two Itotori overlays.
///
/// `source_unit_links` is keyed by the command index of the message window's
/// `Show Text` (101) setup (or, for a bare 401-run with no setup, the index of
/// the first body line). `route_alignments` is keyed by the command index of
/// the `Show Choices` (102) command, mapping option index → alignment.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReplayPack {
    pub event_list: Vec<Value>,
    pub source_unit_links: BTreeMap<usize, SourceUnitLink>,
    pub route_alignments: BTreeMap<usize, BTreeMap<usize, OptionAlignment>>,
}

impl ReplayPack {
    /// Parse a pack document:
    ///
    /// ```json
    /// {
    ///   "eventList": [ { "code": 101, "parameters": [...] },... ]
    ///   "sourceUnitLinks": [
    ///     { "commandIndex": 0, "sourceUnitKey": "...", "bridgeUnitId": "..." }
    ///   ]
    ///   "routeAlignments": [
    ///     { "commandIndex": 3, "options": [
    ///       { "optionIndex": 0, "routeKey": "...", "sourceUnitKey": "..." }
    ///     ] }
    ///   ]
    /// }
    /// ```
    pub fn from_json(document: &Value) -> Result<Self, PackError> {
        let event_list = document
            .get("eventList")
            .and_then(Value::as_array)
            .ok_or_else(|| PackError::MalformedPack {
                detail: "missing array `eventList`".to_string(),
            })?
            .clone();

        let mut source_unit_links = BTreeMap::new();
        if let Some(links) = document.get("sourceUnitLinks") {
            let links = links
                .as_array()
                .ok_or_else(|| PackError::MalformedOverlay {
                    detail: "`sourceUnitLinks` must be an array".to_string(),
                })?;
            for entry in links {
                let command_index = require_index(entry, "commandIndex")?;
                let link = SourceUnitLink::from_json(entry)?;
                source_unit_links.insert(command_index, link);
            }
        }

        let mut route_alignments: BTreeMap<usize, BTreeMap<usize, OptionAlignment>> =
            BTreeMap::new();
        if let Some(alignments) = document.get("routeAlignments") {
            let alignments = alignments
                .as_array()
                .ok_or_else(|| PackError::MalformedOverlay {
                    detail: "`routeAlignments` must be an array".to_string(),
                })?;
            for entry in alignments {
                let command_index = require_index(entry, "commandIndex")?;
                let options = entry
                    .get("options")
                    .and_then(Value::as_array)
                    .ok_or_else(|| PackError::MalformedOverlay {
                        detail: "route alignment missing array `options`".to_string(),
                    })?;
                let mut per_option = BTreeMap::new();
                for option in options {
                    let option_index = require_index(option, "optionIndex")?;
                    let route_key = option
                        .get("routeKey")
                        .and_then(Value::as_str)
                        .map(ToString::to_string);
                    let link = if option.get("sourceUnitKey").is_some() {
                        Some(SourceUnitLink::from_json(option)?)
                    } else {
                        None
                    };
                    per_option.insert(option_index, OptionAlignment { route_key, link });
                }
                route_alignments.insert(command_index, per_option);
            }
        }

        Ok(Self {
            event_list,
            source_unit_links,
            route_alignments,
        })
    }
}

fn require_index(value: &Value, field: &str) -> Result<usize, PackError> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .ok_or_else(|| PackError::MalformedOverlay {
            detail: format!("entry missing unsigned-integer `{field}`"),
        })
}

/// The result of replaying a pack: the enriched message + choice event stream
/// plus the base outcome (final state + typed diagnostics).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PackOutcome {
    /// The enriched message + choice events, in dispatch order.
    pub linked_events: Vec<LinkedEvent>,
    /// The base outcome: threaded switch/variable state and the
    /// typed unsupported-command diagnostics.
    pub base: ReplayOutcome,
}

impl PackOutcome {
    /// Deterministic, envelope-compatible JSON serialization of the whole pack
    /// trace. Golden tests assert against this. The `finalState` and
    /// `diagnostics` are lifted straight from the base outcome, so
    /// an unsupported command is as visible here as in the bare skeleton.
    pub fn to_trace_json(&self) -> Value {
        let base = self.base.to_trace_json();
        json!({
            "schemaVersion": REPLAY_TRACE_SCHEMA,
            "observationSource": OBSERVATION_SOURCE_STATIC_REPLAY,
            "linkedEvents": self
                .linked_events
                .iter()
                .map(LinkedEvent::to_json)
                .collect::<Vec<_>>(),
            "finalState": base.get("finalState").cloned().unwrap_or(json!({})),
            "diagnostics": base.get("diagnostics").cloned().unwrap_or(json!([])),
        })
    }
}

/// Replay a pack: run the skeleton for the base outcome (state
/// diagnostics), then emit the enriched, link-carrying message + choice stream.
///
/// Under [`UnknownPolicy::Fail`] the base replay aborts at the first
/// out-of-subset command and the error is returned unchanged — the pack adds
/// no new silent-skip surface.
pub fn replay_pack(
    pack: &ReplayPack,
    policy: UnknownPolicy,
) -> Result<PackOutcome, ReplayDiagnostic> {
    let base = replay_event_list(&pack.event_list, policy)?;
    let linked_events = build_linked_events(pack);
    Ok(PackOutcome {
        linked_events,
        base,
    })
}

/// Walk the event list a second time, grouping message windows and choices and
/// attaching the Itotori overlays. Non-message/choice commands (state
/// terminator, out-of-subset) only *flush* an open window here — their state
/// effect and any diagnostic are the base outcome's job, so this pass never
/// re-diagnoses and never double-counts.
fn build_linked_events(pack: &ReplayPack) -> Vec<LinkedEvent> {
    let mut builder = LinkedBuilder::default();
    for (command_index, command) in pack.event_list.iter().enumerate() {
        let code = command.get("code").and_then(Value::as_i64).unwrap_or(-1);
        let params = command.get("parameters").and_then(Value::as_array);
        match code {
            // Show Text setup — open a window; a preceding window flushes.
            101 => {
                builder.flush(pack);
                let speaker = params
                    .and_then(|p| p.get(4))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string);
                builder.open(command_index, speaker);
            }
            // Show Text body — append when a window is open (a stray 401 with
            // no setup is the base outcome's malformed-parameter diagnostic; we
            // mirror the skeleton and simply do not emit it).
            401 => {
                if let Some(text) = params.and_then(|p| p.first()).and_then(Value::as_str) {
                    builder.append_line(text.to_string());
                }
            }
            // Show Choices — flush any open window, then emit the aligned choice.
            102 => {
                builder.flush(pack);
                let labels = params
                    .and_then(|p| p.first())
                    .and_then(Value::as_array)
                    .map(|options| {
                        options
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToString::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                builder.push_choice(pack, command_index, labels);
            }
            // Everything else (state, terminator, out-of-subset) flushes the
            // open window; its own handling belongs to the base outcome.
            _ => builder.flush(pack),
        }
    }
    builder.flush(pack);
    builder.events
}

/// Accumulates the enriched message + choice stream during the second walk.
#[derive(Default)]
struct LinkedBuilder {
    events: Vec<LinkedEvent>,
    open_window: Option<OpenWindow>,
}

struct OpenWindow {
    command_index: usize,
    speaker: Option<String>,
    lines: Vec<String>,
}

impl LinkedBuilder {
    fn open(&mut self, command_index: usize, speaker: Option<String>) {
        self.open_window = Some(OpenWindow {
            command_index,
            speaker,
            lines: Vec::new(),
        });
    }

    fn append_line(&mut self, line: String) {
        if let Some(window) = self.open_window.as_mut() {
            window.lines.push(line);
        }
    }

    fn flush(&mut self, pack: &ReplayPack) {
        if let Some(window) = self.open_window.take() {
            let link = pack.source_unit_links.get(&window.command_index).cloned();
            self.events.push(LinkedEvent::Text(LinkedTextEvent {
                speaker: window.speaker,
                lines: window.lines,
                link,
            }));
        }
    }

    fn push_choice(&mut self, pack: &ReplayPack, command_index: usize, labels: Vec<String>) {
        let alignments = pack.route_alignments.get(&command_index);
        let options = labels
            .into_iter()
            .enumerate()
            .map(|(option_index, label)| {
                let alignment = alignments.and_then(|a| a.get(&option_index)).cloned();
                let alignment = alignment.unwrap_or_default();
                LinkedChoiceOption {
                    label,
                    route_key: alignment.route_key,
                    link: alignment.link,
                }
            })
            .collect();
        self.events
            .push(LinkedEvent::Choice(LinkedChoiceEvent { options }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay::DiagnosticReason;

    fn text(event: &LinkedEvent) -> &LinkedTextEvent {
        match event {
            LinkedEvent::Text(text) => text,
            other @ LinkedEvent::Choice(_) => panic!("expected text event, got {other:?}"),
        }
    }

    fn choice(event: &LinkedEvent) -> &LinkedChoiceEvent {
        match event {
            LinkedEvent::Choice(choice) => choice,
            other @ LinkedEvent::Text(_) => panic!("expected choice event, got {other:?}"),
        }
    }

    #[test]
    fn message_window_carries_its_source_unit_link() {
        let document = json!({
            "eventList": [
                { "code": 101, "parameters": ["", 0, 0, 2, "Alice"] },
                { "code": 401, "parameters": ["Hello."] },
                { "code": 401, "parameters": ["How are you?"] },
                { "code": 0, "parameters": [] },
            ],
            "sourceUnitLinks": [
                { "commandIndex": 0, "sourceUnitKey": "mvmz.map1.ev1.msg000", "bridgeUnitId": "019ed0-bu-1" },
            ],
        });
        let pack = ReplayPack::from_json(&document).unwrap();
        let outcome = replay_pack(&pack, UnknownPolicy::SkipWithDiagnostic).unwrap();
        assert_eq!(outcome.linked_events.len(), 1);
        let event = text(&outcome.linked_events[0]);
        assert_eq!(event.speaker.as_deref(), Some("Alice"));
        assert_eq!(event.lines, vec!["Hello.", "How are you?"]);
        assert_eq!(
            event.link,
            Some(SourceUnitLink {
                source_unit_key: "mvmz.map1.ev1.msg000".to_string(),
                bridge_unit_id: Some("019ed0-bu-1".to_string()),
            })
        );
        assert!(outcome.base.diagnostics.is_empty());
    }

    #[test]
    fn choice_options_align_to_route_map_ids() {
        let document = json!({
            "eventList": [
                { "code": 102, "parameters": [["The forest path", "The mountain pass"], 1] },
            ],
            "routeAlignments": [
                { "commandIndex": 0, "options": [
                    { "optionIndex": 0, "routeKey": "route.forest", "sourceUnitKey": "mvmz.map1.ch0.opt0" },
                    { "optionIndex": 1, "routeKey": "route.mountain", "sourceUnitKey": "mvmz.map1.ch0.opt1" },
                ] },
            ],
        });
        let pack = ReplayPack::from_json(&document).unwrap();
        let outcome = replay_pack(&pack, UnknownPolicy::SkipWithDiagnostic).unwrap();
        assert_eq!(outcome.linked_events.len(), 1);
        let event = choice(&outcome.linked_events[0]);
        assert_eq!(event.options.len(), 2);
        assert_eq!(event.options[0].label, "The forest path");
        assert_eq!(event.options[0].route_key.as_deref(), Some("route.forest"));
        assert_eq!(
            event.options[1].route_key.as_deref(),
            Some("route.mountain")
        );
        assert_eq!(
            event.options[0]
                .link
                .as_ref()
                .map(|l| l.source_unit_key.as_str()),
            Some("mvmz.map1.ch0.opt0")
        );
    }

    #[test]
    fn unsupported_command_in_pack_surfaces_typed_diagnostic_not_silent() {
        // Code 355 (Script) is outside the declared subset — the base outcome
        // must diagnose it, and the enriched stream must not swallow it.
        let document = json!({
            "eventList": [
                { "code": 101, "parameters": ["", 0, 0, 2, "Bob"] },
                { "code": 401, "parameters": ["A line."] },
                { "code": 355, "parameters": ["$gameSwitches.setValue(2, true)"] },
            ],
            "sourceUnitLinks": [
                { "commandIndex": 0, "sourceUnitKey": "mvmz.map1.ev2.msg000" },
            ],
        });
        let pack = ReplayPack::from_json(&document).unwrap();
        let outcome = replay_pack(&pack, UnknownPolicy::SkipWithDiagnostic).unwrap();
        // The message window still emitted, with its link (no bridge id here).
        assert_eq!(outcome.linked_events.len(), 1);
        assert_eq!(
            text(&outcome.linked_events[0]).link,
            Some(SourceUnitLink {
                source_unit_key: "mvmz.map1.ev2.msg000".to_string(),
                bridge_unit_id: None,
            })
        );
        // The unsupported command did NOT vanish: it is a typed diagnostic.
        assert_eq!(outcome.base.diagnostics.len(), 1);
        assert_eq!(outcome.base.diagnostics[0].code, 355);
        assert_eq!(
            outcome.base.diagnostics[0].reason,
            DiagnosticReason::CommandOutsideSubset { code: 355 }
        );
    }

    #[test]
    fn fail_policy_propagates_the_base_diagnostic() {
        let document = json!({
            "eventList": [
                { "code": 205, "parameters": [] },
            ],
        });
        let pack = ReplayPack::from_json(&document).unwrap();
        let error = replay_pack(&pack, UnknownPolicy::Fail).unwrap_err();
        assert_eq!(error.code, 205);
        assert_eq!(
            error.reason,
            DiagnosticReason::CommandOutsideSubset { code: 205 }
        );
    }

    #[test]
    fn option_without_alignment_defaults_to_no_route() {
        let document = json!({
            "eventList": [
                { "code": 102, "parameters": [["Yes", "No"], 1] },
            ],
        });
        let pack = ReplayPack::from_json(&document).unwrap();
        let outcome = replay_pack(&pack, UnknownPolicy::SkipWithDiagnostic).unwrap();
        let event = choice(&outcome.linked_events[0]);
        assert_eq!(event.options.len(), 2);
        assert!(event.options.iter().all(|o| o.route_key.is_none()));
        assert!(event.options.iter().all(|o| o.link.is_none()));
    }

    #[test]
    fn missing_event_list_is_a_pack_error() {
        let document = json!({ "sourceUnitLinks": [] });
        let error = ReplayPack::from_json(&document).unwrap_err();
        assert!(matches!(error, PackError::MalformedPack { .. }));
    }
}
