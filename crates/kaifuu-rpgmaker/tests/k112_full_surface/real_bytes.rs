use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_rpgmaker::{MvMzSurfaceRole, extract_full_surface};

use super::opts;

// Real-bytes validation (honest scope note)

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
            "rpg-maker-mv-mz/1/plain={} has no www/ dir with a data/ subdirectory",
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
#[ignore = "requires private inventory row (read-only LustMemory corpus)"]
fn real_bytes_data_surfaces_cover_and_plugin_gap_is_honest() {
    let root = corpus_registry::resolve_identity("rpg-maker-mv-mz/1/plain")
        .map(|path| path.to_string_lossy().into_owned())
        .expect("rpg-maker-mv-mz/1/plain must be set");
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
