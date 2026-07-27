use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchExport {
    pub patch_export_id: String,
    pub source_locale: String,
    pub target_locale: String,
    pub entries: Vec<PatchExportEntry>,
}

impl PatchExport {
    pub fn from_value(value: &Value) -> KaifuuResult<Self> {
        Ok(serde_json::from_value(value.clone())?)
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchExportEntry {
    pub bridge_unit_id: String,
    pub source_unit_key: String,
    pub source_hash: String,
    pub target_text: String,
    pub protected_span_mappings: Vec<ProtectedSpanMapping>,
}

impl fmt::Debug for PatchExportEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PatchExportEntry")
            .field("bridge_unit_id", &self.bridge_unit_id)
            .field("source_unit_key", &self.source_unit_key)
            .field("source_hash", &self.source_hash)
            .field(
                "target_text",
                &RedactedContentSummary::from_text(&self.target_text),
            )
            .field("protected_span_mappings", &self.protected_span_mappings)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedSpanMapping {
    pub raw: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_span_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_start_byte: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_end_byte: Option<u64>,
    pub target_start: u64,
    pub target_end: u64,
}

impl fmt::Debug for ProtectedSpanMapping {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProtectedSpanMapping")
            .field("raw", &RedactedContentSummary::from_text(&self.raw))
            .field("source_span_id", &self.source_span_id)
            .field("source_start_byte", &self.source_start_byte)
            .field("source_end_byte", &self.source_end_byte)
            .field("target_start", &self.target_start)
            .field("target_end", &self.target_end)
            .finish()
    }
}

impl ProtectedSpanMapping {
    pub fn new(raw: impl Into<String>, target_start: u64, target_end: u64) -> Self {
        Self {
            raw: raw.into(),
            source_span_id: None,
            source_start_byte: None,
            source_end_byte: None,
            target_start,
            target_end,
        }
    }

    pub fn with_source_identity(
        mut self,
        source_span_id: Option<impl Into<String>>,
        source_start_byte: u64,
        source_end_byte: u64,
    ) -> Self {
        self.source_span_id = source_span_id.map(Into::into);
        self.source_start_byte = Some(source_start_byte);
        self.source_end_byte = Some(source_end_byte);
        self
    }

    pub fn first_in_target(raw: &str, target_text: &str) -> Option<Self> {
        let start = target_text.find(raw)?;
        let end = start + raw.len();
        Some(Self::new(raw, start as u64, end as u64))
    }

    pub fn matches_target_text(&self, target_text: &str) -> bool {
        let Ok(start) = usize::try_from(self.target_start) else {
            return false;
        };
        let Ok(end) = usize::try_from(self.target_end) else {
            return false;
        };
        if end <= start
            || end > target_text.len()
            || !target_text.is_char_boundary(start)
            || !target_text.is_char_boundary(end)
        {
            return false;
        }
        target_text[start..end] == self.raw
    }

    pub fn matches_source_span(
        &self,
        raw: &str,
        source_start_byte: Option<u64>,
        source_end_byte: Option<u64>,
        source_span_id: Option<&str>,
    ) -> bool {
        if self.raw != raw {
            return false;
        }
        if let Some(expected_span_id) = self.source_span_id.as_deref()
            && Some(expected_span_id) != source_span_id
        {
            return false;
        }
        if let Some(expected_start) = self.source_start_byte
            && Some(expected_start) != source_start_byte
        {
            return false;
        }
        if let Some(expected_end) = self.source_end_byte
            && Some(expected_end) != source_end_byte
        {
            return false;
        }
        true
    }

    pub fn has_source_identity(&self) -> bool {
        self.source_span_id.is_some()
            || self.source_start_byte.is_some()
            || self.source_end_byte.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchResult {
    pub schema_version: String,
    pub patch_result_id: String,
    pub patch_export_id: String,
    pub status: OperationStatus,
    pub output_hash: String,
    pub failures: Vec<AdapterFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub schema_version: String,
    pub patch_result_id: String,
    pub status: OperationStatus,
    pub output_hash: String,
    pub failures: Vec<AdapterFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoldenAssertionStatus {
    Passed,
    Failed,
    Skipped,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenPhaseReport {
    pub phase: String,
    pub status: GoldenAssertionStatus,
    pub details: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_unit_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_boundary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
    /// the capability an adapter-neutral asset assertion is keyed.
    /// Set for capability-aware asset diagnostics so an unsupported asset carries
    /// a TYPED capability code (not just prose), letting the harness assert on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_capability: Option<Capability>,
}

impl fmt::Debug for GoldenPhaseReport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GoldenPhaseReport")
            .field("phase", &self.phase)
            .field("status", &self.status)
            .field("details", &RedactedContentSummary::from_text(&self.details))
            .field("asset_ref", &self.asset_ref)
            .field("source_unit_key", &self.source_unit_key)
            .field(
                "support_boundary",
                &self
                    .support_boundary
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "expected",
                &self
                    .expected
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "actual",
                &self
                    .actual
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field("required_capability", &self.required_capability)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenFailure {
    pub code: String,
    pub phase: String,
    pub adapter_id: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_unit_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_boundary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
    /// capability an adapter-neutral asset-preservation failure is
    /// keyed on (e.g. the unsupported-surface capability whose asset mutated).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_capability: Option<Capability>,
}

impl fmt::Debug for GoldenFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GoldenFailure")
            .field("code", &self.code)
            .field("phase", &self.phase)
            .field("adapter_id", &self.adapter_id)
            .field("message", &RedactedContentSummary::from_text(&self.message))
            .field("asset_ref", &self.asset_ref)
            .field("source_unit_key", &self.source_unit_key)
            .field(
                "support_boundary",
                &self
                    .support_boundary
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "expected",
                &self
                    .expected
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "actual",
                &self
                    .actual
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field("required_capability", &self.required_capability)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenRoundTripReport {
    pub schema_version: String,
    pub report_id: String,
    pub adapter_id: String,
    pub adapter_name: String,
    pub status: OperationStatus,
    pub phases: Vec<GoldenPhaseReport>,
    pub failures: Vec<GoldenFailure>,
}

impl GoldenRoundTripReport {
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

pub enum GoldenByteEquivalenceMode {
    /// Fixture-shaped case: assert the single `source.json` file is byte-identical
    /// after an unchanged patch. Retained as ONE covered case; it assumes the
    /// fixture `source.json` layout and is NOT adapter-neutral.
    AssertSourceJson,
    /// adapter-neutral case: assert asset preservation (and emit
    /// capability-aware unsupported-asset diagnostics) purely from the adapter's
    /// own asset INVENTORY + CAPABILITY reports. Makes no assumption about a
    /// `source.json` file or any on-disk layout, so it works for any adapter.
    AssertInventory,
    Unsupported {
        support_boundary: String,
    },
}

pub struct GoldenHarnessRequest<'a> {
    pub game_dir: &'a Path,
    pub work_dir: &'a Path,
    pub adapter_id: Option<&'a str>,
    pub byte_equivalence: GoldenByteEquivalenceMode,
    pub translated_patch_export: Option<&'a Value>,
    pub translated_source_bridge: Option<&'a Value>,
}

/// an adapter-neutral asset-preservation claim derived from an
/// adapter's [`AssetInventoryManifest`] (inventory + capability reports) — NOT
/// from a fixture `source.json` layout.
/// A claim is raised for every asset backing a surface the adapter reports it
/// cannot edit (the surface's `patching` capability is `Unsupported`, or its
/// `patch_mode` is `Unsupported`). Because the adapter declares it cannot patch
/// that asset, an identity round-trip MUST leave the asset unchanged, and the
/// harness records a TYPED capability-aware diagnostic for the surface. The
/// claim carries only inventory/capability-sourced fields (`asset_id`,
/// `asset_ref` from `asset_key`, the `required_capability`, and the boundary),
/// so it is meaningful for any adapter regardless of on-disk layout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetPreservationClaim {
    pub asset_id: String,
    /// Adapter-neutral reference to the asset (its `asset_key`, falling back to
    /// `asset_id`); never a hard-coded `source.json` path.
    pub asset_ref: String,
    pub surface_id: String,
    pub required_capability: Capability,
    pub support_boundary: String,
}

/// derive adapter-neutral asset-preservation claims from an asset
/// inventory manifest.
/// This is a pure function over the manifest's `surfaces` + their `patching`
/// capability reports. It raises one [`AssetPreservationClaim`] per surface the
/// adapter reports as capability-unsupported. It reads nothing from disk and
/// assumes nothing about a `source.json` file, so the golden harness can drive
/// asset assertions off it for any adapter.
pub fn derive_asset_preservation_claims(
    manifest: &AssetInventoryManifest,
) -> Vec<AssetPreservationClaim> {
    let asset_key_by_id: BTreeMap<&str, &str> = manifest
        .assets
        .iter()
        .map(|asset| (asset.asset_id.as_str(), asset.asset_key.as_str()))
        .collect();

    let mut claims = Vec::new();
    for surface in &manifest.surfaces {
        let capability_unsupported = surface.patching.status == CapabilityStatus::Unsupported;
        let patch_mode_unsupported = surface.patch_mode == AssetInventoryPatchMode::Unsupported;
        if !capability_unsupported && !patch_mode_unsupported {
            continue;
        }
        let asset_id = surface.source_asset_ref.asset_id.clone();
        let asset_ref = surface
            .source_asset_ref
            .asset_key
            .clone()
            .or_else(|| {
                asset_key_by_id
                    .get(asset_id.as_str())
                    .map(|key| (*key).to_string())
            })
            .unwrap_or_else(|| asset_id.clone());
        let support_boundary = surface.patching.limitation.clone().unwrap_or_else(|| {
            format!(
                "adapter reports surface {} as capability-unsupported; the underlying asset must be preserved unchanged",
                surface.surface_id
            )
        });
        claims.push(AssetPreservationClaim {
            asset_id,
            asset_ref,
            surface_id: surface.surface_id.clone(),
            required_capability: surface.patching.capability.clone(),
            support_boundary,
        });
    }
    claims.sort_by(|a, b| {
        (a.surface_id.as_str(), a.asset_id.as_str())
            .cmp(&(b.surface_id.as_str(), b.asset_id.as_str()))
    });
    claims
}

/// the canonical, order-fixed projection of the inventory IDENTITY +
/// PATCH-DECISION fields that a surface's metadata hash commits to. Serialized
/// under the repo-wide `utf8-lf-json-stable` rule ([`stable_json`]) and hashed
/// with [`sha256_hash_bytes`], so the hash is deterministic and tamper-evident:
/// any drift of the asset id/key/path/source-hash, the surface kind, the
/// patch mode, or the declared patch capability changes the hash.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetMetadataHashInput<'a> {
    asset_id: &'a str,
    asset_key: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_hash: Option<&'a str>,
    surface_id: &'a str,
    surface_kind: &'a AssetInventorySurfaceKind,
    patch_mode: &'a AssetInventoryPatchMode,
    capability: &'a Capability,
    capability_status: &'a CapabilityStatus,
}

/// compute the stable metadata hash for one asset surface.
/// The hash binds the surface's PATCH-DECISION fields (`patch_mode`, the
/// `patching` capability + status, the surface kind) to the IDENTITY of the
/// asset it patches (`asset_id`, `asset_key`, `path`, `source_hash`, resolved
/// from the manifest's `assets` list, falling back to the surface's own
/// `source_asset_ref`). It is a pure function of those fields, so two manifests
/// that declare the same identity + patch capability for a surface always
/// produce the same hash, and any tamper with either changes it.
pub fn asset_inventory_surface_metadata_hash(
    manifest: &AssetInventoryManifest,
    surface: &AssetInventorySurface,
) -> String {
    let asset = manifest
        .assets
        .iter()
        .find(|asset| asset.asset_id == surface.source_asset_ref.asset_id);
    let asset_key = asset
        .map(|asset| asset.asset_key.as_str())
        .or(surface.source_asset_ref.asset_key.as_deref())
        .unwrap_or(surface.source_asset_ref.asset_id.as_str());
    let input = AssetMetadataHashInput {
        asset_id: surface.source_asset_ref.asset_id.as_str(),
        asset_key,
        path: asset.and_then(|asset| asset.path.as_deref()),
        source_hash: asset
            .and_then(|asset| asset.source_hash.as_deref())
            .or(surface.source_hash.as_deref()),
        surface_id: surface.surface_id.as_str(),
        surface_kind: &surface.asset_surface_kind,
        patch_mode: &surface.patch_mode,
        capability: &surface.patching.capability,
        capability_status: &surface.patching.status,
    };
    let canonical =
        stable_json(&input).expect("asset metadata hash input serializes deterministically");
    sha256_hash_bytes(canonical.as_bytes())
}
