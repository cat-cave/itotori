use super::*;

/// Content metadata safe to include in diagnostics without revealing bytes.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactedContentSummary {
    byte_len: usize,
    sha256: String,
}

impl RedactedContentSummary {
    #[must_use]
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self {
            byte_len: bytes.len(),
            sha256: sha256_hex(bytes),
        }
    }

    #[must_use]
    pub fn from_text(text: &str) -> Self {
        Self::from_bytes(text.as_bytes())
    }

    #[must_use]
    pub fn byte_len(&self) -> usize {
        self.byte_len
    }

    #[must_use]
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

impl fmt::Display for RedactedContentSummary {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} bytes (sha256 {})",
            self.byte_len, self.sha256
        )
    }
}

impl fmt::Debug for RedactedContentSummary {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RedactedContentSummary")
            .field("byte_len", &self.byte_len)
            .field("sha256", &self.sha256)
            .finish()
    }
}
