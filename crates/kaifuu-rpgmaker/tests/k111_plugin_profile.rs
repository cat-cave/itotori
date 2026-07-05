//! KAIFUU-111 — MV/MZ PLUGIN-owned text via declared plugin profiles.
//!
//! Drives the KAIFUU-111 slice against a committed **synthetic public**
//! `plugins.js` fixture (`tests/fixtures/k111/plugins.js`; MV/MZ-shaped,
//! authored English, no copyrighted plugin code/data) and proves:
//!
//! 1. Text is extracted ONLY at the DECLARED profile pointers as stable units
//!    carrying every acceptance field; config/numeric params at undeclared
//!    pointers are never surfaced.
//! 2. A trivial patch changes ONLY the declared plugin-parameter literals — a
//!    byte-level locality proof shows every other byte (the `var $plugins =`
//!    prefix, the trailing `;`, structure, undeclared params, whitespace) is
//!    identical, and an untranslated patch is a byte-identical no-op.
//! 3. A plugin WITHOUT a declared profile that carries string params reports a
//!    typed `unsupported_plugin_profile` diagnostic — not extracted, not
//!    silently skipped, not a blind all-strings sweep. An empty (text-free)
//!    profile suppresses the diagnostic (the honest "no translatable text"
//!    declaration).
//! 4. A declared pointer at a non-text (numeric) value, or one that does not
//!    resolve, is rejected with a typed diagnostic. The profile output records
//!    plugin id + version + fixture-hash + parameter pointers. Missing /
//!    malformed `plugins.js` are typed errors before any write.

use std::path::PathBuf;

use kaifuu_rpgmaker::{
    Patchability, PluginDiagnosticKind, PluginExtractError, PluginParamPointer, PluginProfile,
    PluginTextRole, PluginTranslation, Scanner, StablePluginTextUnit,
    encode_json_string_ascii_safe, extract_plugin_units, extract_plugins_file, patch_plugins_file,
};
use serde_json::Value;

/// Resolve this crate's manifest directory for locating tracked test fixtures.
///
/// `env!("CARGO_MANIFEST_DIR")` is baked at COMPILE time, so a test binary
/// reused from a different (since-removed) worktree would point fixture reads at
/// a dead path (`Os NotFound`). `cargo test` sets `CARGO_MANIFEST_DIR` in the
/// RUNTIME environment to the LIVE crate directory; prefer that, falling back to
/// the compile-time constant only outside cargo.
fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn fixture_dir() -> PathBuf {
    test_manifest_dir().join("tests/fixtures/k111")
}

fn plugins_js() -> Vec<u8> {
    std::fs::read(fixture_dir().join("plugins.js")).expect("read plugins.js fixture")
}

fn translate(source: &str) -> String {
    format!("\u{8a33}:{source}")
}

/// The declared profiles for the fixture: MessageBox + NameInput carry text
/// pointers; CoreEngine is an intentionally-empty (text-free) profile;
/// QuestLog has NO profile at all.
fn profiles() -> Vec<PluginProfile> {
    vec![
        PluginProfile {
            plugin_name: "MessageBox".to_string(),
            plugin_id: "com.example.MessageBox".to_string(),
            plugin_version: Some("1.2.0".to_string()),
            params: vec![
                PluginParamPointer {
                    pointer: vec!["windowTitle".to_string()],
                    text_role: PluginTextRole::UiLabel,
                    patchability: Patchability::Patchable,
                },
                PluginParamPointer {
                    pointer: vec!["okButton".to_string()],
                    text_role: PluginTextRole::UiLabel,
                    patchability: Patchability::Patchable,
                },
                PluginParamPointer {
                    pointer: vec!["cancelButton".to_string()],
                    text_role: PluginTextRole::UiLabel,
                    patchability: Patchability::Patchable,
                },
            ],
        },
        PluginProfile {
            plugin_name: "NameInput".to_string(),
            plugin_id: "com.example.NameInput".to_string(),
            plugin_version: None,
            params: vec![PluginParamPointer {
                pointer: vec!["prompt".to_string()],
                text_role: PluginTextRole::Message,
                patchability: Patchability::Patchable,
            }],
        },
        // Empty profile: declares CoreEngine has NO translatable text, which
        // suppresses the unsupported-profile diagnostic for its numeric params.
        PluginProfile {
            plugin_name: "CoreEngine".to_string(),
            plugin_id: "com.example.CoreEngine".to_string(),
            plugin_version: Some("3.0".to_string()),
            params: vec![],
        },
    ]
}

fn extract() -> kaifuu_rpgmaker::PluginExtraction {
    extract_plugins_file(&fixture_dir().join("plugins.js"), &profiles())
        .expect("extract plugins.js")
}

// ---------------------------------------------------------------------------
// 1. Declared-only extraction with all acceptance fields
// ---------------------------------------------------------------------------

#[test]
fn only_declared_pointers_extract_with_all_fields() {
    let out = extract();
    let keys: Vec<String> = out
        .units
        .iter()
        .map(StablePluginTextUnit::source_unit_key)
        .collect();
    assert_eq!(
        keys,
        vec![
            "rpgmaker:plugins.js#/0/parameters/windowTitle",
            "rpgmaker:plugins.js#/0/parameters/okButton",
            "rpgmaker:plugins.js#/0/parameters/cancelButton",
            "rpgmaker:plugins.js#/1/parameters/prompt",
        ],
        "only the DECLARED pointers extract; maxWidth/frameColor/charSet/maxChars do not",
    );
    for unit in &out.units {
        assert_eq!(unit.source_file, "plugins.js");
        assert_eq!(unit.fixture_profile_id, "KAIFUU-111");
        assert!(!unit.plugin_id.is_empty());
        assert!(!unit.bridge_unit_id().is_empty());
        assert_eq!(unit.patchability, Patchability::Patchable);
    }
    // Undeclared config/numeric params are never surfaced.
    assert!(!out.units.iter().any(|u| u.param_pointer == ["maxWidth"]
        || u.param_pointer == ["frameColor"]
        || u.param_pointer == ["charSet"]));
    // Deterministic re-extraction.
    let again = extract();
    assert_eq!(out.units, again.units);
    assert_eq!(
        out.units[0].bridge_unit_id(),
        again.units[0].bridge_unit_id()
    );
}

#[test]
fn profile_output_records_id_version_hash_and_pointers() {
    let out = extract();
    // MessageBox, NameInput, CoreEngine are profiled (QuestLog is not).
    let names: Vec<&str> = out
        .profiled
        .iter()
        .map(|p| p.plugin_name.as_str())
        .collect();
    assert_eq!(names, vec!["MessageBox", "NameInput", "CoreEngine"]);

    let mb = out
        .profiled
        .iter()
        .find(|p| p.plugin_name == "MessageBox")
        .unwrap();
    assert_eq!(mb.plugin_id, "com.example.MessageBox");
    assert_eq!(mb.declared_version.as_deref(), Some("1.2.0"));
    assert!(
        mb.fixture_hash.starts_with("sha256:"),
        "fixture hash pins the extracted plugin"
    );
    assert_eq!(
        mb.extracted_pointers,
        vec!["/windowTitle", "/okButton", "/cancelButton"],
        "records the declared parameter pointers that yielded text",
    );
    // The empty (text-free) CoreEngine profile is recorded with no pointers.
    let ce = out
        .profiled
        .iter()
        .find(|p| p.plugin_name == "CoreEngine")
        .unwrap();
    assert!(ce.extracted_pointers.is_empty());
    assert_eq!(ce.declared_version.as_deref(), Some("3.0"));
}

// ---------------------------------------------------------------------------
// 2. Byte-preserving patch (only declared literals change)
// ---------------------------------------------------------------------------

/// Locate each unit's literal span in the FULL plugins.js file by offsetting
/// the `$plugins` array (which the Scanner navigates from its `[`).
fn located_targets(
    original: &[u8],
    units: &[StablePluginTextUnit],
) -> Vec<(usize, usize, Vec<u8>)> {
    let array_start = original
        .iter()
        .position(|&b| b == b'[')
        .expect("array opener");
    let array_bytes = &original[array_start..];
    let mut out: Vec<(usize, usize, Vec<u8>)> = units
        .iter()
        .map(|u| {
            let mut scanner = Scanner::new(array_bytes);
            let span = scanner
                .locate(&u.pointer)
                .unwrap_or_else(|e| panic!("locate {}: {e}", u.source_unit_key()));
            let encoded = encode_json_string_ascii_safe(&translate(&u.source_text)).into_bytes();
            (span.start + array_start, span.end + array_start, encoded)
        })
        .collect();
    out.sort_by_key(|(start, ..)| *start);
    out
}

/// Every byte OUTSIDE the declared literals is identical; each declared literal
/// became exactly its encoded target. (Mirrors the KAIFUU-110 locality proof.)
fn verify_only_declared_changed(
    original: &[u8],
    patched: &[u8],
    spans: &[(usize, usize, Vec<u8>)],
) -> Result<(), String> {
    let mut oi = 0usize;
    let mut pi = 0usize;
    for (idx, (start, end, encoded)) in spans.iter().enumerate() {
        let seg = start - oi;
        let (o_seg, p_seg) = (
            original.get(oi..*start).ok_or("original seg oob")?,
            patched.get(pi..pi + seg).ok_or("patched seg oob")?,
        );
        if o_seg != p_seg {
            return Err(format!("non-declared byte drift before literal {idx}"));
        }
        pi += seg;
        let p_lit = patched
            .get(pi..pi + encoded.len())
            .ok_or("patched literal oob")?;
        if p_lit != encoded.as_slice() {
            return Err(format!("declared literal {idx} is not its target"));
        }
        pi += encoded.len();
        oi = *end;
    }
    if original.get(oi..) != patched.get(pi..) {
        return Err("non-declared byte drift after last literal".to_string());
    }
    Ok(())
}

#[test]
fn trivial_patch_changes_only_declared_plugin_text() {
    let bytes = plugins_js();
    let out = extract();
    let translations: Vec<PluginTranslation> = out
        .units
        .iter()
        .map(|u| PluginTranslation {
            unit: u,
            target_text: translate(&u.source_text),
        })
        .collect();
    let patched = patch_plugins_file("plugins.js", &bytes, &translations).expect("patch");
    assert_ne!(patched, bytes, "a real translation changes bytes");

    let spans = located_targets(&bytes, &out.units);
    verify_only_declared_changed(&bytes, &patched, &spans)
        .unwrap_or_else(|e| panic!("byte locality: {e}"));

    // The prefix (`…var $plugins =`) and the trailing `;` suffix are verbatim.
    let astart = bytes.iter().position(|&b| b == b'[').unwrap();
    assert_eq!(&patched[..astart], &bytes[..astart], "prefix preserved");
    assert!(patched.ends_with(b"];\n"), "suffix preserved");

    // Re-extracting the patched file yields the translated declared text and
    // leaves undeclared params untouched.
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("plugins.js");
    std::fs::write(&path, &patched).unwrap();
    let re = extract_plugins_file(&path, &profiles()).expect("re-extract patched");
    assert_eq!(re.units.len(), out.units.len());
    assert!(
        re.units
            .iter()
            .all(|u| u.source_text.starts_with('\u{8a33}')),
        "declared text is now translated",
    );
    // Undeclared MessageBox config params are still their originals.
    let array_start = patched.iter().position(|&b| b == b'[').unwrap();
    let array: Value = {
        let end = patched.iter().rposition(|&b| b == b']').unwrap();
        serde_json::from_slice(&patched[array_start..=end]).unwrap()
    };
    assert_eq!(array[0]["parameters"]["maxWidth"], "816");
    assert_eq!(array[0]["parameters"]["frameColor"], "#3355aa");
}

#[test]
fn untranslated_patch_is_byte_identical_noop() {
    let bytes = plugins_js();
    let out = extract();
    let translations: Vec<PluginTranslation> = out
        .units
        .iter()
        .map(|u| PluginTranslation {
            unit: u,
            target_text: u.source_text.clone(), // target == source
        })
        .collect();
    let patched = patch_plugins_file("plugins.js", &bytes, &translations).expect("noop patch");
    assert_eq!(patched, bytes, "untranslated patch must be byte-identical");
}

#[test]
fn dropping_a_declared_unit_is_detectable() {
    let bytes = plugins_js();
    let out = extract();
    assert!(out.units.len() >= 2);
    // Translate all but the last declared unit.
    let translations: Vec<PluginTranslation> = out.units[..out.units.len() - 1]
        .iter()
        .map(|u| PluginTranslation {
            unit: u,
            target_text: translate(&u.source_text),
        })
        .collect();
    let patched = patch_plugins_file("plugins.js", &bytes, &translations).expect("patch");

    let dropped = out.units.last().unwrap();
    let array_start = patched.iter().position(|&b| b == b'[').unwrap();
    let mut scanner = Scanner::new(&patched[array_start..]);
    let span = scanner
        .locate(&dropped.pointer)
        .expect("dropped unit resolves");
    let on_disk = Scanner::decode_span(&patched[array_start..], span).unwrap();
    assert_eq!(
        on_disk, dropped.source_text,
        "dropped unit left untranslated"
    );
    assert_ne!(on_disk, translate(&dropped.source_text));
}

// ---------------------------------------------------------------------------
// 3. Diagnostics for unprofiled plugin text
// ---------------------------------------------------------------------------

#[test]
fn unprofiled_plugin_reports_typed_diagnostic_not_a_sweep() {
    let out = extract();
    // QuestLog has string params (menuLabel/emptyText) but NO profile.
    let questlog: Vec<_> = out
        .diagnostics
        .iter()
        .filter(|d| {
            d.kind == PluginDiagnosticKind::UnsupportedPluginProfile
                && d.plugin_name.as_deref() == Some("QuestLog")
        })
        .collect();
    assert_eq!(
        questlog.len(),
        1,
        "exactly ONE diagnostic per unprofiled plugin — not one per string param",
    );
    // No QuestLog text was extracted.
    assert!(!out.units.iter().any(|u| u.plugin_index == 2));
    // CoreEngine (empty profile) is NOT flagged despite numeric string params.
    assert!(
        !out.diagnostics
            .iter()
            .any(|d| d.plugin_name.as_deref() == Some("CoreEngine")),
        "an empty (text-free) profile suppresses the diagnostic",
    );
}

#[test]
fn declared_pointer_to_nontext_or_missing_is_rejected() {
    // A profile that mis-declares a pointer at a numeric value and at a
    // missing key — both rejected, neither extracted.
    let profile = PluginProfile {
        plugin_name: "Bad".to_string(),
        plugin_id: "bad".to_string(),
        plugin_version: None,
        params: vec![
            PluginParamPointer {
                pointer: vec!["count".to_string()],
                text_role: PluginTextRole::Caption,
                patchability: Patchability::Patchable,
            },
            PluginParamPointer {
                pointer: vec!["ghost".to_string()],
                text_role: PluginTextRole::Caption,
                patchability: Patchability::Patchable,
            },
        ],
    };
    let plugins = serde_json::json!([
        {"name": "Bad", "status": true, "parameters": {"count": 7}}
    ]);
    let out = extract_plugin_units("plugins.js", &plugins, &[profile]);
    assert!(
        out.units.is_empty(),
        "non-text/missing declared pointers not extracted"
    );
    assert_eq!(out.diagnostics.len(), 2);
    assert!(
        out.diagnostics
            .iter()
            .all(|d| d.kind == PluginDiagnosticKind::UnsupportedDeclaredPointer)
    );
}

// ---------------------------------------------------------------------------
// 4. Typed file-level errors
// ---------------------------------------------------------------------------

#[test]
fn missing_plugins_js_is_a_typed_error() {
    let err = extract_plugins_file(&fixture_dir().join("does-not-exist.js"), &profiles())
        .expect_err("missing file is a typed error");
    assert!(matches!(err, PluginExtractError::MissingFile { .. }));
}

#[test]
fn plugins_js_without_the_array_is_a_typed_error() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("plugins.js");
    std::fs::write(&path, b"// no assignment here\nconsole.log('hi');\n").unwrap();
    let err =
        extract_plugins_file(&path, &profiles()).expect_err("no $plugins array is a typed error");
    assert!(matches!(err, PluginExtractError::MalformedPluginsJs { .. }));
}
