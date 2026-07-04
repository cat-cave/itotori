//! Byte-level encoding detection + whole-script decode for a KAG `.ks`
//! plaintext scenario file.
//!
//! This crate OWNS its encoding handling rather than importing
//! `kaifuu-kirikiri`'s (which is a dev-dependency oracle only, per the
//! crate-level regression-isolation posture). The two implementations
//! recognise the *same* two encodings — a deliberate parallel that the
//! text+name cross-validation test proves agrees on real parse output.
//!
//! ## Why decode-first dissolves the delimiter hazard
//!
//! KAIFUU-009's byte-level parser must guard against a Shift-JIS trailing
//! byte that happens to equal an ASCII delimiter (`[`=0x5B, `]`=0x5D,
//! `@`=0x40, `#`=0x23, `*`=0x2A all fall inside the Shift-JIS trailing-byte
//! range 0x40..=0x7E). The replay parser sidesteps that hazard entirely by
//! decoding the whole file to a Rust `String` up front: after decoding,
//! every character is a proper Unicode scalar, so scanning the decoded
//! `&str` for ASCII delimiters via `char_indices` can never mis-read a
//! multi-byte character's interior. Byte-preserving patchback (which *does*
//! need byte spans) is KAIFUU-009's job, not the replay's.

use serde::Serialize;

/// Byte-level text encoding of a `.ks` file. Mirrors
/// `kaifuu_kirikiri::KsEncoding`'s two variants (kept as a separate type so
/// this crate carries no production dependency on `kaifuu-kirikiri`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KagEncoding {
    /// UTF-8 (modern KiriKiriZ scripts, and every authored fixture here).
    Utf8,
    /// Shift-JIS (classic KiriKiri retail scripts).
    ShiftJis,
}

impl KagEncoding {
    /// Detect encoding: valid UTF-8 → [`KagEncoding::Utf8`], else
    /// [`KagEncoding::ShiftJis`]. Same policy KAIFUU-009 uses so the two
    /// parsers classify a given `.ks` file identically.
    #[must_use]
    pub fn detect(bytes: &[u8]) -> Self {
        if std::str::from_utf8(bytes).is_ok() {
            Self::Utf8
        } else {
            Self::ShiftJis
        }
    }

    /// Decode `bytes` under this encoding (lossy on invalid input; authored
    /// fixtures are always clean).
    #[must_use]
    pub fn decode(self, bytes: &[u8]) -> String {
        let coder = match self {
            Self::Utf8 => encoding_rs::UTF_8,
            Self::ShiftJis => encoding_rs::SHIFT_JIS,
        };
        coder.decode(bytes).0.into_owned()
    }

    /// Short stable label for the trace surface.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Utf8 => "utf8",
            Self::ShiftJis => "shift_jis",
        }
    }
}
