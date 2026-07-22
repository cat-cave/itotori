//! Softpal patch-back: **rebuild `TEXT.DAT`**, **repoint `SCRIPT.SRC`**, and drop
//! both into the game's **`data\` override directory** — which the SoftPal ("PAL")
//! engine resolves ahead of the `data.pac` entry, so a translation runs against
//! the **original, unmodified `data.pac`** (**no PAC repack / no re-encryption**;
//! validated: `docs/dev/softpal-patchback-loose-override.md`).
//! # The three steps
//! 1. **Rebuild `TEXT.DAT`** ([`rebuild_textdat`]). Softpal stores every string
//!    in the `TEXT.DAT` record pool (`[4-byte index][cp932 text][0x00]`), each
//!    record addressed by the absolute byte offset of its 4-byte index field —
//!    the very value a `SCRIPT.SRC` pointer holds ([`crate::TextRecord::offset`]).
//!    We emit a new pool: translated cp932 bytes for in-scope records, the
//!    **original** bytes verbatim for every out-of-scope record (byte-identical
//!    where untranslated). The 4-byte index and `0x00` terminator framing and the
//!    header record count are preserved; because a translated string changes a
//!    record's length, **every downstream record's absolute offset shifts**, so
//!    the rebuild also emits an **old→new offset map** ([`OffsetMap`]). If the
//!    original pool was `$`-encrypted the rebuilt pool is re-encrypted with the
//!    crate's [`crate::encrypt`] codec (a `_`-plaintext pool stays plaintext).
//! 2. **Repoint `SCRIPT.SRC`** ([`repoint_script`]). The disassembler
//!    ([`crate::ScriptScan`]) locates every `TEXT.DAT` pointer field by absolute
//!    byte offset. For each pointer that references the pool we rewrite its 4-byte
//!    little-endian value to the record's new offset via the old→new map.
//!    Narration name pointers ([`crate::NO_SPEAKER_POINTER`]) and out-of-pool
//!    system/branch SELECT immediates are not pool offsets, are absent from the
//!    map, and are therefore left untouched — **every other byte of `SCRIPT.SRC`
//!    is byte-identical**.
//! 3. **Loose-file drop** ([`Patchback::write_loose_files`]). The rebuilt files
//!    are written into the caller's output directory, deployed as the engine's
//!    `data\` override dir (**not** the game root). No PAC is opened or rewritten.
//! # Config-driven scope
//! Patch-back is scope-agnostic by construction: the caller decides which
//! records to translate (dialogue only, or dialogue + choices, …
//! [`project_config_driven_translation_scope`]) simply by which pointers it puts
//! in the [`TranslationMap`]. Everything outside that set is emitted byte-for-byte
//! unchanged; only the pool records that were translated (and the pointer fields
//! that reference records whose offset moved) change. Because Softpal shares one
//! pool record across every command that points at it, one translated record
//! updates every unit that references it — a shared string is a single unit.
//! # Identity round-trip
//! With an **empty** translation map the rebuilt plaintext pool equals
//! `decrypt(original)` byte-for-byte, so re-encrypting yields the original
//! `TEXT.DAT` exactly ([`crate::encrypt`] is the exact inverse of
//! [`crate::decrypt`]); no offset shifts, so every repointed field is rewritten to
//! its own value and `SCRIPT.SRC` is byte-identical too. The rebuild is therefore
//! provably lossless.
//! # Determinism / no shell-outs
//! Pure functions of the input byte buffers plus the crate's own codec /
//! disassembler; the only side effect is the optional loose-file write. Malformed
//! input never panics: every failure is a typed [`PatchbackError`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use encoding_rs::SHIFT_JIS;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    EncFlag, RawCommand, ScriptError, ScriptScan, TEXTDAT_FLAG_PLAINTEXT, TEXTDAT_HEADER_BYTE_LEN,
    TEXTDAT_MAGIC_TAIL, TextDatError, TextDatHeader, decrypt, encrypt, parse_records,
};

/// Grep-pinnable namespace marker every [`PatchbackError`] display string
/// carries, mirroring the other Softpal error markers.
pub const SOFTPAL_PATCHBACK_ERROR_MARKER: &str = "kaifuu.softpal.patchback";

/// Default loose file name for the rebuilt string pool.
pub const PATCHBACK_TEXTDAT_NAME: &str = "TEXT.DAT";
/// Default loose file name for the repointed script.
pub const PATCHBACK_SCRIPT_NAME: &str = "SCRIPT.SRC";

/// A set of translations keyed by **original `TEXT.DAT` pointer** — i.e. the
/// absolute byte offset of the record's 4-byte index field
/// ([`crate::TextRecord::offset`]), which is exactly the value a `SCRIPT.SRC`
/// pointer field holds and what the disassembler resolves against.
/// Callers build this from a [`crate::Disassembly`]: for an in-scope dialogue /
/// choice / speaker unit, use its [`crate::TextRef::pointer`] as the key. Only
/// the records whose pointer appears here are retranslated; every other record is
/// emitted byte-identical, which is how the translation **scope** is configured.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TranslationMap {
    by_pointer: HashMap<u32, String>,
}

impl TranslationMap {
    /// An empty map. Rebuilding with it reproduces the original bytes exactly
    /// (the identity round-trip).
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert / overwrite the replacement string for the record at `pointer`
    /// (an original `TEXT.DAT` record offset). Builder-style.
    #[must_use]
    pub fn with(mut self, pointer: u32, text: impl Into<String>) -> Self {
        self.by_pointer.insert(pointer, text.into());
        self
    }

    /// Insert / overwrite the replacement string for the record at `pointer`.
    pub fn insert(&mut self, pointer: u32, text: impl Into<String>) {
        self.by_pointer.insert(pointer, text.into());
    }

    /// The replacement string for `pointer`, if any.
    #[must_use]
    pub fn get(&self, pointer: u32) -> Option<&str> {
        self.by_pointer.get(&pointer).map(String::as_str)
    }

    /// Number of translated records.
    #[must_use]
    pub fn len(&self) -> usize {
        self.by_pointer.len()
    }

    /// Whether the map is empty (an empty map is the identity patch-back).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.by_pointer.is_empty()
    }
}

impl From<HashMap<u32, String>> for TranslationMap {
    fn from(by_pointer: HashMap<u32, String>) -> Self {
        Self { by_pointer }
    }
}

/// The mapping from each original `TEXT.DAT` record offset to its offset in the
/// rebuilt pool. Identity when nothing before a record was resized.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OffsetMap {
    old_to_new: HashMap<u32, u32>,
}

impl OffsetMap {
    /// The rebuilt-pool offset for an original record offset, if that offset was
    /// a record boundary in the original pool.
    #[must_use]
    pub fn get(&self, old: u32) -> Option<u32> {
        self.old_to_new.get(&old).copied()
    }

    /// Number of records in the map (== the record count of the pool).
    #[must_use]
    pub fn len(&self) -> usize {
        self.old_to_new.len()
    }

    /// Whether the map is empty (an empty pool).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.old_to_new.is_empty()
    }
}

/// The result of a patch-back: the two rebuilt loose files plus provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Patchback {
    /// The rebuilt raw `TEXT.DAT` (re-encrypted iff the original was encrypted).
    pub textdat: Vec<u8>,
    /// The repointed raw `SCRIPT.SRC`.
    pub script: Vec<u8>,
    /// The old→new record offset map produced by the rebuild.
    pub offset_map: OffsetMap,
    /// Encryption flag of the original (and therefore rebuilt) `TEXT.DAT`.
    pub flag: EncFlag,
    /// Number of records whose text was replaced by a translation.
    pub translated_record_count: usize,
    /// Number of `SCRIPT.SRC` pointer fields rewritten to a new pool offset.
    pub repointed_field_count: usize,
}

impl Patchback {
    /// Write the rebuilt `TEXT.DAT` + `SCRIPT.SRC` as **loose files** into `dir`
    /// (created if absent), using the canonical [`PATCHBACK_TEXTDAT_NAME`] /
    /// [`PATCHBACK_SCRIPT_NAME`] names. Returns the two written paths. No PAC is
    /// touched.
    /// # Errors
    /// [`PatchbackError::Io`] if the directory cannot be created or either file
    /// cannot be written.
    pub fn write_loose_files(&self, dir: &Path) -> Result<(PathBuf, PathBuf), PatchbackError> {
        let io = |path: &Path, e: &std::io::Error| PatchbackError::Io {
            path: path.to_path_buf(),
            kind: e.kind(),
            message: e.to_string(),
        };
        std::fs::create_dir_all(dir).map_err(|e| io(dir, &e))?;
        let textdat_path = dir.join(PATCHBACK_TEXTDAT_NAME);
        let script_path = dir.join(PATCHBACK_SCRIPT_NAME);
        std::fs::write(&textdat_path, &self.textdat).map_err(|e| io(&textdat_path, &e))?;
        std::fs::write(&script_path, &self.script).map_err(|e| io(&script_path, &e))?;
        Ok((textdat_path, script_path))
    }
}

/// Fatal errors raised during patch-back.
/// Every display string begins with the `kaifuu.softpal.patchback` namespace
/// marker (see [`SOFTPAL_PATCHBACK_ERROR_MARKER`]).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PatchbackError {
    /// The original `TEXT.DAT` could not be decoded (bad header / cipher / pool).
    #[error("kaifuu.softpal.patchback.textdat: {0}")]
    TextDat(#[from] TextDatError),
    /// The original `SCRIPT.SRC` could not be scanned.
    #[error("kaifuu.softpal.patchback.script: {0}")]
    Script(#[from] ScriptError),
    /// A replacement string contains characters that cannot be encoded in cp932
    /// (Shift-JIS). Encoding would silently substitute, so it is a hard error.
    #[error(
        "kaifuu.softpal.patchback.unencodable: replacement text for the record at pointer \
         {pointer} (offset 0x{pointer:08X}) has characters that do not encode in cp932/Shift-JIS"
    )]
    Unencodable { pointer: u32 },
    /// A rebuilt record offset does not fit in the 32-bit pointer field (a pool
    /// larger than 4 GiB — not reachable for any real Softpal title).
    #[error(
        "kaifuu.softpal.patchback.offset_overflow: rebuilt record offset {offset} exceeds the \
         32-bit `TEXT.DAT` pointer range"
    )]
    OffsetOverflow { offset: usize },
    /// A `SCRIPT.SRC` pointer field the disassembler located lies outside the
    /// buffer (defensive; the scanner keeps fields in bounds).
    #[error(
        "kaifuu.softpal.patchback.field_out_of_bounds: pointer field at offset {field_offset} \
         needs 4 bytes but SCRIPT.SRC is only {script_len} bytes"
    )]
    FieldOutOfBounds {
        field_offset: usize,
        script_len: usize,
    },
    /// A loose file could not be written.
    #[error("kaifuu.softpal.patchback.io: writing {path}: {message} ({kind:?})")]
    Io {
        path: PathBuf,
        kind: std::io::ErrorKind,
        message: String,
    },
}

/// Write a little-endian `u32` into `buf` at `off`. Caller guarantees room.
fn write_u32_le(buf: &mut [u8], off: usize, value: u32) {
    buf[off..off + 4].copy_from_slice(&value.to_le_bytes());
}

/// Encode a replacement string to cp932 (Shift-JIS) bytes, erroring rather than
/// silently substituting an unmappable character.
fn encode_cp932(text: &str, pointer: u32) -> Result<Vec<u8>, PatchbackError> {
    let (bytes, _enc, had_errors) = SHIFT_JIS.encode(text);
    if had_errors {
        return Err(PatchbackError::Unencodable { pointer });
    }
    Ok(bytes.into_owned())
}

/// Rebuild a `TEXT.DAT` from `original` (raw, possibly encrypted), replacing the
/// text of every record whose original offset appears in `translations` and
/// leaving all others byte-identical. Returns the rebuilt raw `TEXT.DAT` (encrypted
/// iff the original was), the old→new offset map, the encryption flag, and the
/// number of records translated.
/// # Errors
/// [`PatchbackError::TextDat`] if the original cannot be decoded,
/// [`PatchbackError::Unencodable`] if a replacement is not cp932-encodable, or
/// [`PatchbackError::OffsetOverflow`] if a rebuilt offset exceeds 32 bits.
pub fn rebuild_textdat(
    original: &[u8],
    translations: &TranslationMap,
) -> Result<(Vec<u8>, OffsetMap, EncFlag, usize), PatchbackError> {
    let header = TextDatHeader::parse(original)?;
    let plaintext = decrypt(original)?;
    let records = parse_records(&plaintext)?;

    // Rebuilt plaintext: header verbatim (flag forced plaintext, magic tail,
    // preserved record count), then each record re-emitted.
    let mut out = Vec::with_capacity(plaintext.len());
    out.push(TEXTDAT_FLAG_PLAINTEXT);
    out.extend_from_slice(TEXTDAT_MAGIC_TAIL);
    out.extend_from_slice(&(records.len() as u32).to_le_bytes());
    debug_assert_eq!(out.len(), TEXTDAT_HEADER_BYTE_LEN);

    let mut old_to_new = HashMap::with_capacity(records.len());
    let mut translated = 0usize;
    for record in &records {
        let old_off = u32::try_from(record.offset).map_err(|_| PatchbackError::OffsetOverflow {
            offset: record.offset,
        })?;
        let new_off = u32::try_from(out.len())
            .map_err(|_| PatchbackError::OffsetOverflow { offset: out.len() })?;
        old_to_new.insert(old_off, new_off);

        // The 4-byte index field is preserved verbatim.
        out.extend_from_slice(&record.index.to_le_bytes());
        // Text: translated cp932 bytes for in-scope records, original otherwise.
        match translations.get(old_off) {
            Some(replacement) => {
                out.extend_from_slice(&encode_cp932(replacement, old_off)?);
                translated += 1;
            }
            None => out.extend_from_slice(&record.raw_text),
        }
        out.push(0x00);
    }

    // Re-encrypt iff the original pool was encrypted. `out` currently has a
    // plaintext ('_') header; `encrypt` is flag-gated and idempotent.
    let raw = match header.flag {
        EncFlag::Encrypted => encrypt(&out)?,
        EncFlag::Plaintext => out,
    };

    Ok((raw, OffsetMap { old_to_new }, header.flag, translated))
}

/// Repoint a `SCRIPT.SRC` in place against an [`OffsetMap`]: every located
/// `TEXT.DAT` pointer field whose value is a record offset in the map is rewritten
/// to that record's new offset; narration / out-of-pool immediates (absent from
/// the map) are left untouched, and every other byte is unchanged. Returns the
/// rewritten buffer and the number of fields changed to a *different* value plus
/// the total number repointed.
/// # Errors
/// [`PatchbackError::Script`] if the script cannot be scanned, or
/// [`PatchbackError::FieldOutOfBounds`] (defensive) if a located field is not
/// wholly within the buffer.
pub fn repoint_script(
    original_script: &[u8],
    offset_map: &OffsetMap,
) -> Result<(Vec<u8>, usize), PatchbackError> {
    let scan = ScriptScan::parse(original_script)?;
    let mut out = original_script.to_vec();
    let len = out.len();
    let mut repointed = 0usize;

    // Collect (field_offset, current_pointer) for every pool-referencing field.
    let mut fields: Vec<(usize, u32)> = Vec::new();
    for cmd in &scan.commands {
        match *cmd {
            RawCommand::TextShow {
                text_pointer,
                text_ptr_field_offset,
                name_pointer,
                name_ptr_field_offset,
                ..
            } => {
                fields.push((text_ptr_field_offset, text_pointer));
                if let Some(name) = name_pointer {
                    fields.push((name_ptr_field_offset, name));
                }
            }
            RawCommand::Select {
                text_pointer,
                text_ptr_field_offset,
                decoupled_label,
                ..
            } => {
                // A direct immediate carries its label; a typed system-select
                // immediate is absent from the map and is skipped.
                fields.push((text_ptr_field_offset, text_pointer));
                // An indirect label lives in a separate earlier field in the menu
                // block, so repoint it too when the choice was translated.
                if let Some(dl) = decoupled_label {
                    fields.push((dl.field_offset, dl.pointer));
                }
            }
        }
    }

    for (field_offset, pointer) in fields {
        // Only pool references are in the map; narration (0x0FFFFFFF) and
        // out-of-pool SELECT immediates (0x40000000) are not, so they are skipped.
        let Some(new_ptr) = offset_map.get(pointer) else {
            continue;
        };
        if field_offset + 4 > len {
            return Err(PatchbackError::FieldOutOfBounds {
                field_offset,
                script_len: len,
            });
        }
        write_u32_le(&mut out, field_offset, new_ptr);
        repointed += 1;
    }

    Ok((out, repointed))
}

/// Run the full patch-back: [`rebuild_textdat`] then [`repoint_script`], returning
/// the two rebuilt loose files ready to drop beside the game.
/// `original_textdat` and `original_script` are the raw entries (as extracted from
/// the PAC); `translations` selects which records to retranslate (config-driven
/// scope — see the module docs).
/// # Errors
/// Any [`PatchbackError`] from the rebuild or the repoint.
pub fn patchback(
    original_textdat: &[u8],
    original_script: &[u8],
    translations: &TranslationMap,
) -> Result<Patchback, PatchbackError> {
    let (textdat, offset_map, flag, translated_record_count) =
        rebuild_textdat(original_textdat, translations)?;
    let (script, repointed_field_count) = repoint_script(original_script, &offset_map)?;
    Ok(Patchback {
        textdat,
        script,
        offset_map,
        flag,
        translated_record_count,
        repointed_field_count,
    })
}

#[cfg(test)]
#[path = "patchback_tests.rs"]
mod tests;
