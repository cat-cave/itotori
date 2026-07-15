//! Pure-Rust **TyranoScript `.ks` scenario-script** text-extraction and
//! byte-preserving patch adapter, expressed as a **layered pipeline**:
//! | stage | transform | why |
//! | container | `identity` | `.ks` files sit loose on disk under `data/scenario/` — no archive to unpack. |
//! | crypto | `null_key` | TyranoScript scenarios are **plaintext** (UTF-8 / Shift-JIS) — no cipher. |
//! | codec | `tyrano_script_markup`| the KAG-style square-bracket markup dialect ([`parse`] / [`patch`]). |
//! This mirrors the KiriKiri KAG plaintext adapter's *shape* (stable
//! extraction units + byte-preserving splice-back) but is implemented
//! **independently** for the TyranoScript markup dialect — it does not depend
//! on the KiriKiri plaintext code. TyranoScript is a JavaScript VN engine;
//! only the scenario **text** (dialogue + choice/link captions + speaker
//! names) is translatable, while all structure (tags, labels, jumps,
//! variables) is preserved byte-for-byte.
//! # What it does
//! - [`parse_ks`] parses the TyranoScript `.ks` dialect (comments `;`, labels
//!   `*`, `@`-line-commands, `#name` speaker lines, inline `[tag …]` tags,
//!   `[link]…[endlink]` / `[glink]` / `[button]` choices, `[chara_ptext]`
//!   speaker tags, `&expr` variable embeds, `[[` literal escapes) into stable
//!   [`TsUnit`]s. Encoding-aware (UTF-8 + Shift-JIS).
//! - [`apply_patch`] rewrites only the translatable spans (dialogue + choice +
//!   speaker text), byte-preserving all structure; [`verify_byte_preserving`]
//!   proves a patch touched nothing but translatable text.
//! # Layered-pipeline capability profile
//! The claim tuple for this adapter (`engineFamily=tyranoscript`,
//! `container=identity`, `crypto=null_key`, `codec=tyrano_script_markup`,
//! `patchBackMode=replace_file`, level `patch`) lives in
//! `kaifuu_core::compat_profile::fixtures::level_patch_tyranoscript`; see
//! [`layered_stack`] for the code-queryable token triple and
//! `docs/kaifuu-adapters/tyranoscript.md` for the capability doc.
//! # Determinism / no shell-outs
//! Pure in-process parsing; all identifiers are SHA-256-derived
//! (`bridge_unit_id` uses the shared UUID7-shaped scheme). No `Command::new`,
//! no network, no helper process. No copyrighted bytes: the fixture corpus is
//! synthetic, authored, CC0.

mod ids;
mod parse;
mod patch;

pub use parse::{
    TextRole, TsDocument, TsEncoding, TsFinding, TsFindingKind, TsUnit, parse_ks,
    parse_ks_with_encoding, structural_bytes,
};
pub use patch::{
    PatchError, VerifyError, apply_patch, source_structural_bytes, verify_byte_preserving,
};

/// Stable engine-family token for the TyranoScript adapter (matches
/// `kaifuu_core::compat_profile::CompatEngineFamily::TyranoScript`).
pub const ENGINE_FAMILY: &str = "tyranoscript";

/// The layered-pipeline transform triple `(container, crypto, codec)` as the
/// canonical snake_case tokens, queryable from code (not only prose docs).
#[must_use]
pub fn layered_stack() -> (&'static str, &'static str, &'static str) {
    ("identity", "null_key", "tyrano_script_markup")
}

/// One-line capability statement, embedded so the layered stack is queryable
/// from code, not only prose docs.
#[must_use]
pub fn capability_note() -> &'static str {
    "kaifuu-tyrano handles plaintext TyranoScript `.ks` scenario scripts via \
     the layered pipeline: identity container (loose files on disk), null-key \
     crypto (plaintext, no cipher), and the tyrano-script-markup codec. It \
     extracts dialogue + choice/link + speaker text and patches translations \
     back preserving all structure (tags, labels, jumps, variables)."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layered_stack_is_the_null_key_plaintext_floor() {
        assert_eq!(
            layered_stack(),
            ("identity", "null_key", "tyrano_script_markup")
        );
        assert_eq!(ENGINE_FAMILY, "tyranoscript");
    }

    #[test]
    fn capability_note_states_the_layered_stack() {
        let note = capability_note();
        assert!(note.contains("TyranoScript"));
        assert!(note.contains("identity container"));
        assert!(note.contains("null-key"));
        assert!(note.contains("tyrano-script-markup"));
    }
}
