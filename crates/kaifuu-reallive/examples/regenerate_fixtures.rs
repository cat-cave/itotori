//! Generator for the KAIFUU-173 / KAIFUU-188 synthetic fixtures.
//!
//! Run with `cargo run -p kaifuu-reallive --example regenerate_fixtures`
//! from inside the nix devshell to refresh the committed bytes under
//! `crates/kaifuu-reallive/tests/fixtures/`. The committed bytes are the
//! source of truth for CI; this binary is a developer-facing
//! regeneration tool only.
//!
//! All fixtures use the real RealLive 10,000-slot fixed-offset-table
//! envelope (KAIFUU-188). The single populated scene sits at slot 1
//! (`reallive:scene-0001`), mirroring Sweetie HD's first-scene layout.

use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN;

const SLOT: u16 = 1;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures");

    write_seen(&base, "smoke-scene-001", &smoke_scene_001())?;
    write_seen(&base, "truncated-scene-001", &truncated_scene_001())?;
    write_seen(&base, "unknown-opcode-001", &unknown_opcode_001())?;
    write_seen(&base, "patchback-identity-001", &baseline_archive())?;
    write_seen(
        &base,
        "patchback-length-preserving-001",
        &baseline_archive(),
    )?;
    write_seen(&base, "patchback-overflow-001", &baseline_archive())?;
    write_seen(&base, "protected-spans-001", &protected_spans_001())?;
    write_seen(&base, "bridge-inventory-001", &bridge_inventory_001())?;

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

fn baseline_archive() -> Vec<u8> {
    let mut scene = Vec::new();
    scene.extend(instruction(0x02, &[string_operand(b"Aoi")]));
    scene.extend(instruction(0x01, &[string_operand(b"Hello!")]));
    scene.extend(instruction(
        0x03,
        &[string_operand(b"Yes"), string_operand(b"No")],
    ));
    single_scene_archive(&scene)
}

fn protected_spans_001() -> Vec<u8> {
    let mut dialogue = Vec::new();
    dialogue.extend_from_slice(&[0x1f, 0x03]);
    dialogue.extend_from_slice(b"H");
    dialogue.extend_from_slice(&[0x0d]);
    dialogue.extend_from_slice(b"base");
    dialogue.extend_from_slice(&[0x0a]);
    dialogue.extend_from_slice(b"ruby");
    dialogue.extend_from_slice(&[0x09]);
    dialogue.extend_from_slice(&[0x02, 0x01]);
    dialogue.extend_from_slice(&[0x1e, 0x05]);
    dialogue.extend_from_slice(&[0x10, 0x60]);
    dialogue.extend_from_slice(&[0x0c]);
    dialogue.extend_from_slice(&[0x0a]);
    dialogue.extend_from_slice(b"\\{0\\}");
    dialogue.extend_from_slice(b"\\\\character");
    dialogue.extend_from_slice(&[0x05]);
    dialogue.extend_from_slice(b"end");
    let mut scene = Vec::new();
    scene.extend(instruction(0x02, &[string_operand(b"Speaker")]));
    scene.extend(instruction(0x01, &[string_operand(&dialogue)]));
    single_scene_archive(&scene)
}

fn bridge_inventory_001() -> Vec<u8> {
    let mut scene = Vec::new();
    scene.extend(instruction(0x02, &[string_operand(b"Aoi")]));
    scene.extend(instruction(0x01, &[string_operand(b"Hello!")]));
    scene.extend(instruction(
        0x03,
        &[string_operand(b"Yes"), string_operand(b"No")],
    ));
    scene.extend(instruction(0x01, &[string_operand(b"bg/sample.g00")]));
    single_scene_archive(&scene)
}

fn single_scene_archive(scene: &[u8]) -> Vec<u8> {
    let directory_byte_len = REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let payload_offset = directory_byte_len as u32;
    let mut out = vec![0u8; directory_byte_len + scene.len()];
    let slot_byte_offset = (SLOT as usize) * 8;
    out[slot_byte_offset..slot_byte_offset + 4].copy_from_slice(&payload_offset.to_le_bytes());
    out[slot_byte_offset + 4..slot_byte_offset + 8]
        .copy_from_slice(&(scene.len() as u32).to_le_bytes());
    out[directory_byte_len..].copy_from_slice(scene);
    out
}

fn truncated_archive(declared_size: u32, actual_payload: &[u8]) -> Vec<u8> {
    let directory_byte_len = REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let payload_offset = directory_byte_len as u32;
    let mut out = vec![0u8; directory_byte_len + actual_payload.len()];
    let slot_byte_offset = (SLOT as usize) * 8;
    out[slot_byte_offset..slot_byte_offset + 4].copy_from_slice(&payload_offset.to_le_bytes());
    out[slot_byte_offset + 4..slot_byte_offset + 8].copy_from_slice(&declared_size.to_le_bytes());
    out[directory_byte_len..].copy_from_slice(actual_payload);
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
