//! Private static-key parsing and validation primitives.

use std::fmt;

use zeroize::Zeroizing;

use crate::{KaifuuResult, KeyValidationMethod, KeyValidationProof, ProofHash, sha256_hash_bytes};

use super::{
    GAMEEXE_KNOWN_PLAINTEXT, STATIC_KEY_MARKER, STUB_EXE_TAG_PACKED, STUB_EXE_TAG_PROTECTED,
};

/// Recovered candidate key material. Raw bytes are private, never serialized,
/// redacted in `Debug`, and zeroized on drop.
pub(super) struct StaticKeyCandidate {
    pub(super) bytes: Zeroizing<Vec<u8>>,
}

impl StaticKeyCandidate {
    pub(super) fn byte_len(&self) -> usize {
        self.bytes.len()
    }

    /// One-way sha256 commitment to the key bytes (never the bytes themselves).
    pub(super) fn material_hash(&self) -> KaifuuResult<ProofHash> {
        Ok(ProofHash::new(sha256_hash_bytes(&self.bytes))?)
    }
}

impl fmt::Debug for StaticKeyCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StaticKeyCandidate")
            .field("bytes", &"[REDACTED:kaifuu.secret_redacted]")
            .field("byte_len", &self.bytes.len())
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StaticAnalysisError {
    UnsupportedPacker,
    ProtectedExecutable,
    KeyRegionNotFound,
}

/// Inspect the executable header, refuse packed / protected binaries, and
/// recover the embedded static key region. Raw key bytes remain private.
pub(super) fn analyze_siglus_executable(
    bytes: &[u8],
) -> Result<StaticKeyCandidate, StaticAnalysisError> {
    if bytes.len() >= 8 {
        let tag = &bytes[..8];
        if tag == STUB_EXE_TAG_PACKED {
            return Err(StaticAnalysisError::UnsupportedPacker);
        }
        if tag == STUB_EXE_TAG_PROTECTED {
            return Err(StaticAnalysisError::ProtectedExecutable);
        }
    }
    let marker =
        find_subslice(bytes, STATIC_KEY_MARKER).ok_or(StaticAnalysisError::KeyRegionNotFound)?;
    let len_index = marker + STATIC_KEY_MARKER.len();
    let key_len = *bytes
        .get(len_index)
        .ok_or(StaticAnalysisError::KeyRegionNotFound)? as usize;
    if key_len == 0 {
        return Err(StaticAnalysisError::KeyRegionNotFound);
    }
    let key_start = len_index + 1;
    let key_end = key_start
        .checked_add(key_len)
        .ok_or(StaticAnalysisError::KeyRegionNotFound)?;
    let key = bytes
        .get(key_start..key_end)
        .ok_or(StaticAnalysisError::KeyRegionNotFound)?;
    Ok(StaticKeyCandidate {
        bytes: Zeroizing::new(key.to_vec()),
    })
}

/// The validate-before-consume gate. Decrypt the `Gameexe.dat` known-plaintext
/// header with the candidate; a match is proof the key is correct.
pub(super) fn validate_candidate_against_gameexe(
    candidate: &StaticKeyCandidate,
    gameexe_bytes: &[u8],
) -> KaifuuResult<Option<KeyValidationProof>> {
    let magic_len = GAMEEXE_KNOWN_PLAINTEXT.len();
    let Some(header) = gameexe_bytes.get(..magic_len) else {
        return Ok(None);
    };
    let decrypted = xor_cycled(header, &candidate.bytes);
    if decrypted == GAMEEXE_KNOWN_PLAINTEXT {
        let proof = KeyValidationProof {
            method: KeyValidationMethod::KnownPlaintextProof,
            proof_hash: ProofHash::new(sha256_hash_bytes(&decrypted))?,
        };
        Ok(Some(proof))
    } else {
        Ok(None)
    }
}

pub(super) fn xor_cycled(data: &[u8], key: &[u8]) -> Vec<u8> {
    if key.is_empty() {
        return data.to_vec();
    }
    data.iter()
        .enumerate()
        .map(|(index, byte)| byte ^ key[index % key.len()])
        .collect()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
