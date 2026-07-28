//! one **profiled XP3 crypt** decrypt/extract fixture.
//! # What this is (and is not)
//! This module proves the **secret-ref decrypt path** for an encrypted KiriKiri
//! XP3 archive end-to-end, on a **synthetic, fixture-safe** archive:
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
//!    The raw key material only ever lives inside the module-private,
//!    zeroize-on-drop, `Debug`-redacting [`Xp3CryptKey`]. The fixture and report
//!    carry only the **secret requirement id + [`SecretRef`] + one-way sha-256
//!    commitments + counts** — never the raw key.
//! ## Honest scope (assumed vs. verified)
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
//!   No retail bytes, no real key material: the members are clearly-synthetic
//!   authored text and the key is an obviously-fake fixture constant.

#[cfg(test)]
#[path = "xp3_crypt_tests.rs"]
mod tests;
include!("xp3_crypt_parts/001.rs");
include!("xp3_crypt_parts/002.rs");
include!("xp3_crypt_parts/003.rs");
