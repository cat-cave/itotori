use super::*;

// Diagnostics — explicit + typed, never a broad string

/// Which layer of the transform stack a diagnostic is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompatLayer {
    Variant,
    Container,
    Crypto,
    Codec,
    Surface,
    PatchBack,
    Key,
    Helper,
    Evidence,
    Runtime,
}

impl CompatLayer {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Variant => "variant",
            Self::Container => "container",
            Self::Crypto => "crypto",
            Self::Codec => "codec",
            Self::Surface => "surface",
            Self::PatchBack => "patch_back",
            Self::Key => "key",
            Self::Helper => "helper",
            Self::Evidence => "evidence",
            Self::Runtime => "runtime",
        }
    }
}

/// The typed status of a layer. Deliberately does NOT include a bare
/// `unsupported` — an honest diagnostic states *why* (`not_implemented`,
/// `helper_required`, `missing_key`, `unknown_variant`, `known_key_only`,
/// `media_non_extractable`, `evidence_missing`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompatDiagnosticStatus {
    /// The layer is implemented and available (an affirmative note).
    Supported,
    /// The layer exists in the vocabulary but kaifuu has no implementation.
    NotImplemented,
    /// The layer is reachable only with an external helper present.
    HelperRequired,
    /// The layer needs key material that is not resolved.
    MissingKey,
    /// The engine family / variant is not recognized.
    UnknownVariant,
    /// Crypto works only against a catalogued known key, not arbitrary titles.
    KnownKeyOnly,
    /// An encrypted media asset that is recognized but non-extractable as text.
    MediaNonExtractable,
    /// A claimed level whose required evidence leg is absent (anti-overclaim).
    EvidenceMissing,
}

impl CompatDiagnosticStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::NotImplemented => "not_implemented",
            Self::HelperRequired => "helper_required",
            Self::MissingKey => "missing_key",
            Self::UnknownVariant => "unknown_variant",
            Self::KnownKeyOnly => "known_key_only",
            Self::MediaNonExtractable => "media_non_extractable",
            Self::EvidenceMissing => "evidence_missing",
        }
    }
}

/// A structured, typed compatibility diagnostic. Used both for the honest
/// author-declared gaps a tuple carries and for the findings
/// [`validate_claimed_support_tuple`] emits. Never a bare prose string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompatDiagnostic {
    pub layer: CompatLayer,
    pub status: CompatDiagnosticStatus,
    /// The typed reason code (never a free-form string).
    pub reason_id: SemanticErrorCode,
    pub severity: PartialDiagnosticSeverity,
    /// Optional human note — redacted in reports, never carries secrets/bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl CompatDiagnostic {
    pub fn new(
        layer: CompatLayer,
        status: CompatDiagnosticStatus,
        reason_id: SemanticErrorCode,
        severity: PartialDiagnosticSeverity,
    ) -> Self {
        Self {
            layer,
            status,
            reason_id,
            severity,
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// True iff this diagnostic is blocking (P0/P1) — flips the entry to
    /// [`crate::OperationStatus::Failed`].
    pub fn is_blocking(&self) -> bool {
        self.severity.is_blocking()
    }

    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            layer: self.layer,
            status: self.status,
            reason_id: self.reason_id,
            severity: self.severity,
            detail: self.detail.as_deref().map(redact_for_log_or_report),
        }
    }
}
