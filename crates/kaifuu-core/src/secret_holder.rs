//! Shared zeroizing secret-holder primitive for Kaifuu crypt fixtures.
//! Raw key bytes enter through [`SecretRefSecretResolver`] entries, are minted
//! into [`ZeroizingSecretBytes`] only after a [`SecretRef`] binding is present,
//! and are then exposed only through narrow operations needed by crypt code.

use std::fmt;

use zeroize::Zeroizing;

use crate::{SecretRef, sha256_hash_bytes};

const REDACTED: &str = "[REDACTED:kaifuu.secret_redacted]";
const HEX_LOWER: &[u8; 16] = b"0123456789abcdef";
const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";
const BASE64_STANDARD: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_URL_SAFE: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// A non-`Clone`, zeroize-on-drop, `Debug`-redacting secret byte holder.
/// The raw-byte constructor is private to this module. Callers mint holders via
/// [`SecretRefSecretResolver`] so every holder is tied to a reportable
/// [`SecretRef`] entry before use.
pub struct ZeroizingSecretBytes {
    bytes: Zeroizing<Vec<u8>>,
}

impl ZeroizingSecretBytes {
    fn from_resolver_entry(bytes: Vec<u8>) -> Self {
        Self {
            bytes: Zeroizing::new(bytes),
        }
    }

    fn clone_from_holder(holder: &Self) -> Self {
        Self::from_resolver_entry(holder.bytes.to_vec())
    }

    /// Resolved key length in bytes. Reportable because it is a count only.
    #[must_use]
    pub fn byte_len(&self) -> usize {
        self.bytes.len()
    }

    /// A one-way sha256 commitment to the held bytes.
    #[must_use]
    pub fn sha256_material_hash(&self) -> String {
        sha256_hash_bytes(&self.bytes)
    }

    /// Apply the fixture XOR transforms used by the XP3 and Wolf smoke paths.
    /// The raw bytes never leave the holder; only transformed output is
    /// returned.
    #[must_use]
    pub fn apply_xor_filter(
        &self,
        data: &[u8],
        first_byte_xor: Option<u8>,
        position_xor: bool,
        per_byte_xor: u8,
    ) -> Vec<u8> {
        if self.bytes.is_empty() {
            return data.to_vec();
        }
        let mut out: Vec<u8> = data
            .iter()
            .enumerate()
            .map(|(index, byte)| {
                let mut transformed = byte ^ self.bytes[index % self.bytes.len()] ^ per_byte_xor;
                if position_xor {
                    transformed ^= index as u8;
                }
                transformed
            })
            .collect();
        if let (Some(first), Some(mask)) = (out.first_mut(), first_byte_xor) {
            *first ^= mask;
        }
        out
    }

    /// True iff the held key appears in `haystack` as raw bytes or as a common
    /// textual encoding (hex or standard/URL-safe base64, padded or unpadded).
    ///
    /// The encoded probe buffers are zeroized when they leave this method, so
    /// expanding the no-leak check does not leave a long-lived copy behind.
    #[must_use]
    pub fn appears_in(&self, haystack: &[u8]) -> bool {
        let raw = self.bytes.as_slice();
        if raw.is_empty() {
            return false;
        }

        contains_window(haystack, raw)
            || hex_appears_in(haystack, raw, HEX_LOWER)
            || hex_appears_in(haystack, raw, HEX_UPPER)
            || base64_appears_in(haystack, raw, BASE64_STANDARD, true)
            || base64_appears_in(haystack, raw, BASE64_STANDARD, false)
            || base64_appears_in(haystack, raw, BASE64_URL_SAFE, true)
            || base64_appears_in(haystack, raw, BASE64_URL_SAFE, false)
    }
}

fn contains_window(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && needle.len() <= haystack.len()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn hex_appears_in(haystack: &[u8], bytes: &[u8], alphabet: &[u8; 16]) -> bool {
    let encoded = hex_encode(bytes, alphabet);
    contains_window(haystack, &encoded)
}

fn hex_encode(bytes: &[u8], alphabet: &[u8; 16]) -> Zeroizing<Vec<u8>> {
    let mut encoded = Zeroizing::new(Vec::with_capacity(bytes.len().saturating_mul(2)));
    for byte in bytes {
        encoded.push(alphabet[usize::from(byte >> 4)]);
        encoded.push(alphabet[usize::from(byte & 0x0f)]);
    }
    encoded
}

fn base64_appears_in(haystack: &[u8], bytes: &[u8], alphabet: &[u8; 64], padded: bool) -> bool {
    let encoded = base64_encode(bytes, alphabet, padded);
    contains_window(haystack, &encoded)
}

fn base64_encode(bytes: &[u8], alphabet: &[u8; 64], padded: bool) -> Zeroizing<Vec<u8>> {
    let mut encoded = Zeroizing::new(Vec::with_capacity(
        bytes.len().div_ceil(3).saturating_mul(4),
    ));
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or_default();
        let third = chunk.get(2).copied().unwrap_or_default();

        encoded.push(alphabet[usize::from(first >> 2)]);
        encoded.push(alphabet[usize::from(((first & 0x03) << 4) | (second >> 4))]);
        if chunk.len() > 1 {
            encoded.push(alphabet[usize::from(((second & 0x0f) << 2) | (third >> 6))]);
        } else if padded {
            encoded.push(b'=');
        }
        if chunk.len() == 3 {
            encoded.push(alphabet[usize::from(third & 0x3f)]);
        } else if padded {
            encoded.push(b'=');
        }
    }
    encoded
}

impl fmt::Debug for ZeroizingSecretBytes {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ZeroizingSecretBytes")
            .field("bytes", &REDACTED)
            .field("byte_len", &self.bytes.len())
            .finish()
    }
}

/// Controlled SecretRef-bound resolver for zeroizing secret holders.
/// This is the single shared entry that accepts raw fixture key bytes. It
/// stores them immediately in [`ZeroizingSecretBytes`], resolves only by
/// [`SecretRef`], and exposes no raw-byte accessor.
#[derive(Default)]
pub struct SecretRefSecretResolver {
    entries: Vec<(String, ZeroizingSecretBytes)>,
}

impl SecretRefSecretResolver {
    /// Mint holders from `(secret_ref, raw_bytes)` entries.
    #[must_use]
    pub fn from_entries(entries: Vec<(String, Vec<u8>)>) -> Self {
        Self {
            entries: entries
                .into_iter()
                .map(|(secret_ref, bytes)| {
                    (secret_ref, ZeroizingSecretBytes::from_resolver_entry(bytes))
                })
                .collect(),
        }
    }

    /// Mint fresh holders from existing holders without exposing raw bytes.
    #[must_use]
    pub fn from_secret_refs(entries: Vec<(String, &ZeroizingSecretBytes)>) -> Self {
        Self {
            entries: entries
                .into_iter()
                .map(|(secret_ref, holder)| {
                    (secret_ref, ZeroizingSecretBytes::clone_from_holder(holder))
                })
                .collect(),
        }
    }

    /// Resolve a secret ref to a borrowed holder.
    #[must_use]
    pub fn resolve(&self, secret_ref: &SecretRef) -> Option<&ZeroizingSecretBytes> {
        self.entries
            .iter()
            .find(|(candidate, _)| candidate == secret_ref.as_str())
            .map(|(_, key)| key)
    }

    /// Resolve a secret ref and move the owned holder out of the resolver.
    #[must_use]
    pub fn into_resolved(mut self, secret_ref: &SecretRef) -> Option<ZeroizingSecretBytes> {
        let index = self
            .entries
            .iter()
            .position(|(candidate, _)| candidate == secret_ref.as_str())?;
        Some(self.entries.swap_remove(index).1)
    }

    /// True iff any held key appears in `haystack` as raw bytes or a supported
    /// textual encoding.
    #[must_use]
    pub fn any_key_appears_in(&self, haystack: &[u8]) -> bool {
        self.entries.iter().any(|(_, key)| key.appears_in(haystack))
    }

    /// Reportable refs held by this resolver. Refs are identifiers, not secret
    /// bytes.
    #[must_use]
    pub fn refs(&self) -> Vec<&str> {
        self.entries
            .iter()
            .map(|(secret_ref, _)| secret_ref.as_str())
            .collect()
    }

    /// Number of held entries.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether no entries are held.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl fmt::Debug for SecretRefSecretResolver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SecretRefSecretResolver")
            .field("entries", &self.refs())
            .field("entry_count", &self.entries.len())
            .field("keys", &REDACTED)
            .finish()
    }
}

#[cfg(test)]
#[path = "secret_holder_tests.rs"]
mod tests;
