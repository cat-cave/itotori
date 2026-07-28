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
//! `#[ignore]`d real-bytes proof over both staged corpora. An absent named
//! binary is a **failing** required-input outcome, never a successful skip.
//! **No copyrighted text lives in this file** — only ASCII engine-format
//! markers.

use std::fs;
use std::path::{Path, PathBuf};

use corpus_registry::{Need, resolve};

const CORPORA: [(&str, Need<'static>, &str); 2] = [
    (
        "softpal/Pal.dll v21465",
        Need {
            engine: "softpal",
            ordinal: 1,
            variant: "plain",
        },
        "v21465/dll/Pal.dll",
    ),
    (
        "softpal/Pal.dll v60663",
        Need {
            engine: "softpal",
            ordinal: 2,
            variant: "plain",
        },
        "v60663/dll/Pal.dll",
    ),
];

/// A `<dir>\<file>` path-join template — the loose-file half of the resolver.
const PATH_JOIN: &[u8] = b"%s\\%s";
/// The `.pac` archive extension — the archive half of the resolver.
const PAC_EXT: &[u8] = b".pac";
/// The PAL engine's own PDB identity marker, proving this is the real engine.
const ENGINE_MARKER: &[u8] = b"TamoSys";

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn required_binary(label: &str, path: &Path) -> Vec<u8> {
    fs::read(path).unwrap_or_else(|error| {
        panic!(
            "REAL-BYTES SKIP pal_dll_carries_loose_and_archive_path_machinery: \
             {label} required Pal.dll missing at {} ({error}); refusing a passing real-bytes proof \
             without its required input",
            path.display(),
        )
    })
}

#[test]
#[ignore = "real-bytes; requires both staged Softpal Pal.dll binaries"]
fn pal_dll_carries_loose_and_archive_path_machinery() {
    let mut checked = 0usize;
    for (label, need, raw_path) in CORPORA {
        let root = resolve(need).unwrap_or_else(|reason| {
            panic!(
                "REAL-BYTES SKIP pal_dll_carries_loose_and_archive_path_machinery: \
                 {need} is unavailable ({reason}); refusing a passing real-bytes proof without its required input"
            )
        });
        let dll = root.join(raw_path);
        let bytes = required_binary(label, &dll);
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

    assert_eq!(checked, CORPORA.len(), "both staged binaries inspected");
    eprintln!(
        "OK: {checked}/{} staged Pal.dll binaries carry both loose (`%s\\%s`) and archive \
         (`.pac`) path machinery under the PAL engine marker",
        CORPORA.len(),
    );
}

#[test]
#[should_panic(expected = "required Pal.dll missing")]
fn missing_pal_dll_is_a_non_passing_required_input() {
    let missing = PathBuf::from("/scratch/corpus/absent-softpal-proof-input/Pal.dll");
    let _ = required_binary("absent-fixture", &missing);
}
