use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Detection,
    Extraction,
    Patching,
    Verification,
    AssetListing,
    AssetInventory,
    NonTextSurfaceExtraction,
    ProfileGeneration,
    LineParityPatching,
    AssetTextPatching,
    DeltaPatching,
    EncryptedInput,
    KeyProfile,
    ContainerAccess,
    CryptoAccess,
    CodecAccess,
    PatchBack,
    RuntimeVm,
}

impl Capability {
    /// the container/crypto/codec/patch "transform axes" whose
    /// `Supported` reports are prone to being over-read as broad transform
    /// support. The identity/null-key-only annotation
    /// ([`CapabilityReport::identity_or_null_key_only`]) is meaningful ONLY for
    /// these capabilities — for anything else there is no broad-transform claim
    /// to over-read.
    pub fn is_transform_bearing(&self) -> bool {
        matches!(
            self,
            Capability::ContainerAccess
                | Capability::CryptoAccess
                | Capability::CodecAccess
                | Capability::PatchBack
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityStatus {
    Supported,
    Limited,
    Unsupported,
    RequiresUserInput,
}

/// canonical limitation note attached to an identity/null-key-only
/// capability report ([`CapabilityReport::identity_or_null_key_only`]). A
/// consumer reading only the free-text `limitation` still sees the boundary;
/// the machine-checkable [`CapabilityReport::identity_or_null_key_only`] marker
/// is the authoritative signal.
pub const IDENTITY_OR_NULL_KEY_ONLY_LIMITATION: &str = "identity/null-key-only: this capability is Supported only at the identity \
     rung of the layered access contract (null-key crypto, no archive repack, \
     no binary codec, no bytecode patch-back); no broader container/crypto/\
     codec/patch transform is claimed";

pub(crate) fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityReport {
    pub capability: Capability,
    pub status: CapabilityStatus,
    pub limitation: Option<String>,
    /// guards against OVER-READING a `Supported`
    /// container/crypto/codec/patch report as broad transform support. When
    /// `true`, the adapter implements only the identity / null-key rung of the
    /// layered access contract for this capability — no real
    /// archive repack, non-null crypto, binary codec, or bytecode patch-back.
    /// Skipped in JSON when `false`, so existing payloads round-trip unchanged
    /// and an ABSENT marker means "no identity/null-key-only claim" — the
    /// report is either a genuine broader transform or a non-transform
    /// capability. Only meaningful for [`Capability::is_transform_bearing`]
    /// capabilities.
    #[serde(default, skip_serializing_if = "is_false")]
    pub identity_or_null_key_only: bool,
}

impl CapabilityReport {
    pub fn supported(capability: Capability) -> Self {
        Self {
            capability,
            status: CapabilityStatus::Supported,
            limitation: None,
            identity_or_null_key_only: false,
        }
    }

    pub fn limited(capability: Capability, limitation: impl Into<String>) -> Self {
        Self {
            capability,
            status: CapabilityStatus::Limited,
            limitation: Some(limitation.into()),
            identity_or_null_key_only: false,
        }
    }

    pub fn unsupported(capability: Capability, limitation: impl Into<String>) -> Self {
        Self {
            capability,
            status: CapabilityStatus::Unsupported,
            limitation: Some(limitation.into()),
            identity_or_null_key_only: false,
        }
    }

    pub fn requires_user_input(capability: Capability, limitation: impl Into<String>) -> Self {
        Self {
            capability,
            status: CapabilityStatus::RequiresUserInput,
            limitation: Some(limitation.into()),
            identity_or_null_key_only: false,
        }
    }

    /// a container/crypto/codec/patch capability that WORKS
    /// (`Supported`) but only at the identity / null-key rung of the layered
    /// access contract. The report is explicitly annotated
    /// ([`identity_or_null_key_only`](Self::identity_or_null_key_only) = `true`)
    /// AND carries the canonical [`IDENTITY_OR_NULL_KEY_ONLY_LIMITATION`] note,
    /// so a consumer cannot over-read it as broad transform support.
    pub fn identity_or_null_key_only(capability: Capability) -> Self {
        Self {
            capability,
            status: CapabilityStatus::Supported,
            limitation: Some(IDENTITY_OR_NULL_KEY_ONLY_LIMITATION.to_string()),
            identity_or_null_key_only: true,
        }
    }

    /// annotate an existing report as identity/null-key-only
    /// stating the canonical limitation when none is present. Use when an
    /// adapter has built a `Supported` transform report but its real behaviour
    /// is only the identity/null-key rung.
    pub fn into_identity_or_null_key_only(mut self) -> Self {
        self.identity_or_null_key_only = true;
        if self.limitation.is_none() {
            self.limitation = Some(IDENTITY_OR_NULL_KEY_ONLY_LIMITATION.to_string());
        }
        self
    }

    /// `true` iff this report explicitly declares identity/null-key
    /// -only behaviour. Consumers use this to DISTINGUISH a genuine broad
    /// transform report (marker absent) from an identity/null-key-only one.
    pub fn is_identity_or_null_key_only(&self) -> bool {
        self.identity_or_null_key_only
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            capability: self.capability.clone(),
            status: self.status.clone(),
            limitation: self.limitation.as_deref().map(redact_for_log_or_report),
            identity_or_null_key_only: self.identity_or_null_key_only,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCapabilities {
    pub adapter_id: String,
    pub reports: Vec<CapabilityReport>,
    /// capability ladder. Every adapter MUST declare its 4-rung
    /// matrix at construction via [`AdapterCapabilities::new`]; there is no
    /// silent fallback that derives it from `reports`. This keeps identify-only
    /// engines from bubbling up to Extract/Patch on granular report drift.
    /// `normalize` uses [`AdapterCapabilityMatrix::derive_from_reports`] only as
    /// a drift-check that the declared matrix never overclaims against `reports`.
    pub level_matrix: AdapterCapabilityMatrix,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_contract: Option<LayeredAccessCapabilityContract>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_requirements: Vec<AdapterKeyRequirementDeclaration>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub helper_requirements: Vec<AdapterHelperRequirementDeclaration>,
}

impl AdapterCapabilities {
    /// Construct an adapter capability declaration.
    /// acceptance: every adapter MUST declare its 4-rung
    /// [`AdapterCapabilityMatrix`] at construction. There is no silent
    /// fallback from per-`Capability` reports to a derived matrix — that
    /// fallback was the audit-flagged risk (-F002) of recognised
    /// engines accidentally bubbling up to `Extract`/`Patch` because a
    /// granular report drifted. `derive_from_reports` is now a private
    /// drift-check helper used in `normalize` only.
    /// The declared matrix must not claim more than the granular `reports`
    /// support; that constraint is enforced in `normalize` via
    /// `debug_assert!` against `first_overclaim_against`.
    pub fn new(
        adapter_id: impl Into<String>,
        reports: Vec<CapabilityReport>,
        level_matrix: AdapterCapabilityMatrix,
    ) -> Self {
        let mut capabilities = Self {
            adapter_id: adapter_id.into(),
            reports,
            level_matrix,
            access_contract: None,
            key_requirements: vec![],
            helper_requirements: vec![],
        };
        capabilities.normalize();
        capabilities
    }

    pub fn with_access_contract(
        mut self,
        access_contract: LayeredAccessCapabilityContract,
    ) -> Self {
        self.access_contract = Some(access_contract);
        self.normalize();
        self
    }

    pub fn with_key_requirements(
        mut self,
        key_requirements: Vec<AdapterKeyRequirementDeclaration>,
    ) -> Self {
        self.key_requirements = key_requirements;
        self.normalize();
        self
    }

    pub fn with_helper_requirements(
        mut self,
        helper_requirements: Vec<AdapterHelperRequirementDeclaration>,
    ) -> Self {
        self.helper_requirements = helper_requirements;
        self.normalize();
        self
    }

    /// `true` iff this adapter declares a layered access contract
    /// that goes BEYOND the identity/null-key rung (a real container/crypto/
    /// codec/patch transform). When `false` — no contract, or a contract that
    /// is itself identity/null-key-only — any `Supported`
    /// container/crypto/codec/patch report is, at most, identity/null-key
    /// support and MUST be annotated as such to avoid over-read.
    pub fn declares_broader_transform_support(&self) -> bool {
        self.access_contract
            .as_ref()
            .is_some_and(|contract| !contract.is_identity_or_null_key_only())
    }

    /// over-read detector. Returns the transform-bearing
    /// capabilities whose reports are `Supported` but neither annotated
    /// identity/null-key-only NOR backed by a broader transform contract — i.e.
    /// reports a consumer could over-read as broad support. Empty when every
    /// such report is honestly annotated or genuinely backed by broader
    /// support, letting a consumer DISTINGUISH the two.
    pub fn identity_or_null_key_overreads(&self) -> Vec<Capability> {
        if self.declares_broader_transform_support() {
            return Vec::new();
        }
        self.reports
            .iter()
            .filter(|report| {
                report.capability.is_transform_bearing()
                    && report.status == CapabilityStatus::Supported
                    && !report.is_identity_or_null_key_only()
            })
            .map(|report| report.capability.clone())
            .collect()
    }

    pub fn normalize(&mut self) {
        self.reports.sort_by_key(|report| {
            (
                serde_json::to_string(&report.capability).unwrap_or_default(),
                serde_json::to_string(&report.status).unwrap_or_default(),
                report.limitation.clone(),
            )
        });
        self.key_requirements
            .sort_by_key(AdapterKeyRequirementDeclaration::sort_key);
        self.helper_requirements
            .sort_by_key(AdapterHelperRequirementDeclaration::sort_key);
        if let Some(access_contract) = &mut self.access_contract {
            access_contract.normalize();
        }
        // risk: detector report drift. The declared level matrix
        // must never claim more than the per-capability reports support.
        // `derive_from_reports` is conservative; `first_overclaim_against`
        // returns the first rung where the declared matrix is strictly more
        // optimistic than the derived one.
        let derived = AdapterCapabilityMatrix::derive_from_reports(&self.adapter_id, &self.reports);
        debug_assert!(
            self.level_matrix
                .first_overclaim_against(&derived)
                .is_none(),
            "adapter {:?} declared level_matrix overclaims against per-Capability reports at {:?}",
            self.adapter_id,
            self.level_matrix.first_overclaim_against(&derived)
        );
    }

    pub fn redacted_for_report(&self) -> Self {
        let mut capabilities = self.clone();
        capabilities.adapter_id = redact_for_log_or_report(&capabilities.adapter_id);
        capabilities.reports = capabilities
            .reports
            .iter()
            .map(CapabilityReport::redacted_for_report)
            .collect();
        capabilities.key_requirements = capabilities
            .key_requirements
            .iter()
            .map(AdapterKeyRequirementDeclaration::redacted_for_report)
            .collect();
        capabilities.helper_requirements = capabilities
            .helper_requirements
            .iter()
            .map(AdapterHelperRequirementDeclaration::redacted_for_report)
            .collect();
        capabilities.access_contract = capabilities
            .access_contract
            .as_ref()
            .map(LayeredAccessCapabilityContract::redacted_for_report);
        // Redact adapter_id inside the level matrix to match the outer
        // capabilities surface.
        capabilities.level_matrix.adapter_id = capabilities.adapter_id.clone();
        capabilities.normalize();
        capabilities
    }
}
