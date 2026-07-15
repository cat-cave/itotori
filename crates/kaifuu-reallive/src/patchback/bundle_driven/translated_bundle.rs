use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use kaifuu_core::{BridgeBundleV02, RedactedContentSummary};

use crate::scope::TranslationScope;

use super::PatchbackError;

/// Caller-supplied knobs for [`apply_translated_bundle`].
/// All fields are required; there are no implicit defaults. The
/// encoding choice is named here in code (per the audit-
/// focus row "Encoding choice (UTF-8 vs Shift-JIS) defaulted instead of
/// named in code"). The translation scope is likewise declared by the
/// caller — the byte-fidelity contract is CONFIG-DRIVEN, not hard-coded to
/// "only Textout dialogue may change".
#[derive(Debug, Clone, Copy)]
pub struct PatchbackOpts {
    /// Target text-encoding for the patched bytes. RealLive's runtime
    /// reads Shift-JIS Textout bodies from the bytecode stream; the
    /// canonical patchback emits [`PatchbackEncoding::ShiftJis`].
    pub target_encoding: PatchbackEncoding,
    /// The translation scope the user configured. Drives the byte-fidelity
    /// contract: a bundle unit whose `surfaceKind` is IN scope round-trips
    /// byte-correctly (its bytes are re-emitted, choices NextString-safe);
    /// every OUT-of-scope surface is carried byte-identical (no edit is
    /// resolved for it, so its bytes — including a whole `module_sel`
    /// Choice command and its `NextString` tokens — survive verbatim).
    pub scope: TranslationScope,
}

impl PatchbackOpts {
    /// The canonical emission mode (Shift-JIS target text) with
    /// an explicitly-declared translation `scope`.
    pub const fn shift_jis(scope: TranslationScope) -> Self {
        Self {
            target_encoding: PatchbackEncoding::ShiftJis,
            scope,
        }
    }
}

/// Named encoding choice for the patched Textout bodies.
/// The spec calls out the choice as audit-focused: the
/// patchback must NOT default the encoding silently. Today the only
/// supported variant is [`PatchbackEncoding::ShiftJis`]; a future UTF-8
/// runtime-decode hook would add a sibling variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchbackEncoding {
    /// Encode `target.text` as Shift-JIS via
    /// [`crate::encoding::encode_shift_jis_slot`] and splice the
    /// resulting bytes into the bytecode stream verbatim.
    ShiftJis,
}

/// One per-unit translation entry consumed by the patchback driver.
#[derive(Clone, PartialEq, Eq)]
pub struct TranslatedUnitTarget {
    /// Matches the source [`kaifuu_core::LocalizationUnitV02::bridge_unit_id`].
    pub bridge_unit_id: String,
    /// Locale tag of the target text (e.g. `"en-US"`).
    pub target_locale: String,
    /// The translated body — UTF-8 string that will be re-encoded to
    /// Shift-JIS at write time.
    pub target_text: String,
}

impl fmt::Debug for TranslatedUnitTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let target_text = RedactedContentSummary::from_text(&self.target_text);
        formatter
            .debug_struct("TranslatedUnitTarget")
            .field("bridge_unit_id", &self.bridge_unit_id)
            .field("target_locale", &self.target_locale)
            .field("target_text", &target_text)
            .finish()
    }
}

/// Translated v0.2 BridgeBundle.
/// Wraps the source-side [`kaifuu_core::BridgeBundleV02`] (which is
/// validated against the v0.2 schema before being accepted) with one
/// `target_text` per unit.
/// JSON shape consumed by [`TranslatedBundleV02::from_json`]:
/// ```text
/// "schemaVersion": "0.2.0",
/// ... // canonical v0.2 BridgeBundle fields
/// "units": [
/// "bridgeUnitId": "...",
/// ... // canonical unit fields
/// "target": { "locale": "en-US", "text": "Hello!" }
#[derive(Clone)]
pub struct TranslatedBundleV02 {
    pub source: BridgeBundleV02,
    pub targets: Vec<TranslatedUnitTarget>,
}

impl fmt::Debug for TranslatedBundleV02 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TranslatedBundleV02")
            .field("source_bridge_id", &self.source.bridge_id)
            .field("source_unit_count", &self.source.units.len())
            .field("targets", &self.targets)
            .finish()
    }
}

impl TranslatedBundleV02 {
    /// Parse a translated-bundle JSON value: validate the source side
    /// against the v0.2 contract and pull `target.text` per unit.
    pub fn from_json(value: &Value) -> Result<Self, PatchbackError> {
        let source = BridgeBundleV02::validate_json(value)?;
        let units_json = value
            .get("units")
            .and_then(Value::as_array)
            .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                message: "translated bundle JSON has no `units` array".into(),
            })?;
        if units_json.len() != source.units.len() {
            return Err(PatchbackError::BundleSchemaInvalid {
                message: format!(
                    "translated bundle units array length {observed} does not match validated unit count {expected}",
                    observed = units_json.len(),
                    expected = source.units.len()
                ),
            });
        }
        let mut targets = Vec::with_capacity(source.units.len());
        for (index, unit_json) in units_json.iter().enumerate() {
            let bridge_unit_id = source.units[index].bridge_unit_id.clone();
            let target_obj = unit_json
                .get("target")
                .and_then(Value::as_object)
                .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                    message: format!(
                        "translated bundle unit[{index}] is missing the `target` object"
                    ),
                })?;
            let target_locale = target_obj
                .get("locale")
                .and_then(Value::as_str)
                .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                    message: format!(
                        "translated bundle unit[{index}].target.locale must be a string"
                    ),
                })?
                .to_string();
            let target_text = target_obj
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                    message: format!(
                        "translated bundle unit[{index}].target.text must be a string"
                    ),
                })?
                .to_string();
            if target_text.is_empty() {
                return Err(PatchbackError::BundleSchemaInvalid {
                    message: format!(
                        "translated bundle unit[{index}].target.text must be non-empty (got empty string)"
                    ),
                });
            }
            targets.push(TranslatedUnitTarget {
                bridge_unit_id,
                target_locale,
                target_text,
            });
        }
        Ok(Self { source, targets })
    }
}
