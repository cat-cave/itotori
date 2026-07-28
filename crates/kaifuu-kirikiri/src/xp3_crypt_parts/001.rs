use serde::{Deserialize, Serialize};
use thiserror::Error;

use kaifuu_core::{
    CodecTransform, HelperRedactionStatus, KaifuuResult, KeyMaterialKind, KeyValidationMethod,
    KeyValidationProof, OperationStatus, PLAIN_XP3_MANIFEST_SCHEMA_VERSION,
    PLAIN_XP3_MANIFEST_VARIANT, PlainXp3Archive, PlainXp3ArchiveEntry, PlainXp3ArchiveSegment,
    ProofHash, SecretRef, SecretRefScheme, compute_adler32, encode_xp3, read_json,
    read_plain_xp3_archive, redact_for_log_or_report,
    secret_holder::{SecretRefSecretResolver, ZeroizingSecretBytes},
    sha256_hash_bytes, stable_json,
};
use std::path::Path;

/// Every typed error's `Display` starts here so an audit can pin the module.
pub const XP3_CRYPT_MARKER: &str = "kaifuu.kirikiri.xp3_crypt";

/// Schema version of the fixture manifest + report.
pub const XP3_CRYPT_SCHEMA_VERSION: &str = "0.1.0";

/// Canonical capability id surfaced in the report.
pub const XP3_CRYPT_CAPABILITY_ID: &str = "kaifuu-kirikiri-xp3-crypt-smoke";

/// The engine family this fixture is for.
pub const XP3_CRYPT_ENGINE_FAMILY: &str = "kirikiri";

/// The container this fixture is for.
pub const XP3_CRYPT_CONTAINER: &str = "xp3";

/// The blunt support boundary carried in every report.
pub const XP3_CRYPT_SUPPORT_BOUNDARY: &str = "Kaifuu KiriKiri XP3-crypt smoke is a single profiled decrypt/extract fixture on a SYNTHETIC encrypted XP3: a real plain-XP3 container whose member file data is enciphered with a declared fixture crypt filter (keyed byte-XOR simplecrypt analogue) and a fixture-safe key resolved through a secret ref. It is NOT commercial encrypted-XP3 coverage and the fixture crypt filter is NOT a real per-title CxDec/TVP filter. Member integrity is checked against the XP3 adlr (adler-32 of plaintext). Wrong-key and missing-key inputs produce typed errors, never a panic or silent skip. The raw key never leaves the module: fixture/report carry only the secret requirement id + secret ref + one-way sha-256 commitments + counts.";

/// The public (non-secret) first-byte XOR parameter of the fixture crypt
/// profile. Part of the declared algorithm, NOT part of the secret key.
pub const XP3_CRYPT_FIRST_BYTE_XOR: u8 = 0x5A;

/// The public (non-secret) first-byte XOR parameter of the second
/// (position-dependent) fixture crypt profile. Part of the declared algorithm,
/// NOT part of the secret key.
pub const XP3_CRYPT_POSITION_FIRST_BYTE_XOR: u8 = 0x3C;

// These live ONLY here and inside [`Xp3CryptKey`]. They are fixture constants,
// never retail keys. The canonical refs below are what the fixture / report
// disclose; the raw bytes are never serialized or logged.

/// The canonical secret requirement id the fixture declares.
pub const XP3_CRYPT_REQUIREMENT_ID: &str = "kaifuu-k100-xp3-crypt-key";
/// The canonical valid fixture secret ref (resolves to the correct key).
/// The name is digit-free on purpose: the [`SecretRef`] validator treats long,
/// mixed-class, base64url-shaped names as suspected raw key material.
pub const XP3_CRYPT_VALID_SECRET_REF: &str = "local-secret:kaifuu-kirikiri-crypt-fixture-key";
/// A resolvable-but-WRONG fixture secret ref (resolves to the wrong key). Used
/// to prove wrong-key → typed integrity failure.
pub const XP3_CRYPT_WRONG_SECRET_REF: &str = "local-secret:kaifuu-kirikiri-crypt-wrong-key";
/// An UNKNOWN fixture secret ref (resolves to nothing). Used to prove
/// missing-key → typed resolution failure.
pub const XP3_CRYPT_MISSING_SECRET_REF: &str = "local-secret:kaifuu-kirikiri-crypt-absent-key";

/// The clearly-fake fixture key the synthetic archive is enciphered with. The
/// only place raw correct-key bytes exist; never leaves [`Xp3CryptKey`].
const SYNTHETIC_FIXTURE_KEY: &[u8; 16] = b"K100-XP3-XORKEY1";
/// A clearly-fake WRONG key (distinct from the correct one) for the wrong-key
/// probe.
const SYNTHETIC_WRONG_KEY: &[u8; 16] = b"K100-XP3-WRONGKY";

/// Clearly-synthetic member payloads (member id, authored plaintext). Obviously
/// fixture text — not extracted from any game.
const FIXTURE_MEMBERS: &[(&str, &str)] = &[
    (
        "scenario/intro.ks",
        "*start\n#Narrator\n[synthetic-kirikiri-xp3-crypt-line-0]\n@wait time=200\n",
    ),
    (
        "system/config.txt",
        "[synthetic-kirikiri-xp3-crypt-config]\nwindow=default\n",
    ),
];

/// The **public, data-driven** parameters of a fixture crypt scheme. These are
/// the *declared algorithm knobs*, NOT the secret key: a profile selects its
/// scheme purely from this data, so adding a new crypt variant is config, never
/// a per-title code branch. Every scheme is its own inverse (all-XOR), so
/// encipher and decipher are the same operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CryptScheme {
    /// XOR applied to the first byte (a public marker byte of the algorithm).
    pub first_byte_xor: u8,
    /// When `true`, each byte is additionally XOR'd with its `(position & 0xff)`,
    /// giving a genuinely position-dependent transform. Still self-inverse.
    pub position_xor: bool,
}

/// The crypt filter / cipher a fixture declares. The concrete byte transform is
/// a pure function of [`Xp3CryptoProfile::scheme`] (public data), so the engine
/// handles every profiled variant from data with no per-game branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum Xp3CryptoProfile {
    /// Keyed byte-cycled XOR + distinct first-byte XOR. A fixture transform
    /// modelled on the KiriKiri byte-XOR "simplecrypt" family — NOT a real
    /// per-title CxDec/TVP filter.
    XorSimpleCryptFixture,
    /// Keyed byte-cycled XOR + a **position-dependent** byte XOR + a distinct
    /// first-byte XOR. A second, genuinely-different fixture crypt scheme (its
    /// ciphertext differs from [`Self::XorSimpleCryptFixture`] for the same key),
    /// proving the extract/patch path is engine-general: the scheme is DATA, not
    /// a per-title code path. Still NOT a real per-title CxDec/TVP filter.
    XorPositionCryptFixture,
}

impl Xp3CryptoProfile {
    /// Stable label for reports.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::XorSimpleCryptFixture => "xor-simple-crypt-fixture",
            Self::XorPositionCryptFixture => "xor-position-crypt-fixture",
        }
    }

    /// The public, data-driven crypt scheme this profile selects. This is the
    /// single point where a profiled variant maps to its byte transform — the
    /// crypt scheme is DATA, so the extract/patch path never branches per game.
    #[must_use]
    pub fn scheme(self) -> Xp3CryptScheme {
        match self {
            Self::XorSimpleCryptFixture => Xp3CryptScheme {
                first_byte_xor: XP3_CRYPT_FIRST_BYTE_XOR,
                position_xor: false,
            },
            Self::XorPositionCryptFixture => Xp3CryptScheme {
                first_byte_xor: XP3_CRYPT_POSITION_FIRST_BYTE_XOR,
                position_xor: true,
            },
        }
    }
}

/// The extracted-content surface a fixture declares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum KirikiriXp3Surface {
    /// KAG scenario scripts + associated config text.
    ScenarioScript,
}

impl KirikiriXp3Surface {
    /// Stable label for reports.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ScenarioScript => "scenario-script",
        }
    }
}

/// The resolved crypt key. Raw material lives in the shared non-`Clone`,
/// zeroizing, `Debug`-redacting secret-holder primitive.
pub(crate) type Xp3CryptKey = ZeroizingSecretBytes;

pub(crate) trait Xp3CryptKeyExt {
    /// One-way sha-256 commitment to the key bytes (never the bytes themselves).
    fn material_hash(&self) -> Result<ProofHash, Xp3CryptError>;

    /// Apply the fixture crypt filter for a declared, data-driven crypt
    /// [`Xp3CryptScheme`]. Every scheme is its own inverse (all-XOR), so this
    /// both enciphers and deciphers.
    fn apply_filter(&self, scheme: Xp3CryptScheme, data: &[u8]) -> Vec<u8>;
}

impl Xp3CryptKeyExt for Xp3CryptKey {
    fn material_hash(&self) -> Result<ProofHash, Xp3CryptError> {
        ProofHash::new(self.sha256_material_hash())
            .map_err(|message| Xp3CryptError::Internal { message })
    }

    fn apply_filter(&self, scheme: Xp3CryptScheme, data: &[u8]) -> Vec<u8> {
        self.apply_xor_filter(data, Some(scheme.first_byte_xor), scheme.position_xor, 0)
    }
}

/// Resolves a [`SecretRef`] to fixture-safe key material.
/// This is the seam the decrypt path consumes: it is handed a requirement id +
/// a secret ref and returns a borrowed [`Xp3CryptKey`] (raw bytes confined to
/// the zeroize-on-drop holder) or a typed [`Xp3CryptError::MissingSecret`]. It
/// never surfaces raw bytes to the caller. The real scoped run would consume a
/// validated key-ref here; the fixture maps the canonical refs to obviously-fake
/// constants.
/// # Secret discipline
/// The raw key bytes are never stored bare: each entry holds the material inside
/// the module-private, zeroize-on-drop, `Debug`-redacting [`Xp3CryptKey`], and
/// [`Self::resolve`] hands the key back BY REF so no raw key is ever copied out,
/// re-stored, or emitted. `Debug` is therefore safe (the holder redacts its
/// bytes); a manual [`std::fmt::Debug`] impl reinforces that no key material can
/// ever be formatted. Deliberately NOT `Clone`: the resolved key must not be
/// duplicated past this boundary.
pub struct FixtureSecretResolver {
    entries: SecretRefSecretResolver,
}

impl FixtureSecretResolver {
    /// The default fixture resolver: the valid ref → the correct fixture key,
    /// the wrong ref → a distinct wrong key. Any other ref is missing.
    pub fn fixture_default() -> Self {
        Self::from_entries(vec![
            (
                XP3_CRYPT_VALID_SECRET_REF.to_string(),
                SYNTHETIC_FIXTURE_KEY.to_vec(),
            ),
            (
                XP3_CRYPT_WRONG_SECRET_REF.to_string(),
                SYNTHETIC_WRONG_KEY.to_vec(),
            ),
        ])
    }

    /// Build a resolver from `(secret_ref, raw_bytes)` entries. This is the
    /// controlled construction entry: raw bytes are immediately minted into the
    /// shared zeroizing holder and are thereafter resolved only by `SecretRef`.
    fn from_entries(entries: Vec<(String, Vec<u8>)>) -> Self {
        Self {
            entries: SecretRefSecretResolver::from_entries(entries),
        }
    }

    /// Build a resolver by binding declared secret refs to existing key HOLDERS.
    /// The raw key material never leaves an [`Xp3CryptKey`]: each source holder's
    /// bytes are copied into a fresh zeroize-on-drop holder inside the resolver
    /// (this is intra-module, so no bytes are ever exposed to a caller). Used by
    /// the production driver to route a variant's already-confined resolved key
    /// through the ref path without ever materializing raw bytes in a `pub`
    /// struct.
    pub(crate) fn from_key_refs(entries: Vec<(String, &Xp3CryptKey)>) -> Self {
        Self {
            entries: SecretRefSecretResolver::from_secret_refs(entries),
        }
    }

    fn into_key(self, secret_ref: &SecretRef) -> Option<Xp3CryptKey> {
        self.entries.into_resolved(secret_ref)
    }

    /// Resolve `secret_ref` to fixture-safe key material BY REF, or a typed
    /// missing-secret error citing the requirement id. Never returns or copies
    /// the raw key bytes: the borrow keeps the material inside the resolver's
    /// zeroize-on-drop holder.
    pub(crate) fn resolve(
        &self,
        requirement_id: &str,
        secret_ref: &SecretRef,
    ) -> Result<&Xp3CryptKey, Xp3CryptError> {
        self.entries
            .resolve(secret_ref)
            .ok_or_else(|| Xp3CryptError::MissingSecret {
                requirement_id: requirement_id.to_string(),
                secret_ref_scheme: secret_ref.scheme(),
            })
    }

    /// Does any resolver-held key material appear in `haystack` as raw bytes or
    /// a supported textual encoding? Used by the no-leak guard so
    /// registry/resolver-held bytes are covered, not just the serialized report.
    pub(crate) fn any_key_appears_in(&self, haystack: &[u8]) -> bool {
        self.entries.any_key_appears_in(haystack)
    }
}

impl std::fmt::Debug for FixtureSecretResolver {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Manual redacting Debug: never format the held key material. The refs
        // are safe to show (they are the reportable identifiers); the holders
        // are already `Debug`-redacting but we render only their count + refs so
        // no key bytes can ever be reached through this impl.
        formatter
            .debug_struct("FixtureSecretResolver")
            .field("entries", &self.entries.len())
            .field("secret_refs", &self.entries.refs())
            .field("key_material", &"[REDACTED:kaifuu.secret_redacted]")
            .finish()
    }
}

fn module_private_fixture_secret_holder(secret_ref: &SecretRef, bytes: Vec<u8>) -> Xp3CryptKey {
    FixtureSecretResolver::from_entries(vec![(secret_ref.as_str().to_string(), bytes)])
        .into_key(secret_ref)
        .expect("newly inserted XP3 key must resolve by its SecretRef")
}

/// Fatal errors raised by the XP3-crypt decrypt/extract path. Every variant's
/// `Display` begins with [`XP3_CRYPT_MARKER`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum Xp3CryptError {
    /// The secret ref could not be resolved to key material. Missing-key path.
    #[error(
        "{XP3_CRYPT_MARKER}.missing_secret: no key material for requirement {requirement_id} \
         (secret-ref scheme {secret_ref_scheme})"
    )]
    MissingSecret {
        /// The secret requirement id that went unresolved.
        requirement_id: String,
        /// The scheme of the ref that failed to resolve.
        secret_ref_scheme: SecretRefScheme,
    },
    /// A member decrypted to bytes whose adler-32 did not match the stored
    /// `adlr` — the key was wrong. Wrong-key path.
    #[error(
        "{XP3_CRYPT_MARKER}.integrity_check_failed: member {member_id} failed adler-32 integrity \
         after decrypt (wrong key)"
    )]
    IntegrityCheckFailed {
        /// The in-archive member id whose integrity check failed.
        member_id: String,
    },
    /// A member carried no `adlr` integrity chunk, so decrypt cannot be
    /// verified. Refused rather than claiming a faithful decrypt.
    #[error(
        "{XP3_CRYPT_MARKER}.missing_integrity: member {member_id} has no adlr chunk; refusing to \
         claim a verified decrypt"
    )]
    MissingIntegrity {
        /// The in-archive member id lacking integrity data.
        member_id: String,
    },
    /// The XP3 container could not be read by the shared plain-XP3 reader.
    #[error("{XP3_CRYPT_MARKER}.container_read: {detail}")]
    ContainerRead {
        /// The (structural, path-free) reader diagnostic.
        detail: String,
    },
    /// A declared expectation (member set) was not met.
    #[error("{XP3_CRYPT_MARKER}.expectation_mismatch: {detail}")]
    ExpectationMismatch {
        /// What did not match.
        detail: String,
    },
    /// An internal proof/serialization failure (redacted).
    #[error("{XP3_CRYPT_MARKER}.internal: {message}")]
    Internal {
        /// Redacted internal detail.
        message: String,
    },
}

/// Build the synthetic encrypted XP3 archive: a real plain-XP3 container whose
/// member file data is enciphered with the fixture crypt filter + fixture key.
/// The `adlr` chunk stores the adler-32 of the **plaintext** (KiriKiri
/// semantics), so a correct key reproduces it and a wrong key does not.
pub fn build_synthetic_crypt_xp3() -> Vec<u8> {
    let secret_ref = SecretRef::new(XP3_CRYPT_VALID_SECRET_REF).expect("fixture ref is valid");
    let key = module_private_fixture_secret_holder(&secret_ref, SYNTHETIC_FIXTURE_KEY.to_vec());
    let members: Vec<(String, Vec<u8>)> = FIXTURE_MEMBERS
        .iter()
        .map(|(path, text)| ((*path).to_string(), text.as_bytes().to_vec()))
        .collect();
    encode_encrypted_xp3(
        &members,
        &key,
        Xp3CryptoProfile::XorSimpleCryptFixture.scheme(),
    )
}

/// Encode an encrypted XP3 container from `(member id, plaintext)` pairs and a
/// resolved key: encipher each member's **file data** with the fixture crypt
/// filter and store the `adlr` adler-32 of the **plaintext** (KiriKiri
/// semantics), then hand the entries to the shared plain-XP3 encoder.
/// This is the single encode path the build and the
/// patch-back rebuild both go through, so `encode(decrypt(x))` with no change
/// is byte-identical and a trivial replacement recomputes member sizes / index
/// offsets through the same deterministic encoder.
pub(crate) fn encode_encrypted_xp3(
    members: &[(String, Vec<u8>)],
    key: &Xp3CryptKey,
    scheme: Xp3CryptScheme,
) -> Vec<u8> {
    let entries: Vec<PlainXp3ArchiveEntry> = members
        .iter()
        .map(|(path, plaintext)| {
            let plaintext_adler = compute_adler32(plaintext);
            let ciphertext = key.apply_filter(scheme, plaintext);
            let size = ciphertext.len() as u64;
            PlainXp3ArchiveEntry {
                path: path.clone(),
                // original_size == archive_size: the XOR filter preserves length
                // and the fixture is uncompressed.
                original_size: size,
                archive_size: size,
                stored_adler32: Some(plaintext_adler),
                segments: vec![PlainXp3ArchiveSegment {
                    flags: 0,
                    original_size: size,
                    archive_size: size,
                }],
                payload: ciphertext,
            }
        })
        .collect();
    encode_xp3(&PlainXp3Archive {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: PLAIN_XP3_MANIFEST_VARIANT.to_string(),
        entries,
    })
    .expect("synthetic crypt XP3 encodes")
}

/// One decrypted member (hash-based; no raw plaintext).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Xp3CryptExtractedMember {
    /// The in-archive member id.
    pub member_id: String,
    /// Decrypted plaintext byte length.
    pub plaintext_byte_len: u64,
    /// sha-256 commitment to the decrypted plaintext (never the plaintext).
    pub plaintext_hash: ProofHash,
    /// The verified adler-32 of the plaintext, formatted `adler32:<8 hex>`.
    pub adler32: String,
}

/// The decrypt/extract manifest: decrypted members as hash-based digests only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Xp3CryptManifest {
    /// Decrypted members, in archive order.
    pub members: Vec<Xp3CryptExtractedMember>,
}

/// One decrypted member with its recovered **plaintext bytes** and the stored
/// adler-32 it was verified against. Crate-private: the plaintext never leaves
/// the module boundary except as a one-way hash in a report.
pub(crate) struct Xp3DecryptedMember {
    /// The in-archive member id.
    pub(crate) member_id: String,
    /// The verified decrypted plaintext.
    pub(crate) plaintext: Vec<u8>,
    /// The stored `adlr` adler-32 (of the plaintext) the member verified against.
    pub(crate) stored_adler: u32,
}


