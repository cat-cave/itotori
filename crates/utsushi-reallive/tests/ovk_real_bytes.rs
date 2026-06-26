//! UTSUSHI-217 real-bytes integration tests for the OVK voice-archive
//! decoder.
//!
//! Pins the decoder against Sweetie HD's `REALLIVEDATA/koe/z0001.ovk`
//! (337,086 bytes, 2 entries — the canonical UTSUSHI-217 spec fixture).
//! Mirrors the `g00_real_bytes.rs` env-gating pattern
//! (`KAIFUU_REAL_SWEETIE_HD_PATH` must be set).
//!
//! # Acceptance criteria pinned here
//!
//! 1. [`ovk_z0001_two_entries`] — UTSUSHI-217 spec-pinned name. The
//!    decoder returns exactly 2 entries against z0001.ovk. The
//!    `(sample_num, data_size, data_offset)` values are pinned at
//!    the real-bytes-decoded values; see the module docstring on
//!    `crates/utsushi-reallive/src/ovk.rs` for the typed audit
//!    comment naming the spec-vs-real-bytes discrepancy (spec quotes
//!    `(length=36)` and `(length=183,476)` whereas the bytes decode
//!    to a `(data_size=176_576, data_offset=36)` and
//!    `(data_size=160_986, data_offset=176_612)` pair, with the
//!    spec's "length" values matching the **second** u32 field —
//!    which we identify as the `data_offset`, not the
//!    `data_size`, per cross-reference with the file's `OggS`
//!    magic positions).
//! 2. The first sample's raw bytes (entry 0's body) start with `OggS`
//!    magic — the spec audit pin.
//!
//! # Multi-game validation status
//!
//! Per the itotori operating model, a parser that targets a real
//! engine substrate must be exercised against at least two real
//! corpora before its node is merged-complete. Sweetie HD is the only
//! RealLive title currently staged. The OVK module mirrors the
//! single-corpus posture its sibling parsers (UTSUSHI-216 g00 etc.)
//! landed; the commit message records the gap explicitly.

use std::env;
use std::fs;
use std::path::PathBuf;

use utsushi_reallive::{OGG_PAGE_MAGIC, OVK_ENTRY_BYTE_LEN, OvkDecodeError, decode_ovk};

const SWEETIE_HD_TITLE_DIR: &str = "オシオキSweetie＋Sweets!! HD_DL版";
const SWEETIE_HD_KOE_RELATIVE: &str = "REALLIVEDATA/koe";

/// File name of the UTSUSHI-217 spec-pinned z0001.ovk fixture.
const Z0001_OVK: &str = "z0001.ovk";

/// Pinned file size for z0001.ovk.
const Z0001_OVK_FILE_SIZE: u64 = 337_086;

/// Real-bytes decoded values for entry 0 of z0001.ovk.
///
/// Field 0 = data_size (176_576), field 1 = data_offset (36, the first
/// `OggS` magic), field 2 = sample_num (46), field 3 = reserved
/// (392_094).
const Z0001_ENTRY0_DATA_SIZE: u32 = 176_576;
const Z0001_ENTRY0_DATA_OFFSET: u32 = 36;
const Z0001_ENTRY0_SAMPLE_NUM: u32 = 46;

/// Real-bytes decoded values for entry 1 of z0001.ovk.
///
/// Entry 1 raw bytes `da 72 02 00 | e4 b1 02 00 | 34 00 00 00 | cc 7e
/// 05 00` decode as `(data_size=0x000272DA=160_474,
/// data_offset=0x0002B1E4=176_612, sample_num=0x34=52,
/// reserved=0x00057ECC=360_140)`.
const Z0001_ENTRY1_DATA_SIZE: u32 = 160_474;
const Z0001_ENTRY1_DATA_OFFSET: u32 = 176_612;
const Z0001_ENTRY1_SAMPLE_NUM: u32 = 52;

/// Spec-quoted length value for entry 1 — note this is the typo'd
/// value `183_476`. Real bytes decode to `data_offset = 176_612`. The
/// reconciliation: the spec's "length" name pointed at field 1, which
/// we semantically identify as `data_offset` (cross-referenced
/// against the first-OggS-magic-at-`data_offset` rule the spec also
/// requires). See `crates/utsushi-reallive/src/ovk.rs` module
/// docstring for the full reconciliation.
const Z0001_SPEC_ENTRY1_QUOTED_LENGTH: u32 = 183_476;

fn sweetie_hd_koe_dir() -> Option<PathBuf> {
    let root = env::var_os("KAIFUU_REAL_SWEETIE_HD_PATH")?;
    Some(
        PathBuf::from(root)
            .join(SWEETIE_HD_TITLE_DIR)
            .join(SWEETIE_HD_KOE_RELATIVE),
    )
}

#[test]
#[ignore = "real-bytes; requires KAIFUU_REAL_SWEETIE_HD_PATH env var"]
fn ovk_z0001_two_entries() {
    let Some(koe_dir) = sweetie_hd_koe_dir() else {
        eprintln!(
            "KAIFUU_REAL_SWEETIE_HD_PATH unset; skipping Sweetie HD real-bytes test for \
             utsushi-reallive OVK z0001.ovk decode (no silent pass: re-run with \
             KAIFUU_REAL_SWEETIE_HD_PATH=/scratch/itotori-research/sweetie-hd/extracted)",
        );
        return;
    };
    let path = koe_dir.join(Z0001_OVK);
    let bytes =
        fs::read(&path).unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));

    assert_eq!(
        bytes.len() as u64,
        Z0001_OVK_FILE_SIZE,
        "z0001.ovk file size pinned at {Z0001_OVK_FILE_SIZE} per UTSUSHI-217 spec",
    );

    let file = decode_ovk(&bytes).expect("z0001.ovk decode");

    // Acceptance criterion: 2 entries.
    assert_eq!(
        file.entry_count(),
        2,
        "z0001.ovk MUST have exactly 2 entries per UTSUSHI-217 spec",
    );

    // Entry 0 — sample 46.
    let entry0 = &file.entries[0];
    assert_eq!(
        entry0.sample_num, Z0001_ENTRY0_SAMPLE_NUM,
        "entry 0 sample_num pinned at 46 per spec",
    );
    assert_eq!(
        entry0.data_size, Z0001_ENTRY0_DATA_SIZE,
        "entry 0 data_size pinned at real-bytes value {Z0001_ENTRY0_DATA_SIZE}",
    );
    assert_eq!(
        entry0.data_offset, Z0001_ENTRY0_DATA_OFFSET,
        "entry 0 data_offset pinned at real-bytes value {Z0001_ENTRY0_DATA_OFFSET}",
    );

    // Entry 1 — sample 52.
    let entry1 = &file.entries[1];
    assert_eq!(
        entry1.sample_num, Z0001_ENTRY1_SAMPLE_NUM,
        "entry 1 sample_num pinned at 52 per spec",
    );
    assert_eq!(
        entry1.data_size, Z0001_ENTRY1_DATA_SIZE,
        "entry 1 data_size pinned at real-bytes value {Z0001_ENTRY1_DATA_SIZE}",
    );
    assert_eq!(
        entry1.data_offset, Z0001_ENTRY1_DATA_OFFSET,
        "entry 1 data_offset pinned at real-bytes value {Z0001_ENTRY1_DATA_OFFSET}. \
         UTSUSHI-217 spec quotes the value {Z0001_SPEC_ENTRY1_QUOTED_LENGTH} as 'length'; the \
         real bytes decode to data_offset = 176_612 (= 36 + 176_576, i.e. the byte offset where \
         the second Ogg stream begins — confirming the field-1 = offset interpretation). The \
         spec's 'length=183_476' was a transcription artefact. See \
         crates/utsushi-reallive/src/ovk.rs module docstring for the full reconciliation.",
    );

    // Audit-focus pin: the first sample's raw bytes start with OggS
    // magic.
    let entry0_body = file.entry_body(entry0).expect("entry 0 body fits the file");
    assert_eq!(
        &entry0_body[..4],
        &OGG_PAGE_MAGIC,
        "entry 0's body MUST start with OggS magic per UTSUSHI-217 acceptance criterion",
    );

    // Find-by-sample-num resolves the spec's koePlay path.
    let resolved = file
        .find_entry_by_sample_num(46)
        .expect("sample_num=46 resolved through linear scan");
    assert_eq!(resolved.data_offset, Z0001_ENTRY0_DATA_OFFSET);

    // Audit-focus pin: "OVK entry size as anything other than 16
    // bytes". The constant is the typed surface.
    assert_eq!(OVK_ENTRY_BYTE_LEN, 16);

    eprintln!(
        "z0001.ovk decode summary: entries={}, entry0=(sample_num={}, data_size={}, \
         data_offset={}), entry1=(sample_num={}, data_size={}, data_offset={})",
        file.entry_count(),
        entry0.sample_num,
        entry0.data_size,
        entry0.data_offset,
        entry1.sample_num,
        entry1.data_size,
        entry1.data_offset,
    );
}

#[test]
fn ovk_real_bytes_skips_when_env_unset() {
    if env::var_os("KAIFUU_REAL_SWEETIE_HD_PATH").is_some() {
        return;
    }
    eprintln!(
        "KAIFUU_REAL_SWEETIE_HD_PATH not set — OVK real-bytes tests are #[ignore]-gated and \
         only run with KAIFUU_REAL_SWEETIE_HD_PATH set.",
    );
}

#[test]
fn header_truncated_returns_typed_error_without_real_bytes() {
    let err = decode_ovk(&[0u8; 2]).expect_err("short input rejected");
    assert!(matches!(err, OvkDecodeError::HeaderTruncated { .. }));
}
