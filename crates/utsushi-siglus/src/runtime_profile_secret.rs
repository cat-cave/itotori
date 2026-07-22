use super::*;

// --- Secret reference -------------------------------------------------------

/// A structured, **local** secret reference. Runtime reports name key material
/// only through this — never raw bytes. Mirrors the KAIFUU `SecretRef`
/// discipline: a `scheme:name` string in a local-secret scheme, carrying no raw
/// key material, no local path, no whitespace, no traversal, no null bytes.
///
/// Serializes as its string form. `Debug` is redacted so an accidental
/// `{:?}` never prints the (non-secret, but still access-controlled) ref.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretRef(String);

impl SecretRef {
    /// Validate + construct. Returns `Err` with a stable message if the value
    /// is not a well-formed local secret reference.
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        let value = value.into();
        if is_valid_secret_ref(&value) {
            Ok(Self(value))
        } else {
            Err(
                "secretRef must use a local secret-ref scheme and must not contain raw key \
                 material, local paths, whitespace, parent traversal, or null bytes"
                    .to_string(),
            )
        }
    }

    /// Borrow the underlying `scheme:name` string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretRef {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("SecretRef")
            .field(&"<secret-ref>")
            .finish()
    }
}

impl std::fmt::Display for SecretRef {
    // A secret-ref is a *reference* to key material, not the material itself
    // (the validator forbids raw key bytes / paths in the name), so it is safe
    // to surface in a typed diagnostic message.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for SecretRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SecretRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

/// The known-good runtime-profile secret-ref scheme prefixes.
const SECRET_REF_SCHEMES: &[&str] = &["local-secret", "os-keychain", "secret-manager", "prompt"];

fn is_valid_secret_ref(value: &str) -> bool {
    let Some((scheme, name)) = value.split_once(':') else {
        return false;
    };
    if !SECRET_REF_SCHEMES.contains(&scheme) {
        return false;
    }
    if name.is_empty()
        || name.trim() != name
        || name.contains('\0')
        || name.contains('\\')
        || name.contains('/')
        || name.contains("..")
    {
        return false;
    }
    // A secret-ref *name* must never itself look like a local path (defence in
    // depth on top of the report-wide redaction sweep).
    if utsushi_core::looks_like_local_path(value) {
        return false;
    }
    name.chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
}

// --- One-way proof hash -----------------------------------------------------

/// A one-way, 64-char lowercase-hex sha256 commitment. Used to reference key
/// material and container bytes in reports *without* carrying the bytes.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProofHash(String);

impl ProofHash {
    /// Commit to `bytes` with a sha256 hex digest.
    pub fn commit(bytes: &[u8]) -> Self {
        Self(sha256_hex(bytes))
    }

    /// Borrow the hex digest.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for ProofHash {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_tuple("ProofHash").field(&self.0).finish()
    }
}

// --- Module-private key holder ----------------------------------------------

/// Resolved runtime key bytes. Raw material is module-private, never
/// serialized, redacted in `Debug`, and zeroized on drop. Nothing public
/// returns or logs these bytes; the only outward-facing surfaces are a byte
/// length and a one-way [`ProofHash`] commitment.
pub(super) struct RuntimeKeyMaterial {
    bytes: Vec<u8>,
}

impl RuntimeKeyMaterial {
    pub(super) fn from_resolved_bytes(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    pub(super) fn byte_len(&self) -> usize {
        self.bytes.len()
    }

    pub(super) fn commitment(&self) -> ProofHash {
        ProofHash::commit(&self.bytes)
    }

    /// Reject-on-secret probe: does the raw key appear as a contiguous window
    /// inside `haystack`? Returns only a boolean — never the bytes.
    pub(super) fn appears_in(&self, haystack: &[u8]) -> bool {
        if self.bytes.is_empty() || self.bytes.len() > haystack.len() {
            return false;
        }
        haystack
            .windows(self.bytes.len())
            .any(|window| window == self.bytes)
    }
}

impl Drop for RuntimeKeyMaterial {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}

impl std::fmt::Debug for RuntimeKeyMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeKeyMaterial")
            .field("bytes", &"[REDACTED:utsushi.secret_redacted]")
            .field("byte_len", &self.bytes.len())
            .finish()
    }
}
