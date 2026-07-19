//! `kaifuu xp3 smoke --fixture <id>` real-bytes round-trip smoke command.
//!
//! Composes the real-bytes round-trip surface from `kaifuu_core`:
//! - resolves the metadata-only fixture manifest by id under
//!   `fixtures/public/` (referencing it by path; no node-id token);
//! - loads the separately licensed source XP3 archive at `--archive` or
//!   `$XP3_SMOKE_SOURCE_ARCHIVE_ENV`;
//! - proves `repack(read(fixture)) == fixture` BYTE-FOR-BYTE through
//!   [`kaifuu_core::read_real_bytes_xp3_archive`] +
//!   [`kaifuu_core::repack_real_bytes_xp3_archive`] (preserves BOTH raw and
//!   zlib source index encodings verbatim);
//! - prints one `PASS` row per entry pairing the recomputed adler32 with the
//!   value stored in the source archive's `adlr` chunk.
//!
//! Real corpus input is required: the smoke does not silently SKIP when the
//! env var is unset (the integration test does that — the CLI fails loudly
//! so a missing gate is never a green pipeline). Exits 0 on success, non-zero
//! with a `kaifuu.xp3_smoke.*` semantic diagnostic otherwise.

use std::path::PathBuf;

use crate::{flag, flag_optional, read_json, redact_for_log_or_report, sha256_hash_bytes};
use kaifuu_core::{
    read_real_bytes_xp3_archive, real_bytes_xp3_adler_proof, repack_real_bytes_xp3_archive,
};

/// Env var that names the separately licensed source XP3 archive on disk
/// for the real-bytes round-trip smoke. The committed fixture is
/// metadata-only; this variable is the ONLY way the real archive bytes
/// enter the smoke process. Mirrors the integration-test env gate.
pub const XP3_SMOKE_SOURCE_ARCHIVE_ENV: &str = "KAIFUU_XP3_PROFILE_A_ARCHIVE";

/// Entry point for `kaifuu xp3 smoke --fixture <id> [--archive <path>]`.
pub fn run_xp3_real_bytes_smoke(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let fixture_id = flag(args, "--fixture")?;
    if fixture_id.is_empty() {
        return Err("kaifuu xp3 smoke --fixture <id>: fixture id is required".into());
    }
    let fixture_path = resolve_public_fixture_manifest(fixture_id)?;
    let manifest: serde_json::Value = read_json(&fixture_path)?;
    if manifest["fixture"]["id"].as_str() != Some(fixture_id) {
        return Err(format!(
            "fixture at {} records id {:?}, not {:?} (semantic: kaifuu.xp3_smoke.fixture_id_mismatch)",
            fixture_path.display(),
            manifest["fixture"]["id"].as_str().unwrap_or(""),
            fixture_id
        )
        .into());
    }

    let archive_path = match flag_optional(args, "--archive").map(PathBuf::from) {
        Some(path) => path,
        None => match std::env::var_os(XP3_SMOKE_SOURCE_ARCHIVE_ENV) {
            Some(value) => PathBuf::from(value),
            None => {
                return Err(format!(
                    "kaifuu xp3 smoke: pass --archive <path> or set {XP3_SMOKE_SOURCE_ARCHIVE_ENV} (semantic: kaifuu.xp3_smoke.archive_missing)"
                )
                .into());
            }
        },
    };
    let source = std::fs::read(&archive_path)
        .map_err(|error| format!("read {}: {error}", archive_path.display()))?;

    let expected_sha = manifest["archive"]["sha256"]
        .as_str()
        .ok_or("fixture manifest missing archive.sha256")?;
    let observed_sha = sha256_hash_bytes(&source);
    if observed_sha.strip_prefix("sha256:") != Some(expected_sha) {
        return Err(format!(
            "archive sha256 {observed_sha} does not match fixture {expected_sha:?} (semantic: kaifuu.xp3_smoke.archive_hash_mismatch)"
        )
        .into());
    }

    let archive =
        read_real_bytes_xp3_archive(&source).map_err(|error| -> Box<dyn std::error::Error> {
            format!("{} (semantic: {})", error, error.semantic_code()).into()
        })?;
    let rebuilt =
        repack_real_bytes_xp3_archive(&archive).map_err(|error| -> Box<dyn std::error::Error> {
            format!("{} (semantic: {})", error, error.semantic_code()).into()
        })?;
    if rebuilt != source {
        return Err(format!(
            "repack(read({})) != source: byte-exact round-trip failed (semantic: kaifuu.xp3_smoke.rebuild_drift)",
            archive_path.display()
        )
        .into());
    }

    // Per-entry PASS rows: recomputed adler32 == source-stored adler32.
    let proofs = real_bytes_xp3_adler_proof(&archive)?;
    println!(
        "kaifuu xp3 smoke: fixture={} archive={} entries={} bytes={} encoding={} status=PASS",
        fixture_id,
        archive_path.display(),
        archive.entries.len(),
        source.len(),
        encoding_label(archive.index_encoding),
    );
    for (path, proof) in &proofs {
        let stored = proof.stored.ok_or_else(|| {
            format!(
                "entry {path}: missing stored adler32 (semantic: kaifuu.xp3_smoke.adler_missing)"
            )
        })?;
        if proof.recomputed != stored {
            return Err(format!(
                "entry {path}: recomputed adler32 {:#010x} != stored {:#010x} (semantic: kaifuu.xp3_smoke.adler_mismatch)",
                proof.recomputed, stored
            )
            .into());
        }
        println!(
            "  [PASS] {} adler32={:#010x}",
            redact_for_log_or_report(path),
            stored,
        );
    }
    println!(
        "kaifuu xp3 smoke: {} entries passed byte-exact round-trip + adler32 proof",
        proofs.len()
    );
    Ok(())
}

fn encoding_label(encoding: u8) -> &'static str {
    match encoding {
        0 => "raw",
        1 => "zlib",
        _ => "unknown",
    }
}

/// Resolve `<repo>/fixtures/public/<id>.manifest.json` from the kaifuu-cli
/// crate directory. Lookup only — never writes, so the tracked fixture
/// stays strictly read-only.
fn resolve_public_fixture_manifest(
    fixture_id: &str,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let manifest_dir = std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from);
    let path = manifest_dir
        .join("../..")
        .join("fixtures/public")
        .join(format!("{fixture_id}.manifest.json"));
    if !path.exists() {
        return Err(format!(
            "fixture manifest not found at {} (semantic: kaifuu.xp3_smoke.fixture_missing)",
            path.display()
        )
        .into());
    }
    Ok(path)
}
