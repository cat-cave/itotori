//! One-shot diagnostic probe: runs the public `kaifuu-reallive` surface
//! against real bytes pointed at by `KAIFUU_PROBE_SEEN_TXT` /
//! `KAIFUU_PROBE_GAMEEXE_INI` env vars and prints a compact report.
//!
//! Read-only on the input bytes. Used by the
//! `docs/audits/real-bytes-validation-2026-06-24.md` validation sweep.

use std::env;
use std::fs;

use kaifuu_reallive::{
    GameexeKeyTreatment, parse_archive, parse_gameexe_inventory, parse_scene_into_ast,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(path) = env::var("KAIFUU_PROBE_SEEN_TXT") {
        probe_seen_txt(&path)?;
    }
    if let Ok(path) = env::var("KAIFUU_PROBE_GAMEEXE_INI") {
        probe_gameexe_ini(&path)?;
    }
    Ok(())
}

fn probe_seen_txt(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    println!("=== SEEN.TXT probe: {path} ===");
    let bytes = fs::read(path)?;
    println!("file bytes: {}", bytes.len());
    let head: Vec<String> = bytes.iter().take(32).map(|b| format!("{b:02X}")).collect();
    println!("first 32 bytes hex: {}", head.join(" "));

    match parse_archive(&bytes) {
        Ok(index) => {
            println!(
                "parse_archive: OK, archive_len={}, entries={}",
                bytes.len(),
                index.entries.len()
            );
            if let Some(first) = index.entries.first() {
                println!(
                    "  first entry: id={} scene_id={} byte_offset={} byte_len={}",
                    first.scene_id_str(),
                    first.scene_id,
                    first.byte_offset,
                    first.byte_len
                );
                // Probe parse_scene on first entry payload bytes.
                let start = first.byte_offset as usize;
                let end = start + first.byte_len as usize;
                if end <= bytes.len() {
                    let outcome =
                        parse_scene_into_ast(&bytes[start..end], first.scene_id, first.byte_offset);
                    let instruction_count = outcome
                        .scene
                        .as_ref()
                        .map(|scene| scene.instructions.len())
                        .unwrap_or(0);
                    println!(
                        "  parse_scene[first]: status={:?} instructions={} diagnostics={}",
                        outcome.status,
                        instruction_count,
                        outcome.diagnostics.len()
                    );
                    for diag in outcome.diagnostics.iter().take(3) {
                        println!(
                            "    diag: code={:?} byte_offset={} message={}",
                            diag.code, diag.byte_offset, diag.message
                        );
                    }
                }
            }
        }
        Err(diag) => {
            println!(
                "parse_archive: FATAL code={:?} byte_offset={} byte_len={:?} message={}",
                diag.code, diag.byte_offset, diag.byte_len, diag.message
            );
        }
    }
    Ok(())
}

fn probe_gameexe_ini(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    println!("=== Gameexe.ini probe: {path} ===");
    let bytes = fs::read(path)?;
    println!("file bytes: {}", bytes.len());
    let report = parse_gameexe_inventory(&bytes);
    let total = report.entries.len();
    let bridge = report
        .entries
        .iter()
        .filter(|e| e.treatment == GameexeKeyTreatment::BridgeUnit)
        .count();
    let asset = report
        .entries
        .iter()
        .filter(|e| e.treatment == GameexeKeyTreatment::AssetReference)
        .count();
    let config = report
        .entries
        .iter()
        .filter(|e| e.treatment == GameexeKeyTreatment::Config)
        .count();
    let unknown = report
        .entries
        .iter()
        .filter(|e| e.treatment == GameexeKeyTreatment::Unknown)
        .count();
    println!(
        "parse_gameexe_inventory: entries={} bridge={} asset_ref={} config={} unknown={} warnings={}",
        total,
        bridge,
        asset,
        config,
        unknown,
        report.warnings.len()
    );
    let pct = if total > 0 {
        100.0 * (unknown as f64) / (total as f64)
    } else {
        0.0
    };
    println!("unknown-key share: {pct:.1}%");
    let bridge_keys: Vec<&str> = report
        .entries
        .iter()
        .filter(|e| e.treatment == GameexeKeyTreatment::BridgeUnit)
        .map(|e| e.key.as_str())
        .collect();
    let asset_keys: Vec<&str> = report
        .entries
        .iter()
        .filter(|e| e.treatment == GameexeKeyTreatment::AssetReference)
        .take(8)
        .map(|e| e.key.as_str())
        .collect();
    println!("bridge keys: {bridge_keys:?}");
    println!("first asset-ref keys: {asset_keys:?}");
    Ok(())
}
