//! `Gameexe.dat` → UTF-16LE key/value inventory.
//! Siglus stores its configuration/name tables in `Gameexe.dat`. The container
//! is an 8-byte outer header (`[i32 version][i32 exe_angou_mode]`) followed by a
//! body that is:
//! ```text
//! body -> [exe-angou 16-byte key XOR?] -> constant-256 Gameexe XOR
//!      -> [u32 arc_size][u32 org_size] -> Siglus LZSS -> UTF-16LE Gameexe.ini
//! ```
//! The constant 256-byte mask is the engine-wide
//! [`crate::decrypt::SIGLUS_GAMEEXE_XOR_TABLE`] (distinct from the scene table),
//! confirmed present verbatim in both owned titles' real `SiglusEngine.exe`.
//! # Semantic gating (before any output)
//! When `exe_angou_mode != 0` the body is additionally masked with the per-game
//! **exe-angou key** — the key-discovery layer's deliverable, recovered from the
//! packed `SiglusEngine` executable and consumed here only as resolved material
//! bound to a structured secret-ref, never a raw literal. Key presence and the
//! header flag must agree, and the decrypted `arc_size` must equal the body
//! length; both checks fire before any decompressed byte is produced. A
//! missing/spurious key or a wrong cipher (garbage size header) is a typed
//! diagnostic, never a partial or silent output.
//! # Real-title status
//! Both owned titles (`karetoshi`, `gamekoi`) set `exe_angou_mode = 1`; until
//! their exe-angou key is available in-process, [`decode_gameexe_dat`] records
//! the typed `exe_angou_key_required` diagnostic before any output rather than
//! fabricating an inventory.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::decompress::{SiglusDecompressError, decompress_siglus_lzss};
use crate::decrypt::{SiglusSecondLayerMaterial, apply_gameexe_xor_table};

/// Byte length of the outer `Gameexe.dat` header (`[i32 version][i32 mode]`).
const GAMEEXE_HEADER_LEN: usize = 8;
/// Byte length of the inner LZSS size header (`[u32 arc_size][u32 org_size]`).
const LZSS_SIZE_HEADER_LEN: usize = 8;

/// The outer `Gameexe.dat` header.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeDatHeader {
    /// Container format version (`0` for the classic headered layout).
    pub version: i32,
    /// When non-zero, the body is masked with the per-game exe-angou key in
    /// addition to the constant `Gameexe.dat` table.
    pub exe_angou_mode: i32,
}

/// A single parsed `Gameexe.dat` key/value entry (UTF-16LE-decoded to a
/// UTF-8 [`String`] at the boundary).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeDatEntry {
    /// Configuration key (e.g. a `#NAMAE`-family speaker-table key), with the
    /// leading `#`/`.` sigil stripped and surrounding whitespace trimmed.
    pub key: String,
    /// Raw value text (UTF-16LE-decoded), preserved verbatim after trimming.
    pub value: String,
}

/// Parsed `Gameexe.dat` inventory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeDatReport {
    pub entries: Vec<GameexeDatEntry>,
}

/// Fatal errors raised by the `Gameexe.dat` reader.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GameexeDatError {
    /// The blob is shorter than the fixed 8-byte outer header.
    #[error(
        "kaifuu.siglus.gameexe.truncated_header: Gameexe.dat length {observed_len} is shorter \
         than the {GAMEEXE_HEADER_LEN}-byte outer header"
    )]
    TruncatedHeader { observed_len: usize },
    /// `exe_angou_mode` is set but no exe-angou key material was supplied. The
    /// per-game key is the key-discovery layer's deliverable; without it the
    /// body cannot decode.
    #[error(
        "kaifuu.siglus.gameexe.exe_angou_key_required: Gameexe.dat body is masked with the \
         per-game exe-angou key (exe_angou_mode={exe_angou_mode}) but no resolved key material \
         was supplied"
    )]
    ExeAngouKeyRequired { exe_angou_mode: i32 },
    /// Key material was supplied but `exe_angou_mode` is clear.
    #[error(
        "kaifuu.siglus.gameexe.exe_angou_key_unexpected: Gameexe.dat body is not exe-angou \
         masked (exe_angou_mode=0) but exe-angou key material was supplied"
    )]
    ExeAngouKeyUnexpected,
    /// The body is shorter than the fixed 8-byte inner LZSS size header.
    #[error(
        "kaifuu.siglus.gameexe.truncated_body: Gameexe.dat body length {observed_len} is shorter \
         than the {LZSS_SIZE_HEADER_LEN}-byte LZSS size header"
    )]
    TruncatedBody { observed_len: usize },
    /// The decrypted `arc_size` field does not equal the body length — the
    /// tell-tale of a wrong constant table or wrong/absent exe-angou key.
    #[error(
        "kaifuu.siglus.gameexe.arc_size_mismatch: decrypted arc_size {declared} != body length \
         {actual} (wrong key or cipher method)"
    )]
    ArcSizeMismatch { declared: u32, actual: usize },
    /// LZSS decompression failed after a valid header.
    #[error("kaifuu.siglus.gameexe.decompress: {source}")]
    Decompress {
        #[source]
        source: SiglusDecompressError,
    },
    /// The decompressed plaintext was not valid UTF-16LE.
    #[error(
        "kaifuu.siglus.gameexe.invalid_utf16le: Gameexe.dat plaintext (decompressed length \
         {decompressed_len}) is not valid UTF-16LE"
    )]
    InvalidUtf16Le { decompressed_len: usize },
}

/// Read the outer `Gameexe.dat` header (`[i32 version][i32 exe_angou_mode]`).
pub fn read_gameexe_header(raw: &[u8]) -> Result<GameexeDatHeader, GameexeDatError> {
    if raw.len() < GAMEEXE_HEADER_LEN {
        return Err(GameexeDatError::TruncatedHeader {
            observed_len: raw.len(),
        });
    }
    Ok(GameexeDatHeader {
        version: i32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]),
        exe_angou_mode: i32::from_le_bytes([raw[4], raw[5], raw[6], raw[7]]),
    })
}

/// Decode a `Gameexe.dat` blob into a key/value inventory.
/// `raw` is the on-disk container (outer header + body). `exe_key` is the
/// resolved per-game exe-angou key material (or `None`). All gating happens
/// before any decompressed byte is produced.
pub fn decode_gameexe_dat(
    raw: &[u8],
    exe_key: Option<&SiglusSecondLayerMaterial>,
) -> Result<GameexeDatReport, GameexeDatError> {
    let header = read_gameexe_header(raw)?;

    match (header.exe_angou_mode != 0, exe_key.is_some()) {
        (true, false) => {
            return Err(GameexeDatError::ExeAngouKeyRequired {
                exe_angou_mode: header.exe_angou_mode,
            });
        }
        (false, true) => return Err(GameexeDatError::ExeAngouKeyUnexpected),
        _ => {}
    }

    let body = &raw[GAMEEXE_HEADER_LEN..];
    if body.len() < LZSS_SIZE_HEADER_LEN {
        return Err(GameexeDatError::TruncatedBody {
            observed_len: body.len(),
        });
    }

    let decrypted = apply_gameexe_xor_table(body, exe_key);
    let arc_size = u32::from_le_bytes([decrypted[0], decrypted[1], decrypted[2], decrypted[3]]);
    let org_size =
        u32::from_le_bytes([decrypted[4], decrypted[5], decrypted[6], decrypted[7]]) as usize;

    // The engine stores the whole body length in arc_size. A mismatch means the
    // cipher/key is wrong — reject before decompressing.
    if arc_size as usize != body.len() {
        return Err(GameexeDatError::ArcSizeMismatch {
            declared: arc_size,
            actual: body.len(),
        });
    }

    let plaintext = decompress_siglus_lzss(&decrypted[LZSS_SIZE_HEADER_LEN..], org_size)
        .map_err(|source| GameexeDatError::Decompress { source })?;
    let text = decode_utf16le(&plaintext)?;
    Ok(GameexeDatReport {
        entries: parse_ini_entries(&text),
    })
}

/// Decode UTF-16LE bytes (optional leading BOM) into a [`String`].
fn decode_utf16le(bytes: &[u8]) -> Result<String, GameexeDatError> {
    let (decoded, _, had_errors) = encoding_rs::UTF_16LE.decode(bytes);
    if had_errors {
        return Err(GameexeDatError::InvalidUtf16Le {
            decompressed_len: bytes.len(),
        });
    }
    Ok(decoded.into_owned())
}

/// Parse decoded Gameexe.ini text into key/value entries. Blank lines and `;`
/// comments are skipped; a leading `#` sigil is stripped from keys.
fn parse_ini_entries(text: &str) -> Vec<GameexeDatEntry> {
    let mut entries = Vec::new();
    for raw_line in text.lines() {
        let mut line = raw_line.trim();
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        if let Some(rest) = line.strip_prefix('\u{feff}') {
            line = rest.trim_start();
        }
        if let Some(rest) = line.strip_prefix('#') {
            line = rest.trim_start();
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        entries.push(GameexeDatEntry {
            key: key.to_string(),
            value: value.trim().to_string(),
        });
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decrypt::{SiglusSecondLayerKey, apply_gameexe_xor_table};

    /// Hand-build one `Gameexe.dat`: outer header + constant/exe-key-masked
    /// LZSS-compressed UTF-16LE INI text. Exercises the codec end to end (this
    /// is a codec round-trip on constructed bytes, not a real-title proof).
    fn build_gameexe_dat(
        ini: &str,
        exe_angou_mode: i32,
        exe_key: Option<&SiglusSecondLayerMaterial>,
    ) -> Vec<u8> {
        // UTF-16LE encode.
        let mut utf16 = Vec::new();
        for unit in ini.encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        // All-literal LZSS: one flag byte (bits set) per <=8 literals.
        let mut stream = Vec::new();
        for group in utf16.chunks(8) {
            stream.push(((1u16 << group.len()) - 1) as u8);
            stream.extend_from_slice(group);
        }
        let mut plain = Vec::new();
        plain.extend_from_slice(&0u32.to_le_bytes()); // arc_size placeholder
        plain.extend_from_slice(&(utf16.len() as u32).to_le_bytes()); // org_size
        plain.extend_from_slice(&stream);
        let body_len = plain.len() as u32;
        plain[0..4].copy_from_slice(&body_len.to_le_bytes());
        // apply_gameexe_xor_table is its own inverse.
        let body = apply_gameexe_xor_table(&plain, exe_key);
        let mut out = Vec::new();
        out.extend_from_slice(&0i32.to_le_bytes()); // version
        out.extend_from_slice(&exe_angou_mode.to_le_bytes());
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn header_reads_version_and_mode() {
        let dat = build_gameexe_dat("#A.B = 1\n", 1, None);
        let header = read_gameexe_header(&dat).unwrap();
        assert_eq!(header.version, 0);
        assert_eq!(header.exe_angou_mode, 1);
    }

    #[test]
    fn keyed_round_trip_recovers_inventory() {
        let key_ref = SiglusSecondLayerKey::from_secret_ref("secret://test/gameexe-key");
        let material = SiglusSecondLayerMaterial::resolve(&key_ref, vec![0x5Au8; 16]).unwrap();
        let ini = "#NAMAE.000 = \"Rin\"\n#WINDOW.SIZE = 1280, 720\n";
        let dat = build_gameexe_dat(ini, 1, Some(&material));
        let report = decode_gameexe_dat(&dat, Some(&material)).expect("keyed decode");
        assert_eq!(report.entries.len(), 2);
        assert_eq!(report.entries[0].key, "NAMAE.000");
        assert_eq!(report.entries[0].value, "\"Rin\"");
        assert_eq!(report.entries[1].key, "WINDOW.SIZE");
        assert_eq!(report.entries[1].value, "1280, 720");
    }

    #[test]
    fn unkeyed_round_trip_when_mode_clear() {
        let dat = build_gameexe_dat("#X.Y = z\n", 0, None);
        let report = decode_gameexe_dat(&dat, None).expect("unkeyed decode");
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].key, "X.Y");
    }

    #[test]
    fn missing_required_key_fails_before_output() {
        let key_ref = SiglusSecondLayerKey::from_secret_ref("secret://test/gameexe-key");
        let material = SiglusSecondLayerMaterial::resolve(&key_ref, vec![0x5Au8; 16]).unwrap();
        let dat = build_gameexe_dat("#A = 1\n", 1, Some(&material));
        let err = decode_gameexe_dat(&dat, None).expect_err("key required");
        assert_eq!(
            err,
            GameexeDatError::ExeAngouKeyRequired { exe_angou_mode: 1 }
        );
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
    }

    #[test]
    fn spurious_key_when_mode_clear_is_rejected() {
        let key_ref = SiglusSecondLayerKey::from_secret_ref("secret://test/gameexe-key");
        let material = SiglusSecondLayerMaterial::resolve(&key_ref, vec![0x5Au8; 16]).unwrap();
        let dat = build_gameexe_dat("#A = 1\n", 0, None);
        let err = decode_gameexe_dat(&dat, Some(&material)).expect_err("unexpected key");
        assert_eq!(err, GameexeDatError::ExeAngouKeyUnexpected);
    }

    #[test]
    fn wrong_key_trips_arc_size_guard_before_output() {
        let key_ref = SiglusSecondLayerKey::from_secret_ref("secret://test/gameexe-key");
        let right = SiglusSecondLayerMaterial::resolve(&key_ref, vec![0x5Au8; 16]).unwrap();
        let wrong = SiglusSecondLayerMaterial::resolve(&key_ref, vec![0x99u8; 16]).unwrap();
        let dat = build_gameexe_dat("#A.B = 1\n", 1, Some(&right));
        let err = decode_gameexe_dat(&dat, Some(&wrong)).expect_err("wrong key");
        assert!(matches!(err, GameexeDatError::ArcSizeMismatch { .. }));
    }
}
