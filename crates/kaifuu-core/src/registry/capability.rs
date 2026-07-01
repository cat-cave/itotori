//! Capability-level ladder for engine adapters (KAIFUU-053).
//!
//! Sits above the granular `Capability` / `CapabilityReport` surface as a
//! 4-rung ladder consumers query against. Identifying that an engine exists
//! (`CapabilityLevel::Identify`) does NOT imply the adapter can extract or
//! patch it; consumers must opt in to the specific rung they need.
//!
//! The ladder is intentionally closed (versioned with
//! `BRIDGE_SCHEMA_VERSION_V02`). Adding a fifth rung later requires a
//! coordinated Rust + TS + DB schema bump; the next-rung policy is captured
//! in `docs/kaifuu-engine-playbook.md`.

use serde::{Deserialize, Serialize};

use crate::{Capability, CapabilityReport, CapabilityStatus};

/// One of the four detector-ladder rungs.
///
/// Ordered from least to most capability: `Identify < Inventory < Extract <
/// Patch`. The `Ord` derivation matches the natural ladder ordering — useful
/// for `adapters_at_least(level)` and "at least Extract" gates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityLevel {
    Identify,
    Inventory,
    Extract,
    Patch,
}

impl CapabilityLevel {
    /// All ladder rungs in ascending order.
    pub fn all() -> [Self; 4] {
        [Self::Identify, Self::Inventory, Self::Extract, Self::Patch]
    }

    /// Stable canonical string used by DB enums and TS mirror.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Identify => "identify",
            Self::Inventory => "inventory",
            Self::Extract => "extract",
            Self::Patch => "patch",
        }
    }
}

/// Per-rung status. Mirrors the Postgres `capability_level_status_kind` enum:
///
/// - `Supported` — adapter implements this rung without caveats.
/// - `Partial` — adapter implements with caveats; `limitations` lists them
///   (must be non-empty).
/// - `Unsupported` — adapter does not implement this rung; `reason` is
///   required.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CapabilityLevelStatus {
    Supported,
    Partial { limitations: Vec<String> },
    Unsupported { reason: String },
}

impl CapabilityLevelStatus {
    pub fn supported() -> Self {
        Self::Supported
    }

    pub fn partial<S, I>(limitations: I) -> Self
    where
        S: Into<String>,
        I: IntoIterator<Item = S>,
    {
        let limitations: Vec<String> = limitations.into_iter().map(Into::into).collect();
        debug_assert!(
            !limitations.is_empty(),
            "CapabilityLevelStatus::Partial requires at least one limitation"
        );
        Self::Partial { limitations }
    }

    pub fn unsupported(reason: impl Into<String>) -> Self {
        Self::Unsupported {
            reason: reason.into(),
        }
    }

    pub fn is_supported(&self) -> bool {
        matches!(self, Self::Supported)
    }

    pub fn is_partial(&self) -> bool {
        matches!(self, Self::Partial { .. })
    }

    pub fn is_unsupported(&self) -> bool {
        matches!(self, Self::Unsupported { .. })
    }

    /// Stable kind discriminator used by DB enums and TS mirror.
    pub fn kind_str(&self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::Partial { .. } => "partial",
            Self::Unsupported { .. } => "unsupported",
        }
    }
}

/// 4-rung capability matrix for one adapter.
///
/// `derive_from_reports` provides a conservative derivation from existing
/// granular `CapabilityReport`s, but adapters MUST declare their matrix
/// explicitly so identify-only engines can never accidentally bubble up to
/// `Extract`/`Patch` because a single granular report drifted to
/// `Supported`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCapabilityMatrix {
    pub adapter_id: String,
    pub identify: CapabilityLevelStatus,
    pub inventory: CapabilityLevelStatus,
    pub extract: CapabilityLevelStatus,
    pub patch: CapabilityLevelStatus,
}

impl AdapterCapabilityMatrix {
    pub fn new(
        adapter_id: impl Into<String>,
        identify: CapabilityLevelStatus,
        inventory: CapabilityLevelStatus,
        extract: CapabilityLevelStatus,
        patch: CapabilityLevelStatus,
    ) -> Self {
        Self {
            adapter_id: adapter_id.into(),
            identify,
            inventory,
            extract,
            patch,
        }
    }

    /// Construct an identify-only matrix. Inventory/Extract/Patch are all
    /// `Unsupported { reason }`.
    pub fn identify_only(adapter_id: impl Into<String>, reason: impl Into<String>) -> Self {
        let reason = reason.into();
        Self {
            adapter_id: adapter_id.into(),
            identify: CapabilityLevelStatus::Supported,
            inventory: CapabilityLevelStatus::unsupported(reason.clone()),
            extract: CapabilityLevelStatus::unsupported(reason.clone()),
            patch: CapabilityLevelStatus::unsupported(reason),
        }
    }

    /// Test helper: adapter is `Supported` up to and including `level`, then
    /// `Unsupported { reason }` for every higher rung.
    pub fn up_to(
        adapter_id: impl Into<String>,
        level: CapabilityLevel,
        reason_above: impl Into<String>,
    ) -> Self {
        let reason = reason_above.into();
        let make = |rung: CapabilityLevel| {
            if rung <= level {
                CapabilityLevelStatus::Supported
            } else {
                CapabilityLevelStatus::unsupported(reason.clone())
            }
        };
        Self {
            adapter_id: adapter_id.into(),
            identify: make(CapabilityLevel::Identify),
            inventory: make(CapabilityLevel::Inventory),
            extract: make(CapabilityLevel::Extract),
            patch: make(CapabilityLevel::Patch),
        }
    }

    /// Typed accessor.
    pub fn get(&self, level: CapabilityLevel) -> &CapabilityLevelStatus {
        match level {
            CapabilityLevel::Identify => &self.identify,
            CapabilityLevel::Inventory => &self.inventory,
            CapabilityLevel::Extract => &self.extract,
            CapabilityLevel::Patch => &self.patch,
        }
    }

    /// True iff `get(level).is_supported()`. Partial does NOT count — that
    /// is the whole point of the strict gate (acceptance criterion 2).
    pub fn supports(&self, level: CapabilityLevel) -> bool {
        self.get(level).is_supported()
    }

    /// True iff every rung at or below `level` is `Supported`.
    pub fn supports_at_least(&self, level: CapabilityLevel) -> bool {
        CapabilityLevel::all()
            .into_iter()
            .filter(|rung| *rung <= level)
            .all(|rung| self.supports(rung))
    }

    /// Conservative derivation from per-`Capability` reports. Used by the
    /// `level_matrix` default when an adapter does not declare one
    /// explicitly, and by the consistency check that prevents a declared
    /// matrix from claiming more than the granular reports support.
    ///
    /// Mapping (from the plan §"Types (Rust)"):
    ///
    /// - Identify ← `Capability::Detection`
    /// - Inventory ← `Capability::AssetListing` AND `AssetInventory`
    /// - Extract ← `Capability::Extraction`
    /// - Patch ← `Capability::Patching`
    ///
    /// Each rung is `Supported` only when every contributing report is
    /// `CapabilityStatus::Supported`; if any contributor is `Limited` /
    /// `RequiresUserInput` the rung becomes `Partial` with the contributor
    /// limitations; if any contributor is `Unsupported` (or missing
    /// entirely), the rung becomes `Unsupported`.
    pub fn derive_from_reports(
        adapter_id: impl Into<String>,
        reports: &[CapabilityReport],
    ) -> Self {
        Self {
            adapter_id: adapter_id.into(),
            identify: derive_status_from(reports, &[Capability::Detection]),
            inventory: derive_status_from(
                reports,
                &[Capability::AssetListing, Capability::AssetInventory],
            ),
            extract: derive_status_from(reports, &[Capability::Extraction]),
            patch: derive_status_from(reports, &[Capability::Patching]),
        }
    }

    /// Returns the first level at which `self` claims strictly more than
    /// `derived` (i.e. self says `Supported` where derived says `Partial` or
    /// `Unsupported`). The consistency check (KAIFUU-053 risk:
    /// "Detector report drift") rejects any adapter whose declared matrix
    /// exceeds what the granular reports would support.
    pub fn first_overclaim_against(
        &self,
        derived: &AdapterCapabilityMatrix,
    ) -> Option<CapabilityLevel> {
        CapabilityLevel::all().into_iter().find(|level| {
            let claimed = self.get(*level);
            let derived = derived.get(*level);
            overclaims(claimed, derived)
        })
    }
}

fn derive_status_from(
    reports: &[CapabilityReport],
    contributors: &[Capability],
) -> CapabilityLevelStatus {
    let mut limitations: Vec<String> = Vec::new();
    let mut missing: Vec<&Capability> = Vec::new();
    let mut unsupported_reasons: Vec<String> = Vec::new();
    for capability in contributors {
        match reports.iter().find(|r| &r.capability == capability) {
            None => missing.push(capability),
            Some(report) => match report.status {
                CapabilityStatus::Supported => {}
                CapabilityStatus::Limited | CapabilityStatus::RequiresUserInput => {
                    if let Some(limitation) = report.limitation.clone() {
                        limitations.push(limitation);
                    } else {
                        limitations.push(format!(
                            "{:?} reported {:?} without a limitation note",
                            capability, report.status
                        ));
                    }
                }
                CapabilityStatus::Unsupported => {
                    if let Some(limitation) = report.limitation.clone() {
                        unsupported_reasons.push(limitation);
                    } else {
                        unsupported_reasons.push(format!("{capability:?} reported Unsupported"));
                    }
                }
            },
        }
    }
    if !unsupported_reasons.is_empty() {
        return CapabilityLevelStatus::Unsupported {
            reason: unsupported_reasons.join("; "),
        };
    }
    if !missing.is_empty() {
        return CapabilityLevelStatus::Unsupported {
            reason: format!(
                "no CapabilityReport for required contributor(s): {}",
                missing
                    .iter()
                    .map(|c| format!("{c:?}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        };
    }
    if !limitations.is_empty() {
        return CapabilityLevelStatus::Partial { limitations };
    }
    CapabilityLevelStatus::Supported
}

fn rank(status: &CapabilityLevelStatus) -> u8 {
    match status {
        CapabilityLevelStatus::Unsupported { .. } => 0,
        CapabilityLevelStatus::Partial { .. } => 1,
        CapabilityLevelStatus::Supported => 2,
    }
}

fn overclaims(claimed: &CapabilityLevelStatus, derived: &CapabilityLevelStatus) -> bool {
    rank(claimed) > rank(derived)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Capability;

    #[test]
    fn level_ordering_is_ladder() {
        assert!(CapabilityLevel::Identify < CapabilityLevel::Inventory);
        assert!(CapabilityLevel::Inventory < CapabilityLevel::Extract);
        assert!(CapabilityLevel::Extract < CapabilityLevel::Patch);
    }

    #[test]
    fn all_levels_returns_ascending_order() {
        let all = CapabilityLevel::all();
        assert_eq!(all[0], CapabilityLevel::Identify);
        assert_eq!(all[3], CapabilityLevel::Patch);
    }

    #[test]
    fn matrix_json_round_trip_all_branches() {
        let matrix = AdapterCapabilityMatrix::new(
            "kaifuu.example",
            CapabilityLevelStatus::supported(),
            CapabilityLevelStatus::partial(["incomplete index"]),
            CapabilityLevelStatus::partial(["only some surfaces"]),
            CapabilityLevelStatus::unsupported("no patch path yet"),
        );
        let json = serde_json::to_value(&matrix).expect("serialize");
        // Spot-check tag-based discriminator round trip.
        assert_eq!(json["adapterId"], "kaifuu.example");
        assert_eq!(json["identify"]["kind"], "supported");
        assert_eq!(json["inventory"]["kind"], "partial");
        assert_eq!(json["inventory"]["limitations"][0], "incomplete index");
        assert_eq!(json["extract"]["kind"], "partial");
        assert_eq!(json["patch"]["kind"], "unsupported");
        assert_eq!(json["patch"]["reason"], "no patch path yet");
        let round: AdapterCapabilityMatrix = serde_json::from_value(json).expect("deserialize");
        assert_eq!(round, matrix);
    }

    #[test]
    fn identify_only_helper_marks_higher_rungs_unsupported() {
        let matrix =
            AdapterCapabilityMatrix::identify_only("kaifuu.identify_only", "detector-only fixture");
        assert!(matrix.supports(CapabilityLevel::Identify));
        assert!(!matrix.supports(CapabilityLevel::Inventory));
        assert!(!matrix.supports(CapabilityLevel::Extract));
        assert!(!matrix.supports(CapabilityLevel::Patch));
        assert!(matrix.inventory.is_unsupported());
    }

    #[test]
    fn supports_is_strict_against_partial() {
        let matrix = AdapterCapabilityMatrix::new(
            "kaifuu.partial",
            CapabilityLevelStatus::supported(),
            CapabilityLevelStatus::partial(["incomplete"]),
            CapabilityLevelStatus::partial(["lossy"]),
            CapabilityLevelStatus::unsupported("no"),
        );
        // Partial does NOT count as Supported — strict gate.
        assert!(!matrix.supports(CapabilityLevel::Inventory));
        assert!(!matrix.supports(CapabilityLevel::Extract));
    }

    #[test]
    fn derive_from_reports_marks_missing_as_unsupported() {
        let reports = vec![CapabilityReport::supported(Capability::Detection)];
        let derived = AdapterCapabilityMatrix::derive_from_reports("kaifuu.x", &reports);
        assert!(derived.supports(CapabilityLevel::Identify));
        assert!(derived.inventory.is_unsupported());
        assert!(derived.extract.is_unsupported());
        assert!(derived.patch.is_unsupported());
    }

    #[test]
    fn derive_from_reports_promotes_limited_to_partial() {
        let reports = vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::supported(Capability::AssetListing),
            CapabilityReport::supported(Capability::AssetInventory),
            CapabilityReport::supported(Capability::Extraction),
            CapabilityReport::limited(Capability::Patching, "lossy"),
        ];
        let derived = AdapterCapabilityMatrix::derive_from_reports("kaifuu.x", &reports);
        assert!(derived.supports(CapabilityLevel::Extract));
        assert!(derived.patch.is_partial());
        if let CapabilityLevelStatus::Partial { limitations } = &derived.patch {
            assert_eq!(limitations, &vec!["lossy".to_string()]);
        }
    }

    #[test]
    fn overclaim_detection_blocks_promotion_past_reports() {
        let reports = vec![CapabilityReport::supported(Capability::Detection)];
        let derived = AdapterCapabilityMatrix::derive_from_reports("kaifuu.x", &reports);
        // Declared matrix claims Extract Supported despite reports having
        // no Extraction report at all.
        let declared = AdapterCapabilityMatrix::new(
            "kaifuu.x",
            CapabilityLevelStatus::supported(),
            CapabilityLevelStatus::supported(),
            CapabilityLevelStatus::supported(),
            CapabilityLevelStatus::supported(),
        );
        let overclaim = declared.first_overclaim_against(&derived);
        assert_eq!(overclaim, Some(CapabilityLevel::Inventory));
    }

    #[test]
    fn matrix_at_or_above_is_strict_too() {
        let matrix = AdapterCapabilityMatrix::up_to(
            "kaifuu.x",
            CapabilityLevel::Inventory,
            "no extract path",
        );
        assert!(matrix.supports_at_least(CapabilityLevel::Identify));
        assert!(matrix.supports_at_least(CapabilityLevel::Inventory));
        assert!(!matrix.supports_at_least(CapabilityLevel::Extract));
    }
}
