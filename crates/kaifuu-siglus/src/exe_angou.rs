//! Native, in-process recovery of the per-game **exe-angou** 16-byte key from
//! `SiglusEngine.exe` bytes. No Wine, no running the executable, no shell-out:
//! this is a pure static analysis of the PE image (`&[u8]` → key material).
//!
//! # Why this exists
//! Both owned titles set `exe_angou_mode = 1`, so their `Gameexe.dat` body (and
//! scene payloads) are masked with a per-game 16-byte key in addition to the
//! engine-constant [`crate::decrypt::SIGLUS_GAMEEXE_XOR_TABLE`]. That key is a
//! **pure static function of the executable**: SiglusEngine builds the working
//! key on the stack by scatter-gathering sixteen bytes from fixed addresses in
//! its `.data` section, one `mov al,[imm32]` / `mov [ebp+disp8],al` pair per key
//! byte. Recovering the key is therefore a matter of reading the gather code and
//! following each source pointer — no dynamic execution required.
//!
//! # The gather recipe (engine-version-robust, shape-keyed)
//! In `.text` the key is assembled by a cluster of sixteen instruction pairs:
//! ```text
//!   A0 <moffs32>        ; mov al, [imm32]        source byte = exe[moffs32 - image_base -> file offset]
//!   88 45 <disp8>       ; mov [ebp+disp8], al    key slot   = disp8 (ebp-0x20 .. ebp-0x11)
//! ```
//! The `88 45 <disp8>` store follows its `A0` load within a few bytes. `disp8`
//! ranges over the sixteen consecutive stack slots `ebp-0x20 .. ebp-0x11`
//! (`0xE0 ..= 0xEF` as a signed byte), giving the key **index**; the `moffs32`
//! (minus the PE image base, mapped through the section table to a file offset)
//! gives the **source byte**. So `key[index] = exe[moffs32_as_file_offset]`.
//! The scan keys off this opcode/store SHAPE, not on any hardcoded offset, so it
//! is robust across engine builds. (In the two staged 9,604,608-byte images the
//! primary cluster sits at file offset `0x28e0d2` with a duplicate near
//! `0x2979xx`, both gathering from the per-game data table at `0x75aa98`; the
//! scanner takes the first store seen per slot, so either cluster suffices.)
//!
//! # Key-handling discipline
//! The recovered raw bytes never cross this module boundary in the clear. They
//! are wrapped immediately into a [`SiglusSecondLayerMaterial`] (redacting
//! `Debug`, zeroizing `Drop`, byte-free public surface). The returned
//! [`ExeAngouKeyReport`] carries only a structured secret-ref, the key byte
//! length, and a one-way sha256 commitment to the material — never the key.
//! Missing/protected/unmappable cases return a typed [`ExeAngouKeyError`]
//! (its `Display` begins with the crate's `kaifuu.siglus` honesty marker), never
//! a panic.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::decrypt::{
    SIGLUS_SECOND_LAYER_KEY_BYTE_LEN, SiglusSecondLayerKey, SiglusSecondLayerMaterial,
};

/// Byte length of the recovered exe-angou key (mirrors the second-layer key).
pub const EXE_ANGOU_KEY_BYTE_LEN: usize = SIGLUS_SECOND_LAYER_KEY_BYTE_LEN;

/// `mov al, [moffs32]` opcode (`A0` + 4-byte absolute address).
const OPCODE_MOV_AL_MOFFS32: u8 = 0xA0;
/// `mov [ebp+disp8], al` opcode prefix (`88 45` + 1-byte displacement).
const OPCODE_MOV_EBP_DISP8_AL: [u8; 2] = [0x88, 0x45];
/// Lowest `disp8` (signed) for the sixteen consecutive key slots (`ebp-0x20`).
const KEY_SLOT_DISP8_LOW: u8 = 0xE0;
/// Highest `disp8` (signed) for the sixteen consecutive key slots (`ebp-0x11`).
const KEY_SLOT_DISP8_HIGH: u8 = 0xEF;
/// Window (in bytes) after an `A0` load in which its paired store must appear.
const STORE_LOOKAHEAD: usize = 8;

/// Fatal, typed diagnostics for exe-angou key recovery. Every `Display` form
/// begins with the crate's `kaifuu.siglus` honesty marker; recovery never
/// panics on malformed / protected / unexpected input.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ExeAngouKeyError {
    /// The bytes are not a PE image (`MZ` / `PE\0\0` signatures absent).
    #[error("kaifuu.siglus.exe_angou.not_pe: input is not a PE executable ({detail})")]
    NotPortableExecutable { detail: &'static str },
    /// The PE optional header is not the 32-bit (`PE32`) form this recovery
    /// understands. SiglusEngine ships as a 32-bit image.
    #[error(
        "kaifuu.siglus.exe_angou.unsupported_pe: optional-header magic {magic:#06x} is not PE32; \
         exe-angou recovery targets the 32-bit SiglusEngine image"
    )]
    UnsupportedPeFormat { magic: u16 },
    /// No `.text` section could be located to scan for the gather cluster.
    #[error("kaifuu.siglus.exe_angou.text_section_missing: PE image has no .text section to scan")]
    TextSectionMissing,
    /// Fewer than sixteen distinct key slots were recovered from the gather
    /// cluster — the executable is packed/protected or does not carry the
    /// static-key gather (an absent/unsupported region, not a fabricated key).
    #[error(
        "kaifuu.siglus.exe_angou.key_cluster_incomplete: recovered {recovered} of \
         {EXE_ANGOU_KEY_BYTE_LEN} static-key slots; the gather cluster is absent or the image is \
         packed/protected"
    )]
    KeyClusterIncomplete { recovered: usize },
    /// A gather source pointer did not map into any raw section — a wrong/absent
    /// key region rather than a real static-key site.
    #[error(
        "kaifuu.siglus.exe_angou.source_unmapped: gather source address {virtual_address:#010x} \
         does not map into any raw PE section"
    )]
    SourceByteUnmapped { virtual_address: u32 },
}

/// The redaction-safe result of an exe-angou key recovery: a structured
/// secret-ref, the key byte length, and a one-way sha256 commitment. Never
/// carries raw key bytes, so it is safe to serialize, log, and persist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExeAngouKeyReport {
    /// The structured secret-ref the recovered key is published under.
    pub secret_ref: String,
    /// Recovered key length in bytes (always [`EXE_ANGOU_KEY_BYTE_LEN`]).
    pub key_byte_len: u32,
    /// Full lowercase-hex sha256 of the recovered key bytes — a one-way
    /// commitment that attests *which* key was recovered without disclosing it.
    pub material_sha256: String,
    /// File offset of the `.text` section that was scanned.
    pub text_section_file_offset: u32,
    /// Number of gather store sites (`mov [ebp+disp8], al`) consumed to fill the
    /// sixteen key slots.
    pub gather_site_count: u32,
}

/// A recovered exe-angou key: the encapsulated key material plus its
/// redaction-safe report. The raw bytes live only inside `material`.
#[derive(Debug)]
pub struct ExeAngouKeyRecovery {
    material: SiglusSecondLayerMaterial,
    report: ExeAngouKeyReport,
}

impl ExeAngouKeyRecovery {
    /// Borrow the encapsulated key material (feed to
    /// [`crate::gameexe::decode_gameexe_dat`] / [`crate::decrypt::apply_xor_table`]).
    pub fn material(&self) -> &SiglusSecondLayerMaterial {
        &self.material
    }

    /// Consume the recovery, yielding the encapsulated key material.
    pub fn into_material(self) -> SiglusSecondLayerMaterial {
        self.material
    }

    /// The redaction-safe report (secret-ref + sha256 commitment + counts).
    pub fn report(&self) -> &ExeAngouKeyReport {
        &self.report
    }
}

/// Recover the per-game exe-angou key from `SiglusEngine.exe` bytes, in-process.
/// Parses the PE, scans `.text` for the sixteen-pair static-key gather cluster,
/// follows each source pointer into `.data`, and returns the sixteen key bytes
/// bound to `key_ref` as encapsulated [`SiglusSecondLayerMaterial`]. Protected /
/// packed / non-PE / unmappable inputs are typed [`ExeAngouKeyError`]s.
pub fn recover_exe_angou_key(
    exe_bytes: &[u8],
    key_ref: &SiglusSecondLayerKey,
) -> Result<ExeAngouKeyRecovery, ExeAngouKeyError> {
    let image = PeImage::parse(exe_bytes)?;
    let text = image
        .section_by_name(b".text")
        .ok_or(ExeAngouKeyError::TextSectionMissing)?;

    let text_bytes = image.section_raw(exe_bytes, text);
    let mut key = [0u8; EXE_ANGOU_KEY_BYTE_LEN];
    let mut filled = [false; EXE_ANGOU_KEY_BYTE_LEN];
    let mut recovered = 0usize;
    let mut gather_sites = 0u32;

    let mut cursor = 0usize;
    while cursor + 5 <= text_bytes.len() {
        if text_bytes[cursor] != OPCODE_MOV_AL_MOFFS32 {
            cursor += 1;
            continue;
        }
        let moffs = u32::from_le_bytes([
            text_bytes[cursor + 1],
            text_bytes[cursor + 2],
            text_bytes[cursor + 3],
            text_bytes[cursor + 4],
        ]);
        // Look ahead a few bytes for the paired `mov [ebp+disp8], al` store.
        let store_scan_start = cursor + 5;
        let store_scan_end = (store_scan_start + STORE_LOOKAHEAD).min(text_bytes.len());
        let mut matched = false;
        let mut store = store_scan_start;
        while store + 3 <= store_scan_end {
            if text_bytes[store] == OPCODE_MOV_EBP_DISP8_AL[0]
                && text_bytes[store + 1] == OPCODE_MOV_EBP_DISP8_AL[1]
            {
                let disp8 = text_bytes[store + 2];
                if (KEY_SLOT_DISP8_LOW..=KEY_SLOT_DISP8_HIGH).contains(&disp8) {
                    let index = (disp8 - KEY_SLOT_DISP8_LOW) as usize;
                    let file_offset = image.virtual_address_to_file_offset(moffs).ok_or(
                        ExeAngouKeyError::SourceByteUnmapped {
                            virtual_address: moffs,
                        },
                    )?;
                    // A `mov al, [global]` reads DATA, not code; reject a source
                    // that resolves back into the scanned `.text` section.
                    if !image.file_offset_in_section(file_offset, text) {
                        let source = *exe_bytes.get(file_offset).ok_or(
                            ExeAngouKeyError::SourceByteUnmapped {
                                virtual_address: moffs,
                            },
                        )?;
                        gather_sites += 1;
                        if !filled[index] {
                            key[index] = source;
                            filled[index] = true;
                            recovered += 1;
                        }
                        matched = true;
                    }
                }
                // A `88 45 xx` store terminates this load's pairing search.
                break;
            }
            store += 1;
        }
        // Advance past this load (and its consumed store, if any).
        cursor = if matched { store + 3 } else { store_scan_start };
    }

    if recovered != EXE_ANGOU_KEY_BYTE_LEN {
        // Zeroize the partial key before returning the diagnostic.
        key.iter_mut().for_each(|byte| *byte = 0);
        return Err(ExeAngouKeyError::KeyClusterIncomplete { recovered });
    }

    let material_sha256 = hex_sha256(&key);
    let material = SiglusSecondLayerMaterial::resolve(key_ref, key.to_vec())
        .expect("recovered key is exactly EXE_ANGOU_KEY_BYTE_LEN bytes");
    // Drop the local copy's plaintext now that it is encapsulated.
    key.iter_mut().for_each(|byte| *byte = 0);

    let report = ExeAngouKeyReport {
        secret_ref: key_ref.secret_ref().to_string(),
        key_byte_len: EXE_ANGOU_KEY_BYTE_LEN as u32,
        material_sha256,
        text_section_file_offset: text.raw_ptr,
        gather_site_count: gather_sites,
    };
    Ok(ExeAngouKeyRecovery { material, report })
}

/// Full lowercase-hex sha256 of `bytes` (a one-way commitment).
fn hex_sha256(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut acc, byte| {
            let _ = write!(acc, "{byte:02x}");
            acc
        })
}

/// One PE section header (the fields the scanner needs).
#[derive(Debug, Clone)]
struct PeSection {
    name: [u8; 8],
    virtual_address: u32,
    virtual_size: u32,
    raw_ptr: u32,
    raw_size: u32,
}

/// A minimal, read-only 32-bit PE image view: image base + section table. No
/// `unsafe`, no external crate — just enough to map virtual addresses to file
/// offsets and locate `.text`/`.data`.
#[derive(Debug)]
struct PeImage {
    image_base: u32,
    sections: Vec<PeSection>,
}

impl PeImage {
    fn parse(bytes: &[u8]) -> Result<Self, ExeAngouKeyError> {
        if bytes.get(0..2) != Some(b"MZ") {
            return Err(ExeAngouKeyError::NotPortableExecutable {
                detail: "missing MZ signature",
            });
        }
        let e_lfanew = read_u32(bytes, 0x3c).ok_or(ExeAngouKeyError::NotPortableExecutable {
            detail: "truncated MZ header",
        })? as usize;
        if bytes.get(e_lfanew..e_lfanew + 4) != Some(b"PE\0\0") {
            return Err(ExeAngouKeyError::NotPortableExecutable {
                detail: "missing PE signature",
            });
        }
        let coff = e_lfanew + 4;
        let num_sections =
            read_u16(bytes, coff + 2).ok_or(ExeAngouKeyError::NotPortableExecutable {
                detail: "truncated COFF header",
            })? as usize;
        let size_optional =
            read_u16(bytes, coff + 16).ok_or(ExeAngouKeyError::NotPortableExecutable {
                detail: "truncated COFF header",
            })? as usize;
        let optional = coff + 20;
        let magic = read_u16(bytes, optional).ok_or(ExeAngouKeyError::NotPortableExecutable {
            detail: "truncated optional header",
        })?;
        if magic != 0x010b {
            return Err(ExeAngouKeyError::UnsupportedPeFormat { magic });
        }
        let image_base =
            read_u32(bytes, optional + 28).ok_or(ExeAngouKeyError::NotPortableExecutable {
                detail: "truncated optional header (image base)",
            })?;

        let table = optional + size_optional;
        let mut sections = Vec::with_capacity(num_sections);
        for index in 0..num_sections {
            let base = table + index * 40;
            let raw_name =
                bytes
                    .get(base..base + 8)
                    .ok_or(ExeAngouKeyError::NotPortableExecutable {
                        detail: "truncated section table",
                    })?;
            let mut name = [0u8; 8];
            name.copy_from_slice(raw_name);
            let field = |offset: usize| {
                read_u32(bytes, base + offset).ok_or(ExeAngouKeyError::NotPortableExecutable {
                    detail: "truncated section header",
                })
            };
            sections.push(PeSection {
                name,
                virtual_size: field(8)?,
                virtual_address: field(12)?,
                raw_size: field(16)?,
                raw_ptr: field(20)?,
            });
        }
        Ok(Self {
            image_base,
            sections,
        })
    }

    fn section_by_name(&self, wanted: &[u8]) -> Option<&PeSection> {
        self.sections.iter().find(|section| {
            let trimmed: &[u8] = section
                .name
                .split(|byte| *byte == 0)
                .next()
                .unwrap_or(&section.name);
            trimmed == wanted
        })
    }

    /// The raw on-disk bytes of a section (clamped to the file length).
    fn section_raw<'a>(&self, bytes: &'a [u8], section: &PeSection) -> &'a [u8] {
        let start = section.raw_ptr as usize;
        let end = start
            .saturating_add(section.raw_size as usize)
            .min(bytes.len());
        bytes.get(start..end).unwrap_or(&[])
    }

    /// Map an absolute virtual address to a file offset via the section table.
    fn virtual_address_to_file_offset(&self, virtual_address: u32) -> Option<usize> {
        let rva = virtual_address.checked_sub(self.image_base)?;
        for section in &self.sections {
            let span = section.virtual_size.max(section.raw_size);
            let start = section.virtual_address;
            let end = start.checked_add(span)?;
            if rva >= start && rva < end {
                let delta = rva - start;
                if delta < section.raw_size {
                    return Some((section.raw_ptr + delta) as usize);
                }
            }
        }
        None
    }

    /// Whether a file offset falls inside a given section's raw range.
    fn file_offset_in_section(&self, file_offset: usize, section: &PeSection) -> bool {
        let start = section.raw_ptr as usize;
        let end = start.saturating_add(section.raw_size as usize);
        (start..end).contains(&file_offset)
    }
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let slice = bytes.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

#[cfg(test)]
mod tests;
