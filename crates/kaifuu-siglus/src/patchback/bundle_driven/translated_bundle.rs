use std::fmt;

use serde_json::Value;

use kaifuu_core::{BridgeBundleV02, RedactedContentSummary};

use super::PatchbackError;

/// One translated v0.2 unit, paired to its source `bridgeUnitId`.
#[derive(Clone, PartialEq, Eq)]
pub struct TranslatedUnitTarget {
    /// The source bridge unit this target replaces.
    pub bridge_unit_id: String,
    /// Target locale tag.
    pub target_locale: String,
    /// UTF-8 translation; patchback transforms it to Siglus UTF-16LE.
    pub target_text: String,
}

impl fmt::Debug for TranslatedUnitTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TranslatedUnitTarget")
            .field("bridge_unit_id", &self.bridge_unit_id)
            .field("target_locale", &self.target_locale)
            .field(
                "target_text",
                &RedactedContentSummary::from_text(&self.target_text),
            )
            .finish()
    }
}

/// Validated source bridge plus one target for every source unit.
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
    /// Validate the source side as BridgeBundle v0.2 and collect each required
    /// `units[n].target.{locale,text}` payload.
    pub fn from_json(value: &Value) -> Result<Self, PatchbackError> {
        let source = BridgeBundleV02::validate_json(value)?;
        let units = value
            .get("units")
            .and_then(Value::as_array)
            .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                message: "translated bundle has no units array".into(),
            })?;
        if units.len() != source.units.len() {
            return Err(PatchbackError::BundleSchemaInvalid {
                message: format!(
                    "translated bundle has {} JSON units but {} validated source units",
                    units.len(),
                    source.units.len()
                ),
            });
        }
        let mut targets = Vec::with_capacity(units.len());
        for (index, unit) in units.iter().enumerate() {
            let target = unit
                .get("target")
                .and_then(Value::as_object)
                .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                    message: format!("unit[{index}] is missing target"),
                })?;
            let target_locale = target
                .get("locale")
                .and_then(Value::as_str)
                .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                    message: format!("unit[{index}].target.locale must be a string"),
                })?
                .to_string();
            let target_text = target
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                    message: format!("unit[{index}].target.text must be a string"),
                })?
                .to_string();
            targets.push(TranslatedUnitTarget {
                bridge_unit_id: source.units[index].bridge_unit_id.clone(),
                target_locale,
                target_text,
            });
        }
        Ok(Self { source, targets })
    }
}
