//! Real-bytes grounding for the patch-back **loose-file override** claim: the
//! PAL engine resolves a script asset from a loose `data\` file in preference to
//! the `data.pac` archive, so patch-back drops rebuilt files loose and never
//! repacks the archive (see `kaifuu_softpal::patchback`).
//!
//! This is NOT a byte-level round-trip mock — it inspects the **real shipped
//! `Pal.dll`** engine binary and asserts it carries the two path-construction
//! templates a loose-then-archive resolver needs: an `<name>.pac` archive-path
//! builder AND a `<dir>\<file>` directory path-join template, plus the engine's
//! own PDB identity marker (`TamoSys\PAL`). The runtime resolution *order* is
//! established by the third-party toolchain's documented engine behaviour, not
//! by this test; here we prove the engine binary actually contains the file /
//! archive path machinery that behaviour depends on.
//!
//! `#[ignore]`d and env-gated: set `ITOTORI_SOFTPAL_RESEARCH_ROOT` to the
//! READ-ONLY research tree (e.g. `/scratch/softpal-research`) and run with
//! `--ignored`. When the env var is unset or no `Pal.dll` is present under the
//! root the test SKIPS CLEANLY (prints why and returns) — it never panics on an
//! absent corpus. Wired into the PERIODIC `ci-real-bytes` lane alongside the
//! other `*_real_corpus` tests. **No copyrighted text lives in this file** —
//! only ASCII engine-format markers.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const RESEARCH_ROOT_ENV: &str = "ITOTORI_SOFTPAL_RESEARCH_ROOT";

/// A `<dir>\<file>` path-join template — the loose-file half of the resolver.
const PATH_JOIN: &[u8] = b"%s\\%s";
/// The `.pac` archive extension — the archive half of the resolver.
const PAC_EXT: &[u8] = b".pac";
/// The PAL engine's own PDB identity marker, proving this is the real engine.
const ENGINE_MARKER: &[u8] = b"TamoSys";

/// Collect every `Pal.dll` (case-insensitive) under `dir`.
fn find_pal_dlls(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            find_pal_dlls(&path, out);
        } else if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case("Pal.dll"))
        {
            out.push(path);
        }
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_SOFTPAL_RESEARCH_ROOT with a shipped Pal.dll"]
fn pal_dll_carries_loose_and_archive_path_machinery() {
    let Some(root) = env::var_os(RESEARCH_ROOT_ENV).map(PathBuf::from) else {
        eprintln!("SKIP: {RESEARCH_ROOT_ENV} unset; no Softpal research tree to inspect");
        return;
    };
    let mut dlls = Vec::new();
    find_pal_dlls(&root, &mut dlls);
    dlls.sort();
    if dlls.is_empty() {
        eprintln!(
            "SKIP: no Pal.dll under {} (engine binary not staged)",
            root.display()
        );
        return;
    }

    let mut checked = 0usize;
    for dll in &dlls {
        let bytes = fs::read(dll).expect("read Pal.dll");
        assert!(
            contains(&bytes, ENGINE_MARKER),
            "{}: expected PAL engine identity marker {:?}",
            dll.display(),
            String::from_utf8_lossy(ENGINE_MARKER),
        );
        assert!(
            contains(&bytes, PAC_EXT),
            "{}: expected `.pac` archive-path builder (archive resolution)",
            dll.display(),
        );
        assert!(
            contains(&bytes, PATH_JOIN),
            "{}: expected `%s\\%s` path-join template (loose `data\\<file>` resolution)",
            dll.display(),
        );
        checked += 1;
    }

    assert!(checked >= 1, "expected to inspect at least one Pal.dll");
    eprintln!(
        "OK: {checked} Pal.dll binary(ies) carry both loose (`%s\\%s`) and archive (`.pac`) \
         path machinery under the PAL engine marker"
    );
}
