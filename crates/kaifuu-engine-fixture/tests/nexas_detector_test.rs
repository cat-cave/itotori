//! Synthetic NeXAS-vs-Softpal detector discrimination proof.
//! The `.pac` extension is shared by two unrelated engines whose container
//! magics differ only in their 4th byte: NeXAS `"PAC\0"` (`50 41 43 00`) and
//! Softpal `"PAC "` (`50 41 43 20`). This test builds tiny synthetic game
//! directories (no copyrighted bytes — just container headers + well-known
//! file names) and proves, both per-adapter and through the registry, that:
//! * a NeXAS `"PAC\0"` layout detects as `kaifuu.nexas` and NOT as
//!   `kaifuu.softpal`, and
//! * a Softpal `"PAC "` / Pal.dll layout detects as `kaifuu.softpal` and NOT as
//!   `kaifuu.nexas`.

use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_core::{DetectRequest, EngineAdapter};
use kaifuu_engine_fixture::{NexasProfileDetectorAdapter, SoftpalProfileDetectorAdapter, registry};

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kaifuu-nexas-detector-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Minimal NeXAS `.pac`: `"PAC\0"` magic + u32 count @0x04 + u32 pack_type
/// @0x08, then a little payload so the file is a plausible archive.
fn nexas_pac(count: u32, pack_type: u32) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(b"PAC\0");
    buf.extend_from_slice(&count.to_le_bytes());
    buf.extend_from_slice(&pack_type.to_le_bytes());
    buf.extend_from_slice(&[0u8; 32]);
    buf
}

/// Minimal Softpal `.pac`: `"PAC "` magic + u32 count @0x08, then the
/// `SCRIPT.SRC` / `TEXT.DAT` entry names the Softpal detector looks for.
fn softpal_pac(count: u32) -> Vec<u8> {
    let mut buf = vec![0u8; 12];
    buf[0..4].copy_from_slice(b"PAC ");
    buf[8..12].copy_from_slice(&count.to_le_bytes());
    buf.extend_from_slice(b"SCRIPT.SRC\0");
    buf.extend_from_slice(b"TEXT.DAT\0");
    buf
}

fn detect_id(adapter: &dyn EngineAdapter, dir: &Path) -> Option<String> {
    let result = adapter
        .detect(DetectRequest { game_dir: dir })
        .expect("detect must not error");
    result.detected.then_some(result.adapter_id)
}

#[test]
fn nexas_dir_detects_as_nexas_not_softpal() {
    let dir = temp_dir("nexas-dir");
    // Majikoi-shaped category archives, all NeXAS "PAC\0" magic.
    for (name, count) in [
        ("System.pac", 19u32),
        ("Script.pac", 27),
        ("Voice.pac", 500),
    ] {
        fs::write(dir.join(name), nexas_pac(count, 3)).unwrap();
    }

    assert_eq!(
        detect_id(&NexasProfileDetectorAdapter, &dir).as_deref(),
        Some("kaifuu.nexas"),
        "NeXAS PAC\\0 layout must detect as NeXAS"
    );
    assert_eq!(
        detect_id(&SoftpalProfileDetectorAdapter, &dir),
        None,
        "NeXAS PAC\\0 layout must NOT trip the Softpal detector"
    );

    // Registry-level: the single detected adapter is NeXAS.
    let reg = registry();
    let detected = reg.detect(&dir).unwrap().expect("a NeXAS adapter detects");
    assert_eq!(detected.adapter_id, "kaifuu.nexas");
    assert_eq!(detected.engine_family.as_deref(), Some("nexas"));
    let all: Vec<_> = reg
        .detect_all(&dir)
        .unwrap()
        .into_iter()
        .filter(|d| d.detected)
        .map(|d| d.adapter_id)
        .collect();
    assert_eq!(all, vec!["kaifuu.nexas".to_string()]);
}

#[test]
fn softpal_dir_detects_as_softpal_not_nexas() {
    let dir = temp_dir("softpal-dir");
    // A genuine Softpal (Crystalia-style) layout: "PAC " magic + Pal.dll.
    fs::write(dir.join("data.pac"), softpal_pac(2)).unwrap();
    fs::create_dir_all(dir.join("dll")).unwrap();
    fs::write(dir.join("dll").join("Pal.dll"), b"MZ\0\0softpal engine").unwrap();

    assert_eq!(
        detect_id(&SoftpalProfileDetectorAdapter, &dir).as_deref(),
        Some("kaifuu.softpal"),
        "Softpal PAC-space / Pal.dll layout must detect as Softpal"
    );
    assert_eq!(
        detect_id(&NexasProfileDetectorAdapter, &dir),
        None,
        "Softpal PAC \"PAC \" magic must NOT trip the NeXAS detector"
    );

    let all: Vec<_> = registry()
        .detect_all(&dir)
        .unwrap()
        .into_iter()
        .filter(|d| d.detected)
        .map(|d| d.adapter_id)
        .collect();
    assert_eq!(all, vec!["kaifuu.softpal".to_string()]);
}

#[test]
fn bare_pac_nul_magic_with_insane_header_is_not_detected() {
    // "PAC\0" magic but a garbage count => diagnostic only, never `detected`.
    let dir = temp_dir("insane-header");
    let mut pac = nexas_pac(0, 3); // count 0 is out of range
    pac[4..8].copy_from_slice(&0u32.to_le_bytes());
    fs::write(dir.join("weird.pac"), pac).unwrap();

    assert_eq!(
        detect_id(&NexasProfileDetectorAdapter, &dir),
        None,
        "a bare PAC\\0 magic with an insane header must not be detected"
    );
}
