//! Generator for the / synthetic fixtures.
//! Run with `cargo run -p kaifuu-reallive --example regenerate_fixtures`
//! from inside the nix devshell to refresh the committed bytes under
//! `crates/kaifuu-reallive/tests/fixtures/`. The committed bytes are the
//! source of truth for CI; this binary is a developer-facing
//! regeneration tool only.
//! All fixtures use the real RealLive 10,000-slot fixed-offset-table
//! envelope. The single populated scene sits at slot 1
//! (`reallive:scene-0001`), mirroring Sweetie HD's first-scene layout.

use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_reallive::{
    REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, SCENE_HEADER_BYTE_LEN, compress_avg32_literal,
};

const SLOT: u16 = 1;

/// Resolve this crate's manifest directory for locating the tracked fixtures
/// tree this generator (re)writes.
/// `env!("CARGO_MANIFEST_DIR")` is baked at COMPILE time, so an example binary
/// reused from a different (since-removed) worktree would target a dead path.
/// `cargo run --example` sets `CARGO_MANIFEST_DIR` in the RUNTIME environment to
/// the LIVE crate directory of the current invocation; prefer that, falling back
/// to the compile-time constant only when run outside cargo.
fn manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base = manifest_dir().join("tests").join("fixtures");

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
    // adapter-unify: the scene bytecode is authored in the REAL
    // post- byte shape decoded by `parse_real_bytecode` (8-byte
    // `CommandElement` headers + inline Shift-JIS Textout runs + a
    // `module_sel` `{ … }` SelectElement block), the same shape
    // `kaifuu-cli::binary_patch_smoke::synthetic_scene_bytecode` uses.
    // Unified adapter path: `extract` and `patch` BOTH parse a `SceneHeader`,
    // AVG32-decompress the bytecode, and walk it through
    // `bridge::produce_bundle` (deterministic bridgeUnitIds). The slot payload
    // is therefore a real `SceneHeader` (0x1d0 bytes) followed by the
    // AVG32-LZSS-compressed bytecode — NOT the raw decompressed stream.
    // The scene exercises the two translatable alpha string surfaces the
    // `produce_bundle` walk emits:
    // - Textout (inline "Hello") → dialogue
    // - Choice (module_sel opcode 0, `{ "Yes" \n "No" \n }`) → choice_label
    // (SetSpeaker/TextDisplay/End are structural commands carried verbatim;
    // the speaker is embedded on the dialogue unit's speaker field, not a
    // separate surface.) The dialogue run cannot contain a structural-opener
    // byte (`0x00 0x0A 0x21 0x23 0x24 0x2C 0x40`) — `0x21` ('!') would
    // terminate the Textout run — so the readable dialogue is "Hello" (no
    // trailing bang), which is what the real decoder yields.
    let mut bytecode = Vec::new();
    bytecode.extend_from_slice(&command_header(MODULE_TYPE_KEPAGO, MODULE_MSG, 3, 0)); // SetSpeaker
    bytecode.extend_from_slice(b"Hello"); // Textout dialogue run
    bytecode.extend_from_slice(&command_header(MODULE_TYPE_KEPAGO, MODULE_MSG, 10, 0)); // TextDisplay
    bytecode.extend_from_slice(&command_header(MODULE_TYPE_SEL, MODULE_SEL, 0, 0)); // Choice select_w
    bytecode.push(0x7B); // '{' SelectElement block open
    bytecode.extend_from_slice(b"Yes");
    bytecode.extend_from_slice(&[0x0A, 0x00, 0x00]); // \n + i16 line marker
    bytecode.extend_from_slice(b"No");
    bytecode.extend_from_slice(&[0x0A, 0x00, 0x00]); // \n + i16 line marker
    bytecode.push(0x7D); // '}' SelectElement block close
    bytecode.extend_from_slice(&command_header(MODULE_TYPE_KEPAGO, MODULE_SYS, 17, 0)); // End
    single_scene_archive(&scene_header_wrapped(&bytecode))
}

/// Wrap raw decompressed `bytecode` in a real `SceneHeader` (0x1d0 bytes) +
/// AVG32-LZSS-compressed bytecode, matching the shape `SceneHeader::parse` +
/// `decompress_avg32` expect. `compiler_version` is a non-`xor_2` value
/// (Sweetie HD's `110002` triggers the second-level cipher; `10002` does
/// not), so the synthetic scene decompresses to plaintext bytecode directly.
fn scene_header_wrapped(bytecode: &[u8]) -> Vec<u8> {
    let compressed = compress_avg32_literal(bytecode).expect("synthetic bytecode compresses");
    let header_len = SCENE_HEADER_BYTE_LEN;
    let mut blob = vec![0u8; header_len];
    // header_size at 0x00 (informational).
    blob[0x00..0x04].copy_from_slice(&(header_len as u32).to_le_bytes());
    // compiler_version at 0x04 (non-xor_2).
    blob[0x04..0x08].copy_from_slice(&10002u32.to_le_bytes());
    // kidoku_offset at 0x08 (empty kidoku table, sits at bytecode start).
    blob[0x08..0x0c].copy_from_slice(&(header_len as u32).to_le_bytes());
    // kidoku_count at 0x0c (0 — no read-tracking table entries).
    blob[0x0c..0x10].copy_from_slice(&0u32.to_le_bytes());
    // bytecode_offset at 0x20 (immediately after the header).
    blob[0x20..0x24].copy_from_slice(&(header_len as u32).to_le_bytes());
    // bytecode_uncompressed_size at 0x24.
    blob[0x24..0x28].copy_from_slice(&(bytecode.len() as u32).to_le_bytes());
    // bytecode_compressed_size at 0x28.
    blob[0x28..0x2c].copy_from_slice(&(compressed.len() as u32).to_le_bytes());
    blob.extend_from_slice(&compressed);
    blob
}

// module_type 1 = Kepago RLOperation namespace (msg / sys); the select /
// Choice family lives in module_type 0, module_id 2 (`module_sel`). Module
// ids per the documented rlvm `module_*.cc` catalogue (research anchor only).
const MODULE_TYPE_KEPAGO: u8 = 1;
const MODULE_TYPE_SEL: u8 = 0;
const MODULE_MSG: u8 = 3;
const MODULE_SEL: u8 = 2;
const MODULE_SYS: u8 = 4;

/// An 8-byte real `CommandElement` header (rlvm `bytecode.h:CommandElement`
/// — research anchor only): `0x23`, module_type, module_id, opcode_u16_le
/// (lo, hi), argc, overload, reserved.
fn command_header(module_type: u8, module_id: u8, opcode: u16, argc: u8) -> [u8; 8] {
    let [op_lo, op_hi] = opcode.to_le_bytes();
    [0x23, module_type, module_id, op_lo, op_hi, argc, 0x00, 0x00]
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
