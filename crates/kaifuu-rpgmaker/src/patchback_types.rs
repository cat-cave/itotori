use super::*;
use serde::{Deserialize, Serialize};

/// Named string-escaping choice for the patched JSON bytes.
/// The RPG Maker MV/MZ editor serializes `www/data/*.json` ASCII-safe:
/// every non-ASCII codepoint is `\uXXXX`-escaped. Naming the choice in
/// code (rather than defaulting it silently) is the
/// "Encoding/escaping corruption of MV/MZ JSON" audit-focus mitigation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JsonStringEscaping {
    /// `"`/`\` backslash-escaped, control codes via short/`\u00XX`
    /// escapes, every codepoint `>= 0x80` as `\uXXXX` (surrogate pair for
    /// astral codepoints). Printable ASCII verbatim.
    AsciiSafeUnicodeEscapes,
}

/// Caller-supplied knobs for the patchback. All fields are required;
/// there are no implicit defaults.
#[derive(Debug, Clone, Copy)]
pub struct PatchbackOpts {
    pub string_escaping: JsonStringEscaping,
}

impl PatchbackOpts {
    /// The canonical RPG Maker MV/MZ emission mode: ASCII-safe `\u`
    /// escaping, matching the editor's own output.
    pub const fn rpg_maker_default() -> Self {
        Self {
            string_escaping: JsonStringEscaping::AsciiSafeUnicodeEscapes,
        }
    }
}

/// One per-unit translation entry consumed by the patchback driver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslatedUnitTarget {
    /// Matches the source [`kaifuu_core::LocalizationUnitV02::bridge_unit_id`].
    pub bridge_unit_id: String,
    /// Locale tag of the target text (e.g. `"en-US"`).
    pub target_locale: String,
    /// The translated body (the literal that will be written back).
    pub target_text: String,
}

/// Translated v0.2 BridgeBundle: the validated source side plus one
/// `target.{locale,text}` per unit. Identical in shape to the RealLive
/// [`kaifuu_reallive::TranslatedBundleV02`] so itotori populates both the
/// same way.
#[derive(Debug, Clone)]
pub struct TranslatedBundleV02 {
    pub source: BridgeBundleV02,
    pub targets: Vec<TranslatedUnitTarget>,
}

impl TranslatedBundleV02 {
    /// Parse a translated-bundle JSON value: validate the source side
    /// against the v0.2 contract and pull `target.{locale,text}` per unit.
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
                return Err(PatchbackError::TargetEmpty { bridge_unit_id });
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
