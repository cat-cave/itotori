//! Engine-neutral input-event model for the deterministic runtime substrate.
//!
//! See `.plan/.md` for the design rationale. This module is the
//! single source of truth for the input shapes the substrate models. Engine
//! ports lower their native input into [`InputEvent`] at recording time; the
//! runner replays the same events deterministically. No variant carries a
//! host-derived path, byte buffer, instant, or thread/process id.
//!
//! The [`InputError`] enum supplies typed, stable semantic codes for every
//! failure mode so observation hooks and conformance checks can pin them
//! mechanically.
//!
//! All public types are `Send + Sync`.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::clock::LogicalClockTick;

/// Stable semantic code for [`InputError::UnsupportedKind`].
pub const INPUT_UNSUPPORTED_KIND_CODE: &str = "utsushi.input.unsupported_kind";
/// Stable semantic code for [`InputError::InvalidPayload`].
pub const INPUT_INVALID_PAYLOAD_CODE: &str = "utsushi.input.invalid_payload";
/// Stable semantic code for [`InputError::ClockBacktrack`].
pub const CLOCK_BACKTRACK_CODE: &str = "utsushi.clock.backtrack";
/// Stable semantic code for [`InputError::NonMonotonicTick`].
pub const REPLAY_NON_MONOTONIC_TICK_CODE: &str = "utsushi.replay.non_monotonic_tick";
/// Stable semantic code for [`InputError::RedactionViolation`].
pub const REPLAY_REDACTION_VIOLATION_CODE: &str = "utsushi.replay.redaction_violation";
/// Stable semantic code for [`InputError::UnsupportedSchemaVersion`].
pub const REPLAY_UNSUPPORTED_SCHEMA_VERSION_CODE: &str =
    "utsushi.replay.unsupported_schema_version";

/// Engine-neutral discriminant naming the input shapes the substrate models.
///
/// Engine-specific extensions go through [`InputKind::Raw`] so the model
/// remains additive without forcing premature variant additions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputKind {
    /// Text-advance / proceed-with-currently-displayed-line.
    Text,
    /// Pick a numbered choice from a presented choice prompt.
    Choice,
    /// Generic single-step advance.
    Advance,
    /// Engine "skip read text" toggle.
    Skip,
    /// Engine "auto advance" toggle.
    Auto,
    /// Save-state request.
    Save,
    /// Load-state request.
    Load,
    /// Menu-tree selection carrying stable logical ids, never screen
    /// coordinates.
    MenuSelect,
    /// Bounded pointer input in logical normalized coordinates; only valid
    /// when the adapter's capability contract declares pointer support.
    Pointer,
    /// Unsupported-by-substrate input recorded so playback can fire a typed
    /// diagnostic.
    Raw,
}

impl InputKind {
    /// Stable snake_case token used in error and diagnostic surfaces.
    pub fn token(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Choice => "choice",
            Self::Advance => "advance",
            Self::Skip => "skip",
            Self::Auto => "auto",
            Self::Save => "save",
            Self::Load => "load",
            Self::MenuSelect => "menu_select",
            Self::Pointer => "pointer",
            Self::Raw => "raw",
        }
    }
}

impl fmt::Display for InputKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.token())
    }
}

/// 0-based index into a presented choice prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ChoiceIndex(pub u16);

impl ChoiceIndex {
    pub fn get(self) -> u16 {
        self.0
    }
}

impl fmt::Display for ChoiceIndex {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Pointer button discriminant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerButton {
    Primary,
    Secondary,
    Auxiliary,
}

/// Stable, engine-defined menu identifier. No screen coordinates.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MenuTarget {
    /// Engine-namespaced public id (e.g. `"main_menu"`).
    pub menu_id: String,
    /// Stable string id, not a screen index.
    pub item_id: String,
}

impl MenuTarget {
    pub fn new(menu_id: impl Into<String>, item_id: impl Into<String>) -> Self {
        Self {
            menu_id: menu_id.into(),
            item_id: item_id.into(),
        }
    }
}

/// Diagnostic context an adapter saw but could not lower into a supported
/// variant. The `code` token is opaque to the substrate; carries no path or
/// byte payload.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RawInputCode {
    /// Public engine name (e.g. `"rpgmv"`, `"siglus"`, `"fixture"`).
    pub engine: String,
    /// Engine-defined opaque token. No path, no bytes.
    pub code: String,
}

impl RawInputCode {
    pub fn new(engine: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            engine: engine.into(),
            code: code.into(),
        }
    }
}

/// Engine-neutral input event.
///
/// Variants are tagged on the `kind` field in serialized form. Every variant
/// is engine-neutral; engine-specific extensions go through
/// [`InputEvent::Raw`].
///
/// `Eq` is intentionally not implemented because the `Pointer` variant
/// carries `f32` coordinates. `PartialEq` is exact float equality; this is
/// sound for deterministic replay because adapters serialize and deserialize
/// the same bit pattern (no host clock involvement).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputEvent {
    /// Text-advance. The substrate does not author text; the observed line at
    /// this tick belongs to the trace, not the input event.
    Text {},
    /// Pick a choice by 0-based index. `bridge_unit_id` is an optional review
    /// hint; engines that present choices by string id must canonicalize to
    /// indices at record time.
    Choice {
        index: ChoiceIndex,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bridge_unit_id: Option<String>,
    },
    /// Generic single-step advance synonymous with a "click-to-advance" gesture
    /// when no text box is active.
    Advance {},
    /// Toggle engine "skip read text".
    Skip { enable: bool },
    /// Toggle engine "auto advance".
    Auto { enable: bool },
    /// Save-state request (does not carry the underlying serialization).
    Save { slot: u16 },
    /// Load-state request.
    Load { slot: u16 },
    /// Menu-tree selection with stable logical ids.
    MenuSelect { target: MenuTarget },
    /// Bounded pointer input. Logical normalized coordinates in `[0.0, 1.0]`.
    Pointer {
        x: f32,
        y: f32,
        button: PointerButton,
    },
    /// Recorded engine-native input that the substrate does not model.
    Raw { code: RawInputCode },
}

impl InputEvent {
    /// Convenience constructor for [`InputEvent::Text`].
    pub fn text() -> Self {
        Self::Text {}
    }

    /// Convenience constructor for [`InputEvent::Advance`].
    pub fn advance() -> Self {
        Self::Advance {}
    }

    /// Construct an [`InputEvent::Choice`] without a bridge id.
    pub fn choice(index: u16) -> Self {
        Self::Choice {
            index: ChoiceIndex(index),
            bridge_unit_id: None,
        }
    }

    /// Construct an [`InputEvent::Choice`] with a bridge id.
    pub fn choice_with_bridge(index: u16, bridge_unit_id: impl Into<String>) -> Self {
        Self::Choice {
            index: ChoiceIndex(index),
            bridge_unit_id: Some(bridge_unit_id.into()),
        }
    }

    /// Construct an [`InputEvent::Raw`] carrying engine-side diagnostic.
    pub fn raw(engine: impl Into<String>, code: impl Into<String>) -> Self {
        Self::Raw {
            code: RawInputCode::new(engine, code),
        }
    }

    /// The [`InputKind`] discriminant matching this variant's payload.
    pub fn kind(&self) -> InputKind {
        match self {
            Self::Text { .. } => InputKind::Text,
            Self::Choice { .. } => InputKind::Choice,
            Self::Advance { .. } => InputKind::Advance,
            Self::Skip { .. } => InputKind::Skip,
            Self::Auto { .. } => InputKind::Auto,
            Self::Save { .. } => InputKind::Save,
            Self::Load { .. } => InputKind::Load,
            Self::MenuSelect { .. } => InputKind::MenuSelect,
            Self::Pointer { .. } => InputKind::Pointer,
            Self::Raw { .. } => InputKind::Raw,
        }
    }

    /// Lightweight payload-shape invariants that hold without observing
    /// surrounding context. Currently checks:
    ///   * `MenuSelect`: `menu_id`, `item_id` non-empty
    ///   * `Pointer`: coordinates finite, in `[0.0, 1.0]`
    ///   * `RawInputCode`: `engine` and `code` non-empty
    ///
    /// Called automatically by the replay-log builder before the event enters
    /// the log. Callers that wish to validate an event before constructing a
    /// log (e.g. an engine port mapping native input) can call this directly.
    pub fn validate_payload_shape(&self) -> Result<(), InputError> {
        match self {
            Self::MenuSelect { target } => {
                if target.menu_id.trim().is_empty() {
                    return Err(InputError::invalid_payload(
                        InputKind::MenuSelect,
                        "menu_id must not be empty",
                    ));
                }
                if target.item_id.trim().is_empty() {
                    return Err(InputError::invalid_payload(
                        InputKind::MenuSelect,
                        "item_id must not be empty",
                    ));
                }
                Ok(())
            }
            Self::Pointer { x, y, .. } => {
                for (label, value) in [("x", *x), ("y", *y)] {
                    if !value.is_finite() {
                        return Err(InputError::invalid_payload(
                            InputKind::Pointer,
                            format!("pointer {label} must be finite"),
                        ));
                    }
                    if !(0.0..=1.0).contains(&value) {
                        return Err(InputError::invalid_payload(
                            InputKind::Pointer,
                            format!("pointer {label} must be in [0.0, 1.0]"),
                        ));
                    }
                }
                Ok(())
            }
            Self::Raw { code } => {
                if code.engine.trim().is_empty() {
                    return Err(InputError::invalid_payload(
                        InputKind::Raw,
                        "raw engine token must not be empty",
                    ));
                }
                if code.code.trim().is_empty() {
                    return Err(InputError::invalid_payload(
                        InputKind::Raw,
                        "raw code token must not be empty",
                    ));
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

/// Typed failure surface for input dispatch, clock advancement, and replay-log
/// finalization. Every variant carries a stable semantic code retrievable via
/// [`InputError::semantic_code`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InputError {
    /// An adapter received an input kind it does not implement.
    UnsupportedKind {
        kind: String,
        supported: &'static [InputKind],
        code: &'static str,
    },
    /// A replay log included an event whose payload failed validation.
    InvalidPayload {
        kind: InputKind,
        reason: String,
        code: &'static str,
    },
    /// A clock advance attempted to move backwards.
    ClockBacktrack {
        from: LogicalClockTick,
        to: LogicalClockTick,
        code: &'static str,
    },
    /// The log violated tick monotonicity at record time.
    NonMonotonicTick {
        previous: LogicalClockTick,
        attempted: LogicalClockTick,
        code: &'static str,
    },
    /// A recorded event or finalized log carried a string that would match
    /// the `reject_unredacted_local_paths` filter.
    RedactionViolation {
        field_path: String,
        code: &'static str,
    },
    /// The replay-log JSON failed schema-version pinning.
    UnsupportedSchemaVersion {
        observed: String,
        expected: &'static str,
        code: &'static str,
    },
}

impl InputError {
    /// Construct an [`InputError::UnsupportedKind`].
    pub fn unsupported_kind(
        observed_kind: impl Into<String>,
        supported: &'static [InputKind],
    ) -> Self {
        Self::UnsupportedKind {
            kind: observed_kind.into(),
            supported,
            code: INPUT_UNSUPPORTED_KIND_CODE,
        }
    }

    /// Construct an [`InputError::InvalidPayload`].
    pub fn invalid_payload(kind: InputKind, reason: impl Into<String>) -> Self {
        Self::InvalidPayload {
            kind,
            reason: reason.into(),
            code: INPUT_INVALID_PAYLOAD_CODE,
        }
    }

    /// Construct an [`InputError::ClockBacktrack`].
    pub fn clock_backtrack(from: LogicalClockTick, to: LogicalClockTick) -> Self {
        Self::ClockBacktrack {
            from,
            to,
            code: CLOCK_BACKTRACK_CODE,
        }
    }

    /// Construct an [`InputError::NonMonotonicTick`].
    pub fn non_monotonic_tick(previous: LogicalClockTick, attempted: LogicalClockTick) -> Self {
        Self::NonMonotonicTick {
            previous,
            attempted,
            code: REPLAY_NON_MONOTONIC_TICK_CODE,
        }
    }

    /// Construct an [`InputError::RedactionViolation`].
    pub fn redaction_violation(field_path: impl Into<String>) -> Self {
        Self::RedactionViolation {
            field_path: field_path.into(),
            code: REPLAY_REDACTION_VIOLATION_CODE,
        }
    }

    /// Construct an [`InputError::UnsupportedSchemaVersion`].
    pub fn unsupported_schema_version(observed: impl Into<String>, expected: &'static str) -> Self {
        Self::UnsupportedSchemaVersion {
            observed: observed.into(),
            expected,
            code: REPLAY_UNSUPPORTED_SCHEMA_VERSION_CODE,
        }
    }

    /// Stable diagnostic code for this error, suitable for runtime evidence.
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::UnsupportedKind { code, .. }
            | Self::InvalidPayload { code, .. }
            | Self::ClockBacktrack { code, .. }
            | Self::NonMonotonicTick { code, .. }
            | Self::RedactionViolation { code, .. }
            | Self::UnsupportedSchemaVersion { code, .. } => code,
        }
    }
}

impl fmt::Display for InputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedKind {
                kind,
                supported,
                code,
            } => {
                let supported_list: Vec<&'static str> =
                    supported.iter().map(|kind| kind.token()).collect();
                write!(
                    formatter,
                    "[{code}] unsupported input kind {kind:?}; supported: {supported_list:?}"
                )
            }
            Self::InvalidPayload { kind, reason, code } => {
                write!(
                    formatter,
                    "[{code}] invalid payload for input kind {kind}: {reason}"
                )
            }
            Self::ClockBacktrack { from, to, code } => {
                write!(
                    formatter,
                    "[{code}] clock backtrack rejected: from {from:?} to {to:?}"
                )
            }
            Self::NonMonotonicTick {
                previous,
                attempted,
                code,
            } => {
                write!(
                    formatter,
                    "[{code}] non-monotonic tick: previous {previous:?}, attempted {attempted:?}"
                )
            }
            Self::RedactionViolation { field_path, code } => {
                write!(
                    formatter,
                    "[{code}] redaction violation at field {field_path}"
                )
            }
            Self::UnsupportedSchemaVersion {
                observed,
                expected,
                code,
            } => {
                write!(
                    formatter,
                    "[{code}] unsupported replay schema version {observed:?}; expected {expected:?}"
                )
            }
        }
    }
}

impl std::error::Error for InputError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn input_event_text_serializes_and_round_trips() {
        let event = InputEvent::text();
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value, json!({ "kind": "text" }));
        let round: InputEvent = serde_json::from_value(value).unwrap();
        assert_eq!(round, event);
        assert_eq!(round.kind(), InputKind::Text);
    }

    #[test]
    fn input_event_choice_round_trips_index_and_optional_bridge_id() {
        let event = InputEvent::choice_with_bridge(2, "unit-7");
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(
            value,
            json!({ "kind": "choice", "index": 2, "bridge_unit_id": "unit-7" })
        );
        let round: InputEvent = serde_json::from_value(value).unwrap();
        assert_eq!(round, event);
        let no_bridge = InputEvent::choice(0);
        let v2 = serde_json::to_value(&no_bridge).unwrap();
        // bridge id absent must be skipped on serialize
        assert_eq!(v2, json!({ "kind": "choice", "index": 0 }));
    }

    #[test]
    fn input_event_menu_select_round_trips_menu_and_item_ids() {
        let event = InputEvent::MenuSelect {
            target: MenuTarget::new("main_menu", "items"),
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(
            value,
            json!({
                "kind": "menu_select",
                "target": { "menuId": "main_menu", "itemId": "items" }
            })
        );
        let round: InputEvent = serde_json::from_value(value).unwrap();
        assert_eq!(round, event);
    }

    #[test]
    fn input_event_menu_select_rejects_empty_item_id() {
        let event = InputEvent::MenuSelect {
            target: MenuTarget::new("main_menu", ""),
        };
        let error = event.validate_payload_shape().unwrap_err();
        match error {
            InputError::InvalidPayload { kind, code, .. } => {
                assert_eq!(kind, InputKind::MenuSelect);
                assert_eq!(code, INPUT_INVALID_PAYLOAD_CODE);
            }
            other => panic!("expected InvalidPayload, got {other:?}"),
        }
    }

    #[test]
    fn input_event_pointer_round_trips_normalized_coordinates() {
        let event = InputEvent::Pointer {
            x: 0.25,
            y: 0.75,
            button: PointerButton::Primary,
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(
            value,
            json!({
                "kind": "pointer",
                "x": 0.25,
                "y": 0.75,
                "button": "primary"
            })
        );
        let round: InputEvent = serde_json::from_value(value).unwrap();
        assert_eq!(round, event);
    }

    #[test]
    fn input_event_pointer_rejects_out_of_range_coordinates() {
        let bad = InputEvent::Pointer {
            x: -0.1,
            y: 0.5,
            button: PointerButton::Primary,
        };
        let error = bad.validate_payload_shape().unwrap_err();
        assert!(matches!(
            error,
            InputError::InvalidPayload {
                kind: InputKind::Pointer,
                ..
            }
        ));
    }

    #[test]
    fn input_event_raw_records_engine_and_code_without_path_leakage() {
        let event = InputEvent::raw("fixture", "diagnostic-token");
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(
            value,
            json!({
                "kind": "raw",
                "code": { "engine": "fixture", "code": "diagnostic-token" }
            })
        );
        let round: InputEvent = serde_json::from_value(value).unwrap();
        assert_eq!(round, event);
        assert_eq!(round.kind(), InputKind::Raw);
    }

    #[test]
    fn input_event_kind_matches_payload_for_every_variant() {
        let cases: Vec<(InputEvent, InputKind)> = vec![
            (InputEvent::text(), InputKind::Text),
            (InputEvent::choice(1), InputKind::Choice),
            (InputEvent::advance(), InputKind::Advance),
            (InputEvent::Skip { enable: true }, InputKind::Skip),
            (InputEvent::Auto { enable: false }, InputKind::Auto),
            (InputEvent::Save { slot: 0 }, InputKind::Save),
            (InputEvent::Load { slot: 3 }, InputKind::Load),
            (
                InputEvent::MenuSelect {
                    target: MenuTarget::new("main_menu", "items"),
                },
                InputKind::MenuSelect,
            ),
            (
                InputEvent::Pointer {
                    x: 0.0,
                    y: 0.0,
                    button: PointerButton::Auxiliary,
                },
                InputKind::Pointer,
            ),
            (InputEvent::raw("fixture", "code"), InputKind::Raw),
        ];
        for (event, kind) in cases {
            assert_eq!(event.kind(), kind, "event {event:?} kind mismatch");
        }
    }

    #[test]
    fn input_event_serde_rejects_unknown_fields_on_tagged_variants() {
        let value = json!({ "kind": "advance", "garbage": true });
        let parsed: Result<InputEvent, _> = serde_json::from_value(value);
        assert!(parsed.is_err());
    }

    #[test]
    fn input_error_unsupported_kind_carries_stable_semantic_code() {
        let supported: &'static [InputKind] = &[InputKind::Text, InputKind::Choice];
        let error = InputError::unsupported_kind("pointer", supported);
        assert_eq!(error.semantic_code(), INPUT_UNSUPPORTED_KIND_CODE);
        assert_eq!(error.semantic_code(), "utsushi.input.unsupported_kind");
        match error {
            InputError::UnsupportedKind {
                kind,
                supported: actual,
                ..
            } => {
                assert_eq!(kind, "pointer");
                assert_eq!(actual.len(), 2);
            }
            other => panic!("expected UnsupportedKind, got {other:?}"),
        }
    }

    #[test]
    fn input_error_semantic_codes_are_stable_strings() {
        assert_eq!(
            InputError::invalid_payload(InputKind::Choice, "x").semantic_code(),
            "utsushi.input.invalid_payload"
        );
        assert_eq!(
            InputError::clock_backtrack(LogicalClockTick(5), LogicalClockTick(3)).semantic_code(),
            "utsushi.clock.backtrack"
        );
        assert_eq!(
            InputError::non_monotonic_tick(LogicalClockTick(5), LogicalClockTick(5))
                .semantic_code(),
            "utsushi.replay.non_monotonic_tick"
        );
        assert_eq!(
            InputError::redaction_violation("metadata.sourceLabel").semantic_code(),
            "utsushi.replay.redaction_violation"
        );
        assert_eq!(
            InputError::unsupported_schema_version("9.9.9", "0.1.0-alpha").semantic_code(),
            "utsushi.replay.unsupported_schema_version"
        );
    }

    #[test]
    fn input_kind_token_round_trip_via_serde() {
        for kind in [
            InputKind::Text,
            InputKind::Choice,
            InputKind::Advance,
            InputKind::Skip,
            InputKind::Auto,
            InputKind::Save,
            InputKind::Load,
            InputKind::MenuSelect,
            InputKind::Pointer,
            InputKind::Raw,
        ] {
            let value = serde_json::to_value(kind).unwrap();
            let back: InputKind = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(kind, back);
            // serialized form matches token()
            assert_eq!(value, json!(kind.token()));
        }
    }
}
