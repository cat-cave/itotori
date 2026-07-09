//! KAIFUU-100 — one **profiled XP3 crypt** decrypt/extract fixture.
//!
//! # What this is (and is not)
//!
//! This module proves the **secret-ref decrypt path** for an encrypted KiriKiri
//! XP3 archive end-to-end, on a **synthetic, fixture-safe** archive:
//!
//! 1. it builds a synthetic encrypted XP3 (real XP3 container — the shared
//!    [`kaifuu_core`] plain-XP3 reader/writer owns the bytes — whose member
//!    **file data** is passed through a declared crypt filter with a
//!    fixture-safe key);
//! 2. it resolves the decrypt key through a **secret ref** (a requirement id +
//!    a [`SecretRef`] resolved to fixture-safe key material at runtime), never a
//!    hard-coded key value;
//! 3. it decrypts + extracts every member, verifying each member's integrity
//!    against the XP3 `adlr` (adler-32 of the plaintext) — KiriKiri's own
//!    integrity oracle — and emits a **hash-based manifest** (member ids, byte
//!    lengths, sha-256 commitments; never raw decrypted content);
//! 4. it proves that a **wrong** secret ref (a resolvable but wrong key) fails
//!    the integrity check with a typed error, and that a **missing** secret ref
//!    fails resolution with a typed error — never a panic, never a silent skip.
//!
//! The raw key material only ever lives inside the module-private,
//! zeroize-on-drop, `Debug`-redacting [`Xp3CryptKey`]. The fixture and report
//! carry only the **secret requirement id + [`SecretRef`] + one-way sha-256
//! commitments + counts** — never the raw key.
//!
//! ## Honest scope (assumed vs. verified)
//!
//! - **Container (verified):** a genuine plain-XP3 archive built and re-read via
//!   the shared [`kaifuu_core::encode_xp3`] / [`kaifuu_core::read_plain_xp3_archive`]
//!   path. Only member **file data** is enciphered; the XP3 index (member paths,
//!   sizes, `adlr`) stays plaintext, which matches how the common KiriKiri data
//!   filters work (they transform file bytes, not the index).
//! - **Crypt filter ([`Xp3CryptoProfile::XorSimpleCryptFixture`], assumed /
//!   synthetic):** a keyed, byte-cycled XOR plus a distinct first-byte XOR. This
//!   is a *fixture* transform modelled on the KiriKiri byte-XOR "simplecrypt"
//!   family; it is deliberately NOT a real per-title CxDec/TVP filter, and the
//!   doc says so out loud. Its only job is to make the payload opaque without the
//!   key so the secret-ref decrypt path and its failure modes are real. The
//!   filter is its own inverse, so encrypt and decrypt are the same operation.
//! - **Integrity oracle (verified-faithful):** the `adlr` adler-32 stored in the
//!   XP3 is computed over the *plaintext*; a correct key reproduces it, a wrong
//!   key does not. This is KiriKiri's real integrity check, not an invented one.
//!
//! No retail bytes, no real key material: the members are clearly-synthetic
//! authored text and the key is an obviously-fake fixture constant.

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

// --- Fixture-safe (clearly-fake) secret material ----------------------------
//
// These live ONLY here and inside [`Xp3CryptKey`]. They are fixture constants,
// never retail keys. The canonical refs below are what the fixture / report
// disclose; the raw bytes are never serialized or logged.

/// The canonical secret requirement id the fixture declares.
pub const XP3_CRYPT_REQUIREMENT_ID: &str = "kaifuu-k100-xp3-crypt-key";
/// The canonical valid fixture secret ref (resolves to the correct key).
///
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

// --- Declared profile enums -------------------------------------------------

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

// --- Module-private key holder ----------------------------------------------

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

// --- Secret-ref resolver ----------------------------------------------------

/// Resolves a [`SecretRef`] to fixture-safe key material.
///
/// This is the seam the decrypt path consumes: it is handed a requirement id +
/// a secret ref and returns a borrowed [`Xp3CryptKey`] (raw bytes confined to
/// the zeroize-on-drop holder) or a typed [`Xp3CryptError::MissingSecret`]. It
/// never surfaces raw bytes to the caller. The real scoped run would consume a
/// validated key-ref here; the fixture maps the canonical refs to obviously-fake
/// constants.
///
/// # Secret discipline
///
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

    /// Does any resolver-held raw key material appear as a contiguous window in
    /// `haystack`? Used by the no-leak guard so registry/resolver-held bytes are
    /// covered, not just the serialized report.
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

// --- Errors -----------------------------------------------------------------

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

// --- Synthetic encrypted-XP3 builder ----------------------------------------

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
///
/// This is the single encode path the KAIFUU-100 build and the KAIFUU-101
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

// --- Decrypt + extract ------------------------------------------------------

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

/// Decrypt + verify every member of an encrypted XP3 using the resolved key,
/// returning the recovered **plaintext** per member. Each member is checked
/// against its stored `adlr` adler-32; a wrong key trips the integrity check
/// with a typed [`Xp3CryptError::IntegrityCheckFailed`]. This is the shared
/// decrypt path both the hash-only manifest and the patch-back extract go
/// through, so integrity is verified in exactly one place.
pub(crate) fn decrypt_members(
    container: &[u8],
    key: &Xp3CryptKey,
    scheme: Xp3CryptScheme,
) -> Result<Vec<Xp3DecryptedMember>, Xp3CryptError> {
    let archive =
        read_plain_xp3_archive(container).map_err(|error| Xp3CryptError::ContainerRead {
            detail: error.to_string(),
        })?;

    let mut members = Vec::with_capacity(archive.entries.len());
    for entry in &archive.entries {
        let stored_adler = entry
            .stored_adler32
            .ok_or_else(|| Xp3CryptError::MissingIntegrity {
                member_id: entry.path.clone(),
            })?;
        let plaintext = key.apply_filter(scheme, &entry.payload);
        if compute_adler32(&plaintext) != stored_adler {
            return Err(Xp3CryptError::IntegrityCheckFailed {
                member_id: entry.path.clone(),
            });
        }
        members.push(Xp3DecryptedMember {
            member_id: entry.path.clone(),
            plaintext,
            stored_adler,
        });
    }
    Ok(members)
}

/// Decrypt + extract every member of an encrypted XP3 using the resolved key,
/// verifying each member against its stored `adlr` adler-32, and emit the
/// hash-based manifest (no raw plaintext). A wrong key trips the integrity
/// check with a typed [`Xp3CryptError::IntegrityCheckFailed`].
pub(crate) fn decrypt_and_extract(
    container: &[u8],
    key: &Xp3CryptKey,
    scheme: Xp3CryptScheme,
) -> Result<Xp3CryptManifest, Xp3CryptError> {
    let members = decrypt_members(container, key, scheme)?
        .into_iter()
        .map(|member| {
            Ok(Xp3CryptExtractedMember {
                member_id: member.member_id,
                plaintext_byte_len: member.plaintext.len() as u64,
                plaintext_hash: ProofHash::new(sha256_hash_bytes(&member.plaintext))
                    .map_err(|message| Xp3CryptError::Internal { message })?,
                adler32: format!("adler32:{:08x}", member.stored_adler),
            })
        })
        .collect::<Result<Vec<_>, Xp3CryptError>>()?;
    Ok(Xp3CryptManifest { members })
}

// --- Fixture manifest -------------------------------------------------------

/// Where the encrypted XP3 container bytes come from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub enum Xp3CryptContainerSource {
    /// Build the synthetic encrypted XP3 in-process (public CI; no bytes on
    /// disk).
    SyntheticStub,
    /// Read a scoped local encrypted XP3 in-process (never shelled out to).
    /// Path is relative to the fixture directory.
    LocalFile {
        /// Relative path to the scoped local archive.
        path: String,
    },
}

/// The profiled XP3-crypt fixture. Declares every required field:
/// `engine_family`, `container`, crypto profile, codec, surface, fixture id,
/// and the secret **requirement id** + secret ref (never a raw key).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Xp3CryptFixture {
    /// Schema version.
    pub schema_version: String,
    /// Stable fixture id.
    pub fixture_id: String,
    /// The spec-DAG node id this fixture is authored for (e.g. `KAIFUU-100`).
    pub source_node_id: String,
    /// Engine family (`kirikiri`).
    pub engine_family: String,
    /// Container (`xp3`).
    pub container: String,
    /// Declared crypt filter / cipher.
    pub crypto_profile: Xp3CryptoProfile,
    /// Declared content codec.
    pub codec: CodecTransform,
    /// Declared extracted-content surface.
    pub surface: KirikiriXp3Surface,
    /// The secret **requirement id** (never raw key material).
    pub secret_requirement_id: String,
    /// The structured secret ref the decrypt key is published under.
    pub secret_ref: SecretRef,
    /// Where the encrypted container bytes come from.
    pub container_source: Xp3CryptContainerSource,
    /// Declared expected member set (ids, in archive order).
    pub expected_member_ids: Vec<String>,
}

// --- Report -----------------------------------------------------------------

/// Per-member digest in the report (hash-based; no raw plaintext).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CryptMemberDigest {
    /// The in-archive member id.
    pub member_id: String,
    /// Decrypted plaintext byte length.
    pub plaintext_byte_len: u64,
    /// sha-256 commitment to the decrypted plaintext.
    pub plaintext_hash: ProofHash,
    /// The verified adler-32 (`adler32:<hex>`).
    pub adler32: String,
}

impl Xp3CryptMemberDigest {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            member_id: redact_for_log_or_report(&self.member_id),
            plaintext_byte_len: self.plaintext_byte_len,
            plaintext_hash: self.plaintext_hash.clone(),
            adler32: redact_for_log_or_report(&self.adler32),
        }
    }
}

/// The wrong-key probe outcome: a resolvable-but-wrong ref must fail the
/// integrity check with a typed error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CryptWrongKeyReport {
    /// The wrong secret ref that was attempted.
    pub attempted_secret_ref: SecretRef,
    /// Always `true`: the attempt was refused with a typed error.
    pub typed_error: bool,
    /// The stable diagnostic code the refusal carried.
    pub diagnostic_code: String,
    /// The in-archive member id the integrity failure cited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_id: Option<String>,
}

/// The missing-key probe outcome: an unknown ref must fail resolution with a
/// typed error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CryptMissingKeyReport {
    /// The unresolved requirement id.
    pub attempted_requirement_id: String,
    /// Always `true`: the attempt was refused with a typed error.
    pub typed_error: bool,
    /// The stable diagnostic code the refusal carried.
    pub diagnostic_code: String,
}

/// The full XP3-crypt smoke report. Redact before serialization via
/// [`Xp3CryptReport::stable_json`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CryptReport {
    /// Report schema version.
    pub schema_version: String,
    /// Capability id.
    pub capability_id: String,
    /// The spec-DAG node id.
    pub source_node_id: String,
    /// The blunt support boundary.
    pub support_boundary: String,
    /// Fixture id.
    pub fixture_id: String,
    /// Engine family (`kirikiri`).
    pub engine_family: String,
    /// Container (`xp3`).
    pub container: String,
    /// Declared crypt filter / cipher.
    pub crypto_profile: Xp3CryptoProfile,
    /// Declared content codec.
    pub codec: CodecTransform,
    /// Declared extracted-content surface.
    pub surface: KirikiriXp3Surface,
    /// The secret requirement id (never raw key material).
    pub secret_requirement_id: String,
    /// The structured secret ref the decrypt key was resolved through.
    pub secret_ref: SecretRef,
    /// One-way sha-256 commitment to the key bytes (never the key).
    pub key_material_hash: ProofHash,
    /// Key byte length (disclosed; the bytes are not).
    pub key_bytes: u32,
    /// Key material kind.
    pub key_material_kind: KeyMaterialKind,
    /// Redaction posture.
    pub redaction_status: HelperRedactionStatus,
    /// sha-256 commitment to the encrypted container bytes (which archive was
    /// decrypted).
    pub container_hash: ProofHash,
    /// The decrypt/extract manifest (hash-based).
    pub manifest: Vec<Xp3CryptMemberDigest>,
    /// The valid-key decrypt proof (method + hash over the manifest).
    pub decrypt_proof: KeyValidationProof,
    /// Wrong-key probe outcome.
    pub wrong_key: Xp3CryptWrongKeyReport,
    /// Missing-key probe outcome.
    pub missing_key: Xp3CryptMissingKeyReport,
    /// Overall status.
    pub status: OperationStatus,
}

impl Xp3CryptReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            capability_id: redact_for_log_or_report(&self.capability_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            container: redact_for_log_or_report(&self.container),
            crypto_profile: self.crypto_profile,
            codec: self.codec,
            surface: self.surface,
            secret_requirement_id: redact_for_log_or_report(&self.secret_requirement_id),
            secret_ref: self.secret_ref.clone(),
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            key_material_kind: self.key_material_kind,
            redaction_status: self.redaction_status,
            container_hash: self.container_hash.clone(),
            manifest: self
                .manifest
                .iter()
                .map(Xp3CryptMemberDigest::redacted_for_report)
                .collect(),
            decrypt_proof: self.decrypt_proof.clone(),
            wrong_key: Xp3CryptWrongKeyReport {
                attempted_secret_ref: self.wrong_key.attempted_secret_ref.clone(),
                typed_error: self.wrong_key.typed_error,
                diagnostic_code: redact_for_log_or_report(&self.wrong_key.diagnostic_code),
                member_id: self
                    .wrong_key
                    .member_id
                    .as_deref()
                    .map(redact_for_log_or_report),
            },
            missing_key: Xp3CryptMissingKeyReport {
                attempted_requirement_id: redact_for_log_or_report(
                    &self.missing_key.attempted_requirement_id,
                ),
                typed_error: self.missing_key.typed_error,
                diagnostic_code: redact_for_log_or_report(&self.missing_key.diagnostic_code),
            },
            status: self.status.clone(),
        }
    }

    /// Stable, redacted JSON for committing as proof (no raw key, no plaintext).
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

// --- Driver -----------------------------------------------------------------

/// Build a hash-based member digest from a member id + its decrypted plaintext.
/// Shared by the decrypt manifest and the KAIFUU-101 patch-back verification.
pub(crate) fn member_digest_from_plaintext(
    member_id: &str,
    plaintext: &[u8],
) -> Result<Xp3CryptMemberDigest, Xp3CryptError> {
    Ok(Xp3CryptMemberDigest {
        member_id: member_id.to_string(),
        plaintext_byte_len: plaintext.len() as u64,
        plaintext_hash: ProofHash::new(sha256_hash_bytes(plaintext))
            .map_err(|message| Xp3CryptError::Internal { message })?,
        adler32: format!("adler32:{:08x}", compute_adler32(plaintext)),
    })
}

/// Resolve the fixture's container bytes in-process.
pub(crate) fn resolve_container_bytes(
    source: &Xp3CryptContainerSource,
    fixture_dir: &Path,
) -> Result<Vec<u8>, Xp3CryptError> {
    match source {
        Xp3CryptContainerSource::SyntheticStub => Ok(build_synthetic_crypt_xp3()),
        Xp3CryptContainerSource::LocalFile { path } => std::fs::read(fixture_dir.join(path))
            .map_err(|error| Xp3CryptError::ContainerRead {
                detail: format!("read local crypt XP3: {error}"),
            }),
    }
}

/// Run the full XP3-crypt smoke from a fixture manifest: resolve the container,
/// resolve the valid secret ref → key, decrypt + extract + verify integrity,
/// then prove the wrong-key and missing-key failure modes are typed errors.
/// Returns a redactable report.
pub fn run_xp3_crypt_smoke_from_fixture(
    fixture: &Xp3CryptFixture,
    fixture_dir: &Path,
) -> Result<Xp3CryptReport, Xp3CryptError> {
    // Declared field sanity: the fixture must match this profile's engine /
    // container, or it is not a valid input for this smoke.
    if fixture.engine_family != XP3_CRYPT_ENGINE_FAMILY {
        return Err(Xp3CryptError::ExpectationMismatch {
            detail: format!(
                "engine_family {} is not {XP3_CRYPT_ENGINE_FAMILY}",
                fixture.engine_family
            ),
        });
    }
    if fixture.container != XP3_CRYPT_CONTAINER {
        return Err(Xp3CryptError::ExpectationMismatch {
            detail: format!(
                "container {} is not {XP3_CRYPT_CONTAINER}",
                fixture.container
            ),
        });
    }

    let container = resolve_container_bytes(&fixture.container_source, fixture_dir)?;
    let container_hash = ProofHash::new(sha256_hash_bytes(&container))
        .map_err(|message| Xp3CryptError::Internal { message })?;

    let resolver = FixtureSecretResolver::fixture_default();

    // The crypt scheme is DATA: the declared profile selects the byte transform.
    let scheme = fixture.crypto_profile.scheme();

    // (1) Valid secret ref → key → decrypt + extract + verify integrity.
    let key = resolver.resolve(&fixture.secret_requirement_id, &fixture.secret_ref)?;
    let manifest = decrypt_and_extract(&container, key, scheme)?;

    // Declared expectation: the decrypted member set matches.
    let extracted_ids: Vec<&str> = manifest
        .members
        .iter()
        .map(|member| member.member_id.as_str())
        .collect();
    if extracted_ids != fixture.expected_member_ids {
        return Err(Xp3CryptError::ExpectationMismatch {
            detail: "extracted member set did not match declared expected_member_ids".to_string(),
        });
    }

    // (2) Wrong-key probe: a resolvable-but-wrong ref must trip the integrity
    //     check with a typed error citing the first member.
    let wrong_ref = SecretRef::new(XP3_CRYPT_WRONG_SECRET_REF)
        .map_err(|message| Xp3CryptError::Internal { message })?;
    let wrong_key = resolver.resolve(&fixture.secret_requirement_id, &wrong_ref)?;
    let wrong_key_report = match decrypt_and_extract(&container, wrong_key, scheme) {
        Err(Xp3CryptError::IntegrityCheckFailed { member_id }) => Xp3CryptWrongKeyReport {
            attempted_secret_ref: wrong_ref,
            typed_error: true,
            diagnostic_code: format!("{XP3_CRYPT_MARKER}.integrity_check_failed"),
            member_id: Some(member_id),
        },
        Err(other) => {
            return Err(Xp3CryptError::ExpectationMismatch {
                detail: format!("wrong key produced the wrong error: {other}"),
            });
        }
        Ok(_) => {
            return Err(Xp3CryptError::ExpectationMismatch {
                detail: "wrong key was silently accepted".to_string(),
            });
        }
    };

    // (3) Missing-key probe: an unknown ref must fail resolution with a typed
    //     error, before any decrypt.
    let missing_ref = SecretRef::new(XP3_CRYPT_MISSING_SECRET_REF)
        .map_err(|message| Xp3CryptError::Internal { message })?;
    let missing_key_report = match resolver.resolve(&fixture.secret_requirement_id, &missing_ref) {
        Err(Xp3CryptError::MissingSecret { requirement_id, .. }) => Xp3CryptMissingKeyReport {
            attempted_requirement_id: requirement_id,
            typed_error: true,
            diagnostic_code: format!("{XP3_CRYPT_MARKER}.missing_secret"),
        },
        Err(other) => {
            return Err(Xp3CryptError::ExpectationMismatch {
                detail: format!("missing key produced the wrong error: {other}"),
            });
        }
        Ok(_) => {
            return Err(Xp3CryptError::ExpectationMismatch {
                detail: "missing key ref resolved to material".to_string(),
            });
        }
    };

    // (4) Assemble the report (counts + one-way commitments only).
    let manifest_digests: Vec<Xp3CryptMemberDigest> = manifest
        .members
        .iter()
        .map(|member| Xp3CryptMemberDigest {
            member_id: member.member_id.clone(),
            plaintext_byte_len: member.plaintext_byte_len,
            plaintext_hash: member.plaintext_hash.clone(),
            adler32: member.adler32.clone(),
        })
        .collect();

    // decrypt proof: a hash over the concatenated member plaintext commitments
    // (proves the decrypt produced this exact manifest).
    let mut proof_material = Vec::new();
    for member in &manifest.members {
        proof_material.extend_from_slice(member.member_id.as_bytes());
        proof_material.extend_from_slice(member.plaintext_hash.as_str().as_bytes());
    }
    let decrypt_proof = KeyValidationProof {
        method: KeyValidationMethod::DecryptHeaderProof,
        proof_hash: ProofHash::new(sha256_hash_bytes(&proof_material))
            .map_err(|message| Xp3CryptError::Internal { message })?,
    };

    let report = Xp3CryptReport {
        schema_version: XP3_CRYPT_SCHEMA_VERSION.to_string(),
        capability_id: XP3_CRYPT_CAPABILITY_ID.to_string(),
        source_node_id: fixture.source_node_id.clone(),
        support_boundary: XP3_CRYPT_SUPPORT_BOUNDARY.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        engine_family: fixture.engine_family.clone(),
        container: fixture.container.clone(),
        crypto_profile: fixture.crypto_profile,
        codec: fixture.codec,
        surface: fixture.surface,
        secret_requirement_id: fixture.secret_requirement_id.clone(),
        secret_ref: fixture.secret_ref.clone(),
        key_material_hash: key.material_hash()?,
        key_bytes: u32::try_from(key.byte_len()).unwrap_or(u32::MAX),
        key_material_kind: KeyMaterialKind::FixedBytes,
        redaction_status: HelperRedactionStatus::Redacted,
        container_hash,
        manifest: manifest_digests,
        decrypt_proof,
        wrong_key: wrong_key_report,
        missing_key: missing_key_report,
        status: OperationStatus::Passed,
    };

    // Runtime no-leak guard: the serialized (redacted) report must never carry
    // the raw key material. This is a hard refusal, not just a test-time check.
    let json = report
        .stable_json()
        .map_err(|error| Xp3CryptError::Internal {
            message: error.to_string(),
        })?;
    if key.appears_in(json.as_bytes()) || wrong_key.appears_in(json.as_bytes()) {
        return Err(Xp3CryptError::Internal {
            message: "refusing to emit a report that leaks raw key material".to_string(),
        });
    }

    Ok(report)
}

/// Convenience wrapper: read the fixture JSON at `fixture_path` and run the
/// smoke against the fixture's directory.
pub fn run_xp3_crypt_smoke_from_path(fixture_path: &Path) -> Result<Xp3CryptReport, Xp3CryptError> {
    let fixture: Xp3CryptFixture =
        read_json(fixture_path).map_err(|error| Xp3CryptError::Internal {
            message: error.to_string(),
        })?;
    let fixture_dir = fixture_path
        .parent()
        .ok_or_else(|| Xp3CryptError::Internal {
            message: "fixture path must have a parent directory".to_string(),
        })?;
    run_xp3_crypt_smoke_from_fixture(&fixture, fixture_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_fixture() -> Xp3CryptFixture {
        Xp3CryptFixture {
            schema_version: XP3_CRYPT_SCHEMA_VERSION.to_string(),
            fixture_id: "kirikiri-xp3-crypt-smoke-fixture".to_string(),
            source_node_id: "KAIFUU-100".to_string(),
            engine_family: XP3_CRYPT_ENGINE_FAMILY.to_string(),
            container: XP3_CRYPT_CONTAINER.to_string(),
            crypto_profile: Xp3CryptoProfile::XorSimpleCryptFixture,
            codec: CodecTransform::ShiftJisText,
            surface: KirikiriXp3Surface::ScenarioScript,
            secret_requirement_id: XP3_CRYPT_REQUIREMENT_ID.to_string(),
            secret_ref: SecretRef::new(XP3_CRYPT_VALID_SECRET_REF).unwrap(),
            container_source: Xp3CryptContainerSource::SyntheticStub,
            expected_member_ids: vec![
                "scenario/intro.ks".to_string(),
                "system/config.txt".to_string(),
            ],
        }
    }

    #[test]
    fn synthetic_crypt_xp3_payload_is_not_plaintext() {
        // The committed/produced container must carry ciphertext, not the
        // authored plaintext (proves it is genuinely enciphered).
        let container = build_synthetic_crypt_xp3();
        for (_, text) in FIXTURE_MEMBERS {
            assert!(
                !windows_contains(&container, text.as_bytes()),
                "member plaintext leaked into the encrypted container"
            );
        }
    }

    #[test]
    fn filter_is_its_own_inverse() {
        let secret_ref = SecretRef::new(XP3_CRYPT_VALID_SECRET_REF).unwrap();
        let key = module_private_fixture_secret_holder(&secret_ref, SYNTHETIC_FIXTURE_KEY.to_vec());
        let plaintext = b"the quick brown fox\x00\x01\xff";
        for profile in [
            Xp3CryptoProfile::XorSimpleCryptFixture,
            Xp3CryptoProfile::XorPositionCryptFixture,
        ] {
            let scheme = profile.scheme();
            let cipher = key.apply_filter(scheme, plaintext);
            assert_ne!(cipher, plaintext);
            assert_eq!(key.apply_filter(scheme, &cipher), plaintext);
        }
    }

    #[test]
    fn distinct_profiles_produce_distinct_ciphertext() {
        // Two profiled crypt schemes, same key → different ciphertext. Proves the
        // scheme is genuinely data-driven, not a single hard-coded transform.
        let secret_ref = SecretRef::new(XP3_CRYPT_VALID_SECRET_REF).unwrap();
        let key = module_private_fixture_secret_holder(&secret_ref, SYNTHETIC_FIXTURE_KEY.to_vec());
        let plaintext = b"synthetic-kirikiri-profiled-crypt-sample-0123456789";
        let simple = key.apply_filter(Xp3CryptoProfile::XorSimpleCryptFixture.scheme(), plaintext);
        let position = key.apply_filter(
            Xp3CryptoProfile::XorPositionCryptFixture.scheme(),
            plaintext,
        );
        assert_ne!(simple, position);
    }

    #[test]
    fn valid_secret_ref_decrypts_and_extracts() {
        let fixture = synthetic_fixture();
        let report =
            run_xp3_crypt_smoke_from_fixture(&fixture, Path::new(".")).expect("smoke runs");
        assert_eq!(report.status, OperationStatus::Passed);
        assert_eq!(report.manifest.len(), FIXTURE_MEMBERS.len());
        assert_eq!(report.manifest[0].member_id, "scenario/intro.ks");
        // The manifest is hash-based: byte length + hash + adler, no text.
        assert_eq!(
            report.manifest[0].plaintext_byte_len as usize,
            FIXTURE_MEMBERS[0].1.len()
        );
        assert_eq!(
            report.manifest[0].plaintext_hash.as_str(),
            sha256_hash_bytes(FIXTURE_MEMBERS[0].1.as_bytes())
        );
    }

    #[test]
    fn wrong_secret_ref_is_typed_integrity_failure() {
        let container = build_synthetic_crypt_xp3();
        let resolver = FixtureSecretResolver::fixture_default();
        let wrong_ref = SecretRef::new(XP3_CRYPT_WRONG_SECRET_REF).unwrap();
        let wrong_key = resolver
            .resolve(XP3_CRYPT_REQUIREMENT_ID, &wrong_ref)
            .expect("wrong ref resolves to (wrong) material");
        let err = decrypt_and_extract(
            &container,
            wrong_key,
            Xp3CryptoProfile::XorSimpleCryptFixture.scheme(),
        )
        .expect_err("wrong key must fail integrity, not silently pass");
        assert!(matches!(err, Xp3CryptError::IntegrityCheckFailed { .. }));
        assert!(err.to_string().starts_with(XP3_CRYPT_MARKER));
    }

    #[test]
    fn missing_secret_ref_is_typed_resolution_failure() {
        let resolver = FixtureSecretResolver::fixture_default();
        let missing_ref = SecretRef::new(XP3_CRYPT_MISSING_SECRET_REF).unwrap();
        let err = resolver
            .resolve(XP3_CRYPT_REQUIREMENT_ID, &missing_ref)
            .expect_err("unknown ref must be a typed error, not a panic/skip");
        match err {
            Xp3CryptError::MissingSecret { requirement_id, .. } => {
                assert_eq!(requirement_id, XP3_CRYPT_REQUIREMENT_ID);
            }
            other => panic!("expected MissingSecret, got {other}"),
        }
    }

    #[test]
    fn report_carries_no_raw_key_and_no_plaintext() {
        let fixture = synthetic_fixture();
        let report =
            run_xp3_crypt_smoke_from_fixture(&fixture, Path::new(".")).expect("smoke runs");
        assert!(report.wrong_key.typed_error);
        assert!(report.missing_key.typed_error);

        let json = report.stable_json().expect("stable json");
        // Raw key material never appears (correct or wrong).
        assert!(!json.contains(&String::from_utf8_lossy(SYNTHETIC_FIXTURE_KEY).into_owned()));
        assert!(!json.contains(&String::from_utf8_lossy(SYNTHETIC_WRONG_KEY).into_owned()));
        // Decrypted plaintext never appears — only its hash.
        for (_, text) in FIXTURE_MEMBERS {
            assert!(!json.contains(text));
        }
        // The requirement id + secret ref (safe) are disclosed; the key bytes
        // are not — only the length + one-way hash.
        assert_eq!(report.key_bytes as usize, SYNTHETIC_FIXTURE_KEY.len());
        assert_eq!(
            report.key_material_hash.as_str(),
            sha256_hash_bytes(SYNTHETIC_FIXTURE_KEY)
        );
    }

    #[test]
    fn key_is_redacted_and_zeroized_in_debug() {
        let secret_ref = SecretRef::new(XP3_CRYPT_VALID_SECRET_REF).unwrap();
        let key = module_private_fixture_secret_holder(&secret_ref, SYNTHETIC_FIXTURE_KEY.to_vec());
        let rendered = format!("{key:?}");
        assert!(rendered.contains("REDACTED"));
        assert!(!rendered.contains(&String::from_utf8_lossy(SYNTHETIC_FIXTURE_KEY).into_owned()));
    }

    #[test]
    fn resolver_debug_never_emits_raw_key_bytes() {
        // P1(b): FixtureSecretResolver stores each key inside the zeroize-on-drop
        // Xp3CryptKey holder and has a manual redacting Debug. `format!("{:?}")`
        // (and pretty `{:#?}`) must never render either the correct or the wrong
        // fixture key, while the (safe) secret refs are still shown.
        let resolver = FixtureSecretResolver::fixture_default();
        for rendered in [format!("{resolver:?}"), format!("{resolver:#?}")] {
            assert!(
                !rendered.contains(&String::from_utf8_lossy(SYNTHETIC_FIXTURE_KEY).into_owned()),
                "resolver Debug leaked the correct key"
            );
            assert!(
                !rendered.contains(&String::from_utf8_lossy(SYNTHETIC_WRONG_KEY).into_owned()),
                "resolver Debug leaked the wrong key"
            );
            assert!(
                rendered.contains("REDACTED"),
                "resolver Debug should mark redaction"
            );
            // The reportable secret refs are safe to disclose.
            assert!(rendered.contains(XP3_CRYPT_VALID_SECRET_REF));
        }
    }

    #[test]
    fn no_leak_probe_detects_key_in_bytes() {
        // Sanity: the appears_in probe actually detects the key when present,
        // so the no-leak assertions are meaningful.
        let secret_ref = SecretRef::new(XP3_CRYPT_VALID_SECRET_REF).unwrap();
        let key = module_private_fixture_secret_holder(&secret_ref, SYNTHETIC_FIXTURE_KEY.to_vec());
        let mut haystack = b"prefix".to_vec();
        haystack.extend_from_slice(SYNTHETIC_FIXTURE_KEY);
        assert!(key.appears_in(&haystack));
        assert!(!key.appears_in(b"no key here"));
    }

    fn windows_contains(haystack: &[u8], needle: &[u8]) -> bool {
        if needle.is_empty() || needle.len() > haystack.len() {
            return false;
        }
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }
}
