//! Fixture-store trait and the [`verify_fixture_hashes`] helper.
//!
//! The trait is intentionally tiny: engine port crates implement it over
//! `fixtures/public/` (or any other byte source) and the helper re-hashes
//! the declared bytes against the map. This is OUT of the validator proper
//! because the validator is pure-data (`validate` never touches the
//! filesystem).

use super::diagnostics::FixtureHashMismatch;
use super::schema::ImplementationMap;

/// Byte source the helper reads from. The id matches
/// [`crate::port::impl_map::FixtureRef::id`].
pub trait FixtureStore {
    /// Read the bytes for a fixture id. Returns the canonical byte string —
    /// for directory fixtures, that means the canonicalized
    /// `(relative-path, file-hash, byte-count)` manifest defined in
    /// `.plan/.md` §9.5.
    fn read(&self, id: &str) -> Result<Vec<u8>, FixtureStoreError>;
}

/// Error returned by a [`FixtureStore`] implementation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FixtureStoreError {
    pub fixture_id: String,
    pub message: String,
}

impl std::fmt::Display for FixtureStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "fixture store error for {fixture_id}: {message}",
            fixture_id = super::diagnostics::redact_for_diagnostic(&self.fixture_id),
            message = super::diagnostics::redact_for_diagnostic(&self.message),
        )
    }
}

impl std::error::Error for FixtureStoreError {}

/// Re-hash each referenced fixture's bytes through the store and compare
/// against the declared hash. Returns `Ok(())` only when every fixture
/// either:
///
/// - hashes byte-for-byte to its declared hash; or
/// - is a `SyntheticInline` fixture (the store cannot read those — they
///   are generated in-test — and so the helper skips them).
pub fn verify_fixture_hashes<F: FixtureStore>(
    map: &ImplementationMap,
    store: &F,
) -> Result<(), Vec<FixtureHashMismatch>> {
    let mut mismatches = Vec::new();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();

    for subsystem in &map.subsystems {
        let fixture = &subsystem.fixture_ref;
        if !seen.insert(fixture.id.as_str()) {
            continue;
        }
        if matches!(
            fixture.classification,
            super::schema::FixtureClassification::SyntheticInline
        ) {
            continue;
        }

        let bytes = match store.read(fixture.id.as_str()) {
            Ok(bytes) => bytes,
            Err(error) => {
                // Surface the store error as a mismatch so the auditor
                // sees what failed without a separate Err path.
                mismatches.push(FixtureHashMismatch {
                    fixture_id: fixture.id.clone(),
                    declared_hash: fixture.hash.clone(),
                    observed_hash: format!("<store-error: {}>", error.message),
                });
                continue;
            }
        };
        let observed = sha256_hex(&bytes);
        if observed != fixture.hash {
            mismatches.push(FixtureHashMismatch {
                fixture_id: fixture.id.clone(),
                declared_hash: fixture.hash.clone(),
                observed_hash: observed,
            });
        }
    }

    if mismatches.is_empty() {
        Ok(())
    } else {
        Err(mismatches)
    }
}

/// SHA-256 hex (lowercase). Engine port crates that have `sha2` in their
/// dep tree can use it directly; we expose ours so the helper is
/// dep-free for callers that only depend on `utsushi-core`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = sha256_digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

// Minimal SHA-256 implementation. We deliberately avoid pulling `sha2` into
// the public dep tree of `utsushi-core` for this helper. The implementation
// is the textbook FIPS 180-4 algorithm; unit-tested against a known vector
// in this module's tests.

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

fn sha256_digest(message: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    // Pre-processing: padding.
    let bit_length = (message.len() as u64).wrapping_mul(8);
    let mut padded: Vec<u8> = Vec::with_capacity(message.len() + 64);
    padded.extend_from_slice(message);
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_length.to_be_bytes());

    for chunk in padded.chunks(64) {
        let mut w = [0u32; 64];
        for (i, block) in chunk.chunks(4).enumerate().take(16) {
            w[i] = u32::from_be_bytes([block[0], block[1], block[2], block[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vector_for_empty_input() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
    }

    #[test]
    fn sha256_matches_known_vector_for_abc() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    }
}
