//! Translation-scope configuration.
//!
//! itotori translates as MUCH of a game as the USER CONFIGURES. The
//! translation scope is the config that drives the patchback byte-fidelity
//! contract: everything OUTSIDE the chosen scope is carried byte-identical;
//! everything INSIDE round-trips byte-correctly (decompress → [xor_2] →
//! splice → re-emit).
//!
//! The scope is a per-run config the caller declares — it is NOT a hard-coded
//! "only dialogue Textout may change" rule. `DialogueOnly` reproduces the
//! conservative dialogue-only behaviour (choices, UI, images all carried
//! byte-identical); `DialogueAndChoices` additionally makes `module_sel`
//! choice options translatable (re-encoded NextString-safe).
//!
//! Alpha covers these two variants (dialogue + choices). UI-string and image
//! scopes are beta surfaces: they are added as new variants when those
//! surfaces are cataloged and exercised on real bytes — never speculatively.

use serde::{Deserialize, Serialize};

/// Which translation surfaces the user configured to translate.
///
/// Drives the config-driven byte-fidelity contract in
/// [`crate::apply_translated_bundle`]: a v0.2 unit whose `surfaceKind` is
/// in scope may change (round-tripping byte-correctly through the patchback
/// pipeline); every out-of-scope surface is carried byte-identical.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TranslationScope {
    /// Translate only `dialogue` (Textout) units. Every non-dialogue
    /// surface — RealLive `choice_label` / `module_sel` options, binary data
    /// tables, opcode headers — is carried byte-identical. The
    /// `module_sel` Choice command's `NextString` tokens are never touched.
    DialogueOnly,
    /// Translate `dialogue` units AND `choice_label` (`module_sel` select)
    /// options. Choice options are re-encoded NextString-safe
    /// ([`crate::opcode::encode_choice_option_next_string_safe`]) so a
    /// translated option carrying tricky bytes (`[`, `!`, quotes, …) cannot
    /// corrupt the select-command structure or its `NextString` token.
    DialogueAndChoices,
}

impl TranslationScope {
    /// `true` if a v0.2 unit of `surface_kind` is IN scope (writable) under
    /// this configuration. An out-of-scope surface kind is carried
    /// byte-identical by the patchback.
    pub fn includes_surface_kind(self, surface_kind: &str) -> bool {
        match self {
            Self::DialogueOnly => surface_kind == "dialogue",
            Self::DialogueAndChoices => matches!(surface_kind, "dialogue" | "choice_label"),
        }
    }

    /// Parse a scope token (CLI `--scope` value / config field). Accepts
    /// `dialogue-only` and `dialogue+choices` (the canonical spelling); the
    /// serde alias `dialogue-and-choices` is also accepted for the latter.
    pub fn parse_token(token: &str) -> Option<Self> {
        match token {
            "dialogue-only" => Some(Self::DialogueOnly),
            "dialogue+choices" | "dialogue-and-choices" => Some(Self::DialogueAndChoices),
            _ => None,
        }
    }

    /// The canonical token for this scope (round-trips through
    /// [`TranslationScope::parse_token`]).
    pub fn as_token(self) -> &'static str {
        match self {
            Self::DialogueOnly => "dialogue-only",
            Self::DialogueAndChoices => "dialogue+choices",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialogue_only_scopes_out_choice_labels() {
        let scope = TranslationScope::DialogueOnly;
        assert!(scope.includes_surface_kind("dialogue"));
        assert!(!scope.includes_surface_kind("choice_label"));
    }

    #[test]
    fn dialogue_and_choices_includes_both() {
        let scope = TranslationScope::DialogueAndChoices;
        assert!(scope.includes_surface_kind("dialogue"));
        assert!(scope.includes_surface_kind("choice_label"));
        // A future UI surface is still out of scope until a variant exists.
        assert!(!scope.includes_surface_kind("ui_string"));
    }

    #[test]
    fn token_round_trips() {
        for scope in [
            TranslationScope::DialogueOnly,
            TranslationScope::DialogueAndChoices,
        ] {
            assert_eq!(TranslationScope::parse_token(scope.as_token()), Some(scope));
        }
        assert_eq!(
            TranslationScope::parse_token("dialogue-and-choices"),
            Some(TranslationScope::DialogueAndChoices)
        );
        assert_eq!(TranslationScope::parse_token("images"), None);
    }
}
