//! Generator for the KAIFUU-173 synthetic fixtures.
//!
//! Run with `cargo run -p kaifuu-reallive --example regenerate_fixtures`
//! from inside the nix devshell to refresh the committed bytes under
//! `crates/kaifuu-reallive/tests/fixtures/`. The committed bytes are the
//! source of truth for CI; this binary is a developer-facing
//! regeneration tool only.

use std::fs;
use std::path::{Path, PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures");

    write_seen(&base, "smoke-scene-001", &smoke_scene_001())?;
    write_seen(&base, "truncated-scene-001", &truncated_scene_001())?;
    write_seen(&base, "unknown-opcode-001", &unknown_opcode_001())?;

    println!("regenerated fixtures under {}", base.display());
    Ok(())
}

fn write_seen(base: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    let dir = base.join(name);
    fs::create_dir_all(&dir)?;
    let path = dir.join("SEEN.TXT");
    fs::write(&path, bytes)?;
    println!("wrote {} ({} bytes)", path.display(), bytes.len());
    Ok(())
}

fn smoke_scene_001() -> Vec<u8> {
    let mut scene = Vec::new();
    scene.extend(instruction(0x02, &[string_operand(b"Aoi")]));
    scene.extend(instruction(0x01, &[string_operand(b"Hello!")]));
    scene.extend(instruction(
        0x03,
        &[string_operand(b"Yes"), string_operand(b"No")],
    ));
    scene.extend(instruction(0x08, &[]));
    single_scene_archive(&scene)
}

fn truncated_scene_001() -> Vec<u8> {
    let payload = vec![0x23u8, 0x01];
    truncated_archive(20, &payload)
}

fn unknown_opcode_001() -> Vec<u8> {
    let mut scene = Vec::new();
    scene.extend(instruction(0x01, &[string_operand(b"Hi")]));
    scene.push(0x55);
    scene.extend(instruction(0x01, &[string_operand(b"Bye")]));
    single_scene_archive(&scene)
}

fn single_scene_archive(scene: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&12u32.to_le_bytes());
    out.extend_from_slice(&(scene.len() as u32).to_le_bytes());
    out.extend_from_slice(scene);
    out
}

fn truncated_archive(declared_size: u32, actual_payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&12u32.to_le_bytes());
    out.extend_from_slice(&declared_size.to_le_bytes());
    out.extend_from_slice(actual_payload);
    out
}

fn instruction(opcode: u8, operands: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(0x23);
    out.push(opcode);
    out.push(operands.len() as u8);
    for operand in operands {
        out.extend_from_slice(operand);
    }
    out
}

fn string_operand(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(0x73);
    out.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(bytes);
    out
}
