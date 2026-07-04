//! KAIFUU-112 — MV/MZ JSON full-surface golden integration.
//!
//! Drives the full-surface integration against a committed **synthetic public
//! golden** MV/MZ project tree (`tests/fixtures/k112/www/…`; MV/MZ-shaped,
//! authored English, no retail bytes) and proves the KAIFUU-112 acceptance:
//!
//! 1. Extraction covers ALL SIX declared surfaces — maps, common-events,
//!    database, system, terms, and the plugin-profile — on the golden tree.
//! 2. A TRIVIAL patch round-trips through every declared JSON surface
//!    byte-correctly, and every `www/img` / `www/audio` media byte stays
//!    identical (only the declared JSON text changes).
//! 3. An unsupported plugin-owned text surface reports a profile + surface
//!    diagnostic (not a silent drop / not a crash / not a blind sweep).
//! 4. The integration emits a CAPABILITY TUPLE limited to MV/MZ JSON text +
//!    plugin-profile diagnostics — no overclaim of media / plugin-JS support.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_rpgmaker::{
    BridgeOpts, CapabilityLevel, FullSurfaceExtractionManifest, FullSurfacePatchManifest,
    MvMzCapabilityTuple, MvMzSurfaceRole, Patchability, PatchbackOpts, PluginParamPointer,
    PluginProfile, PluginTextRole, SCOPE_ENCRYPTED_MEDIA, SCOPE_JSON_TEXT, SCOPE_PLUGIN_JS_LOGIC,
    SCOPE_PLUGIN_PROFILE, extract_full_surface, extract_game_dir, patch_full_surface_trivial,
    trivial_target,
};

fn golden_www() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/k112/www")
}

fn opts() -> BridgeOpts<'static> {
    BridgeOpts {
        game_id: "rpgmaker-k112-golden",
        game_version: "test",
        source_profile_id: "kaifuu-rpgmaker-k112",
        source_locale: "ja-JP",
        extractor_name: "kaifuu-rpgmaker",
        extractor_version: "0.1.0",
    }
}

/// The declared plugin profiles for the golden `plugins.js`: MessageBox +
/// NameInput carry declared text; CoreEngine is an intentionally-empty
/// (text-free) profile; QuestLog has NO profile (→ diagnostic).
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
        PluginProfile {
            plugin_name: "CoreEngine".to_string(),
            plugin_id: "com.example.CoreEngine".to_string(),
            plugin_version: Some("3.0".to_string()),
            params: vec![],
        },
    ]
}

/// Recursively read a directory tree into a sorted `relative-path -> bytes`
/// map, for byte-equality comparison.
fn read_tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(rel, fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

/// Copy the golden tree into `dest` and add a synthetic (non-committed)
/// encrypted-media asset, so the "media byte-identical" proof has real media
/// bytes to guard. Returns the media file's relative path.
fn stage_www_with_media(dest: &Path) -> String {
    for (rel, bytes) in read_tree(&golden_www()) {
        let target = dest.join(&rel);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, &bytes).unwrap();
    }
    // A synthetic encrypted-image placeholder (NOT committed; runtime only).
    let media_rel = "img/pictures/Splash.rpgmvp";
    let media_path = dest.join(media_rel);
    fs::create_dir_all(media_path.parent().unwrap()).unwrap();
    fs::write(&media_path, b"RPGMV\0\x03synthetic-encrypted-media-bytes").unwrap();
    media_rel.to_string()
}

// ---------------------------------------------------------------------------
// 1. Full-surface extraction covers all six surfaces
// ---------------------------------------------------------------------------

#[test]
fn extraction_covers_all_six_surfaces() {
    let www = golden_www();
    let extraction =
        extract_full_surface(&www, &profiles(), &opts()).expect("full-surface extract");

    assert!(
        extraction.covers_all_surfaces(),
        "every declared surface must yield units; coverage: {:?}",
        extraction
            .coverage
            .iter()
            .map(|c| (c.role, c.unit_count))
            .collect::<Vec<_>>()
    );

    // Every one of the six roles is present exactly once with >= 1 unit.
    for role in MvMzSurfaceRole::all() {
        let cov = extraction
            .coverage
            .iter()
            .find(|c| c.role == role)
            .unwrap_or_else(|| panic!("role {role:?} present"));
        assert!(cov.unit_count > 0, "role {role:?} has units");
        assert_eq!(cov.surface_id, role.surface_id());
    }

    // Spot-check specific surface files feed their roles.
    let files_for = |role: MvMzSurfaceRole| {
        extraction
            .coverage
            .iter()
            .find(|c| c.role == role)
            .unwrap()
            .files
            .clone()
    };
    assert!(files_for(MvMzSurfaceRole::Maps).contains(&"Map001.json".to_string()));
    assert!(files_for(MvMzSurfaceRole::CommonEvents).contains(&"CommonEvents.json".to_string()));
    assert!(files_for(MvMzSurfaceRole::System).contains(&"System.json".to_string()));
    assert!(files_for(MvMzSurfaceRole::Terms).contains(&"System.json".to_string()));
    assert!(
        files_for(MvMzSurfaceRole::PluginProfileDiagnostics).contains(&"plugins.js".to_string())
    );
    let db_files = files_for(MvMzSurfaceRole::Database);
    assert!(db_files.contains(&"Actors.json".to_string()));
    assert!(db_files.contains(&"Items.json".to_string()));

    // Deterministic re-extraction.
    let again = extract_full_surface(&www, &profiles(), &opts()).expect("re-extract");
    assert_eq!(extraction.coverage, again.coverage);
}

// ---------------------------------------------------------------------------
// 1b. The extraction manifest is deterministic + retail-text-free
// ---------------------------------------------------------------------------

#[test]
fn extraction_manifest_is_deterministic_and_covers_all_surfaces() {
    let www = golden_www();
    let extraction = extract_full_surface(&www, &profiles(), &opts()).expect("extract");
    let manifest = extraction.extraction_manifest();

    assert!(manifest.covers_all_surfaces());
    assert_eq!(manifest.surfaces.len(), 6);
    assert_eq!(
        manifest.plugin_unit_count,
        extraction.plugins.units.len(),
        "manifest plugin count matches"
    );
    assert!(
        manifest.data_unit_count >= 8,
        "non-trivial data unit count, got {}",
        manifest.data_unit_count
    );

    // Round-trips through stable JSON.
    let json = manifest.stable_json().expect("stable json");
    assert!(json.ends_with('\n'));
    let parsed: FullSurfaceExtractionManifest = serde_json::from_str(&json).expect("round trip");
    assert_eq!(parsed, manifest);

    // Deterministic across runs.
    let again = extract_full_surface(&www, &profiles(), &opts())
        .unwrap()
        .extraction_manifest();
    assert_eq!(again.stable_json().unwrap(), json);

    // No retail text in the manifest: only structural keys/detail. The sample
    // surface keys are JSON-pointer ids (never source text), and finding /
    // diagnostic details are structural. Assert none of the source dialogue
    // text ("Welcome", "Onward") leaks into the serialized manifest.
    for forbidden in ["Welcome", "Onward", "Enter your name", "Public Potion"] {
        assert!(
            !json.contains(forbidden),
            "manifest must not leak source text ({forbidden})"
        );
    }
}

// ---------------------------------------------------------------------------
// 2. Trivial patch round-trips through every surface; media untouched
// ---------------------------------------------------------------------------

#[test]
fn trivial_patch_round_trips_all_surfaces_with_media_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let www = tmp.path().join("www");
    let media_rel = stage_www_with_media(&www);
    let source_tree = read_tree(&www);
    let media_source = source_tree[&media_rel].clone();

    let extraction = extract_full_surface(&www, &profiles(), &opts()).expect("extract");
    let patch = patch_full_surface_trivial(&www, &extraction, &PatchbackOpts::rpg_maker_default())
        .expect("trivial patch");
    let manifest: FullSurfacePatchManifest = patch.manifest.clone();

    // Every referenced JSON-text file (data files with units + plugins.js)
    // actually changed — a real, non-empty patch across all surfaces.
    assert!(
        manifest.all_declared_surfaces_changed,
        "every declared surface must change; files: {:?}",
        manifest
            .changed_files
            .iter()
            .map(|c| (c.file.clone(), c.changed))
            .collect::<Vec<_>>()
    );
    assert!(
        manifest
            .changed_files
            .iter()
            .any(|c| c.file == "plugins.js" && c.changed),
        "plugins.js is a changed surface"
    );

    // Media untouched: the staged encrypted-media placeholder is recorded
    // byte-identical, and its bytes on disk are unchanged (never written).
    assert!(
        manifest
            .media_untouched
            .iter()
            .any(|m| m.relative_path == media_rel && m.byte_identical),
        "the encrypted-media asset is recorded byte-identical"
    );
    assert!(!manifest.declined_media_globs.is_empty());

    // Materialize the patched tree: write patched data + plugins.js over a copy
    // of the source, then prove ONLY declared JSON text changed.
    let patched_www = tmp.path().join("patched-www");
    for (rel, bytes) in &source_tree {
        let target = patched_www.join(rel);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, bytes).unwrap();
    }
    for (file, bytes) in &patch.patched_data {
        fs::write(patched_www.join("data").join(file), bytes).unwrap();
    }
    fs::write(patched_www.join("js/plugins.js"), &patch.patched_plugins_js).unwrap();

    // Media byte-identical on disk.
    assert_eq!(
        fs::read(patched_www.join(&media_rel)).unwrap(),
        media_source,
        "media asset must be byte-identical after a full-surface patch"
    );

    // Non-translatable data file (MapInfos.json) is byte-identical.
    assert_eq!(
        fs::read(patched_www.join("data/MapInfos.json")).unwrap(),
        source_tree["data/MapInfos.json"],
        "a file with no translatable surface must be untouched"
    );

    // Re-extract the patched tree: every unit now carries its trivial target
    // at the same surface key (proves every surface stayed targetable and
    // round-trips byte-correctly).
    let re = extract_game_dir(&patched_www, &opts()).expect("re-extract patched data");
    for unit in &re.bundle.bundle.units {
        assert!(
            unit.source_text.starts_with('\u{8a33}'),
            "data surface {} did not round-trip its translation",
            unit.source_unit_key
        );
    }
    // Plugin-profile surface round-trips too.
    let re_plugins =
        kaifuu_rpgmaker::extract_plugins_file(&patched_www.join("js/plugins.js"), &profiles())
            .expect("re-extract patched plugins");
    assert_eq!(re_plugins.units.len(), extraction.plugins.units.len());
    for unit in &re_plugins.units {
        assert!(
            unit.source_text.starts_with('\u{8a33}'),
            "plugin surface {} did not round-trip its translation",
            unit.source_unit_key()
        );
    }

    // One targeted spot-check: the Items.json name literal became its target.
    let items_before = String::from_utf8(source_tree["data/Items.json"].clone()).unwrap();
    let items_after = String::from_utf8(patch.patched_data["Items.json"].clone()).unwrap();
    assert_ne!(items_before, items_after);
    assert!(
        items_after.contains(&kaifuu_rpgmaker::encode_json_string_ascii_safe(
            &trivial_target("Public Potion")
        )),
        "the item name became its ASCII-safe encoded trivial target"
    );

    // The patch manifest round-trips through stable JSON deterministically.
    let json = manifest.stable_json().unwrap();
    let parsed: FullSurfacePatchManifest = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, manifest);
}

// ---------------------------------------------------------------------------
// 3. Unsupported plugin-owned text → profile + surface diagnostic
// ---------------------------------------------------------------------------

#[test]
fn unsupported_plugin_text_reports_profile_and_surface_diagnostic() {
    let www = golden_www();
    let extraction = extract_full_surface(&www, &profiles(), &opts()).expect("extract");
    let manifest = extraction.extraction_manifest();

    // QuestLog has string params but NO declared profile → exactly one
    // structured diagnostic (never a per-string sweep, never silent).
    let questlog: Vec<_> = manifest
        .plugin_diagnostics
        .iter()
        .filter(|d| {
            d.kind == "UnsupportedPluginProfile" && d.plugin_name.as_deref() == Some("QuestLog")
        })
        .collect();
    assert_eq!(
        questlog.len(),
        1,
        "exactly one profile+surface diagnostic for the unprofiled plugin"
    );
    let diag = questlog[0];
    assert_eq!(diag.source_file, "plugins.js");
    assert!(!diag.detail.is_empty(), "carries a structural detail");

    // No QuestLog text was extracted (its index is 2 in the $plugins array).
    assert!(!extraction.plugins.units.iter().any(|u| u.plugin_index == 2));

    // CoreEngine (empty profile) is NOT flagged despite numeric string params.
    assert!(
        !manifest
            .plugin_diagnostics
            .iter()
            .any(|d| d.plugin_name.as_deref() == Some("CoreEngine")),
        "an empty (text-free) profile suppresses the diagnostic"
    );

    // The recognized-but-non-text event command (356 plugin command in the map)
    // surfaces as a structural finding — never dropped, never a crash.
    assert!(
        manifest
            .findings
            .iter()
            .any(|f| f.kind == "PluginCommandText"),
        "the 356 plugin command must surface as a finding"
    );
    // Findings carry no retail text.
    for finding in &manifest.findings {
        assert!(!finding.detail.contains("FixturePlugin"));
    }
}

// ---------------------------------------------------------------------------
// 4. Capability tuple limited to MV/MZ JSON text + plugin-profile diagnostics
// ---------------------------------------------------------------------------

#[test]
fn capability_tuple_is_honest_and_limited() {
    let www = golden_www();
    let extraction = extract_full_surface(&www, &profiles(), &opts()).expect("extract");
    let tuple = &extraction.capability;

    assert!(
        tuple.violations().is_empty(),
        "the emitted tuple must be honest; violations: {:?}",
        tuple.violations()
    );
    assert_eq!(tuple.engine_family, "rpg_maker");
    assert_eq!(tuple.variant, "mv_or_mz");
    assert_eq!(tuple.capability, CapabilityLevel::Patch);

    // In-scope is EXACTLY the two text scopes.
    let in_ids: Vec<&str> = tuple.in_scope.iter().map(|s| s.scope_id.as_str()).collect();
    assert_eq!(in_ids, vec![SCOPE_JSON_TEXT, SCOPE_PLUGIN_PROFILE]);

    // Out-of-scope explicitly declines encrypted media + plugin JS logic.
    let out_ids: Vec<&str> = tuple
        .out_of_scope
        .iter()
        .map(|s| s.scope_id.as_str())
        .collect();
    assert!(out_ids.contains(&SCOPE_ENCRYPTED_MEDIA));
    assert!(out_ids.contains(&SCOPE_PLUGIN_JS_LOGIC));

    // No in-scope entry claims media / plugin-JS (no overclaim).
    for scope in &tuple.in_scope {
        assert!(scope.scope_id.contains("json_text") || scope.scope_id.contains("plugin_profile"));
    }

    // The tuple covers all six declared roles between its two scopes.
    let covered: std::collections::BTreeSet<MvMzSurfaceRole> = tuple
        .in_scope
        .iter()
        .flat_map(|s| s.roles.iter().copied())
        .collect();
    assert_eq!(covered.len(), 6);

    // Stable JSON round-trips.
    let json = tuple.stable_json().unwrap();
    let parsed: MvMzCapabilityTuple = serde_json::from_str(&json).unwrap();
    assert_eq!(&parsed, tuple);
}

// ---------------------------------------------------------------------------
// Real-bytes validation (honest scope note)
// ---------------------------------------------------------------------------

/// Descend (bounded BFS) from the staged corpus root to the RPG Maker `www`
/// directory (the one that holds `data/`).
fn resolve_www_dir(root: &Path) -> PathBuf {
    fn find(dir: &Path, depth: usize) -> Option<PathBuf> {
        if dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case("www"))
            && dir.join("data").is_dir()
        {
            return Some(dir.to_path_buf());
        }
        if depth == 0 {
            return None;
        }
        let mut children: Vec<PathBuf> = fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        children.sort();
        children
            .into_iter()
            .find_map(|child| find(&child, depth - 1))
    }
    if root.join("data").is_dir() {
        return root.to_path_buf();
    }
    find(root, 5).unwrap_or_else(|| {
        panic!(
            "ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ={} has no www/ dir with a data/ subdirectory",
            root.display()
        )
    })
}

/// On the real LustMemory corpus, the FIVE `www/data` JSON-text surfaces
/// cover as a rich census, and the plugin-profile surface HONESTLY yields
/// diagnostics — not text — because no per-game plugin profiles are declared
/// here (the real-bytes gap: real games need per-game declared profiles, which
/// the golden fixture supplies but the untyped corpus does not). No verbatim
/// text is asserted or printed.
#[test]
#[ignore = "requires ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ (read-only LustMemory corpus)"]
fn real_bytes_data_surfaces_cover_and_plugin_gap_is_honest() {
    let root = std::env::var("ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ")
        .expect("ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ must be set");
    let www_root = resolve_www_dir(Path::new(&root));

    // No declared profiles: the honest real-bytes posture for an untyped game.
    let extraction = extract_full_surface(&www_root, &[], &opts()).expect("real full-surface");
    let count = |role: MvMzSurfaceRole| {
        extraction
            .coverage
            .iter()
            .find(|c| c.role == role)
            .map_or(0, |c| c.unit_count)
    };
    eprintln!(
        "[real-bytes] maps={} common_events={} database={} system={} terms={} plugin_profile={} \
         plugin_diagnostics={} data_findings={}",
        count(MvMzSurfaceRole::Maps),
        count(MvMzSurfaceRole::CommonEvents),
        count(MvMzSurfaceRole::Database),
        count(MvMzSurfaceRole::System),
        count(MvMzSurfaceRole::Terms),
        count(MvMzSurfaceRole::PluginProfileDiagnostics),
        extraction.plugins.diagnostics.len(),
        extraction.data.findings.len(),
    );

    // The five data-text surfaces are all covered on real bytes.
    for role in [
        MvMzSurfaceRole::Maps,
        MvMzSurfaceRole::CommonEvents,
        MvMzSurfaceRole::Database,
        MvMzSurfaceRole::System,
        MvMzSurfaceRole::Terms,
    ] {
        assert!(count(role) > 0, "real bytes cover {role:?}");
    }

    // The plugin-profile surface yields NO text (no declared profiles) but
    // reports structured unsupported-profile diagnostics — never a crash,
    // never a silent drop.
    assert_eq!(
        count(MvMzSurfaceRole::PluginProfileDiagnostics),
        0,
        "no declared profiles → no plugin text on real bytes (honest gap)"
    );
    assert!(
        extraction
            .plugins
            .diagnostics
            .iter()
            .any(|d| d.kind == kaifuu_rpgmaker::PluginDiagnosticKind::UnsupportedPluginProfile),
        "real plugins.js with string params must diagnose unsupported profiles"
    );

    // The emitted capability tuple stays honest on real bytes.
    assert!(extraction.capability.violations().is_empty());
}
