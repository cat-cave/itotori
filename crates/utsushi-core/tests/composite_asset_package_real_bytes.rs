//! Real-bytes multi-engine validation for the M.1 composite asset
//! package (UTSUSHI-222).
//!
//! Two engine families are exercised here per the
//! `docs/dev/orchestration-operating-model.md` "Single-game validation
//! passing as 'claimed support'" rule: RealLive and RPG Maker MV/MZ.
//! Both must pass for the substrate's cross-engine genericity claim to
//! hold. Single-corpus validation is a P0 audit failure.
//!
//! Each test is gated on a generic `ITOTORI_REAL_*` env var. When unset,
//! the test emits a visible-skip via `eprintln!` and returns OK — silent
//! pass is explicitly forbidden by the spec node's audit-focus list.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::env;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use utsushi_core::{
    AssetPackage, CaseRule, CompositeAssetPackage, PackageSource, PlaintextDirPackage,
};

const RPG_MAKER_MV_MZ_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ";

/// Walk the host filesystem under `root` looking for the first directory
/// matching `needle` (case-insensitive). Used because staged real
/// corpora can have an additional title-specific parent directory.
fn find_subdir_by_case_insensitive_name(root: &Path, needle: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if path.is_dir() && name_str.eq_ignore_ascii_case(needle) {
            return Some(path);
        }
    }
    None
}

/// Recursively locate `needle` under `root`. Stops at the first match.
fn locate_subdir(root: &Path, needle: &str) -> Option<PathBuf> {
    if let Some(direct) = find_subdir_by_case_insensitive_name(root, needle) {
        return Some(direct);
    }
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir()
            && let Some(found) = locate_subdir(&path, needle)
        {
            return Some(found);
        }
    }
    None
}

fn decode_shift_jis(bytes: &[u8]) -> String {
    // Pure ASCII passthrough; non-ASCII bytes are mapped to U+FFFD so
    // we never panic on the Shift-JIS Gameexe. The FOLDNAME directives
    // are all ASCII in practice, so this is sufficient for the audit's
    // `#FOLDNAME.*` enumeration claim.
    bytes
        .iter()
        .map(|byte| {
            if byte.is_ascii() {
                *byte as char
            } else {
                '\u{FFFD}'
            }
        })
        .collect()
}

/// Parse FOLDNAME.* directives from a Gameexe.ini. Returns the list of
/// (folder_token, archive_token) pairs in declaration order. Folder
/// token is the bare subdirectory; archive_token is the `.PAK` (or
/// equivalent) name; the archive token is empty when the directive
/// declares only a directory.
fn parse_foldname_directives(gameexe_text: &str) -> Vec<(String, String)> {
    let mut directives = Vec::new();
    for line in gameexe_text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("#FOLDNAME.") {
            continue;
        }
        // Form: #FOLDNAME.<KIND> = "<FOLDER>" = N : "<ARCHIVE>"
        let Some(equals_index) = trimmed.find('=') else {
            continue;
        };
        let rhs = trimmed[equals_index + 1..].trim();
        // Pull the first quoted string (folder).
        let Some(folder) = extract_quoted(rhs) else {
            continue;
        };
        // Pull the last quoted string (archive); may be empty.
        let archive = extract_last_quoted(rhs).unwrap_or_default();
        directives.push((folder, archive));
    }
    directives
}

fn extract_quoted(value: &str) -> Option<String> {
    let start = value.find('"')?;
    let rest = &value[start + 1..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn extract_last_quoted(value: &str) -> Option<String> {
    let end = value.rfind('"')?;
    if end == 0 {
        return None;
    }
    let rest = &value[..end];
    let start = rest.rfind('"')?;
    Some(value[start + 1..end].to_string())
}

#[test]
fn composite_asset_package_real_bytes_sweetie_hd_realivedata() {
    let Some(realivedata) = real_corpus::reallivedata_dir() else {
        // Visible-skip per UTSUSHI-222 acceptance criteria.
        eprintln!(
            "SKIP composite_asset_package_real_bytes_sweetie_hd_realivedata: {}; \
             multi-engine validation needs both ITOTORI_REAL_GAME_ROOT and \
             ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ to confirm cross-engine genericity",
            real_corpus::skip_message("RealLive composite asset package test")
        );
        return;
    };

    let gameexe_path = realivedata.join("Gameexe.ini");
    let gameexe_bytes =
        std::fs::read(&gameexe_path).expect("Gameexe.ini must be present in REALLIVEDATA");
    let gameexe_text = decode_shift_jis(&gameexe_bytes);
    let directives = parse_foldname_directives(&gameexe_text);

    assert_eq!(
        directives.len(),
        13,
        "Sweetie HD's Gameexe.ini must declare exactly 13 #FOLDNAME.* directives per the \
         M.1 audit evidence (docs/audits/substrate-honesty.md §M.1)"
    );

    let public_source = PackageSource::PublicName("public-fixture:sweetie-hd-realivedata".into());
    let plaintext = PlaintextDirPackage::new(
        "reallive.realivedata",
        &realivedata,
        CaseRule::InsensitiveAscii,
        public_source.clone(),
    );
    let mut composite = CompositeAssetPackage::new("reallive.realivedata", public_source);
    composite.push_plaintext_dir(Arc::new(plaintext));

    // Enumerate the 13 FOLDNAME directives. For each, attempt to resolve
    // either the declared folder OR the declared archive against the
    // composite. Both forms succeed via the plaintext source when the
    // backing artifact exists at REALLIVEDATA root. When neither exists
    // on this corpus, we surface the absence via `eprintln!` — the
    // substrate's M.1 contract is "support the multiplex policy", not
    // "demand every Gameexe slot be backed by real bytes".
    let mut resolved_count: usize = 0;
    let mut absent_directives: Vec<String> = Vec::new();
    let mut first_resolved: Vec<String> = Vec::new();
    for (folder, archive) in &directives {
        let lower_folder = folder.to_ascii_lowercase();
        let folder_dir = format!("{lower_folder}/");
        let folder_dir_id = composite.resolve(&folder_dir);
        let archive_id = if archive.is_empty() {
            None
        } else {
            Some(composite.resolve(archive))
        };

        let folder_ok = folder_dir_id.is_ok();
        let archive_ok = archive_id.as_ref().is_some_and(std::result::Result::is_ok);

        if folder_ok || archive_ok {
            resolved_count += 1;
            if first_resolved.len() < 5 {
                if let Ok(id) = &folder_dir_id {
                    first_resolved.push(id.as_str().to_string());
                } else if let Some(Ok(id)) = &archive_id {
                    first_resolved.push(id.as_str().to_string());
                }
            }
        } else {
            absent_directives.push(format!(
                "#FOLDNAME.* (folder={folder:?}, archive={archive:?})"
            ));
        }
    }

    eprintln!(
        "Sweetie HD multi-engine validation: 13 FOLDNAME directives enumerated; \
         {resolved_count} resolved via plaintext source; \
         {} absent on this corpus (archive-only directives without a PAK reader); \
         first resolved IDs: {first_resolved:?}",
        absent_directives.len()
    );
    if !absent_directives.is_empty() {
        eprintln!("  absent directives: {absent_directives:?}");
    }

    // The substrate contract requires the multiplex policy works for at
    // least one plaintext-backed FOLDNAME entry; the audit-focus rule
    // ("at least one plaintext-only folder, one archive-only folder,
    // one mixed folder") is exercised in the synthetic suite. Here we
    // require strictly >0 plaintext-backed resolves so a future tree
    // reshuffle is loud.
    assert!(
        resolved_count > 0,
        "Composite must resolve at least one Sweetie HD FOLDNAME directive via plaintext source"
    );

    // Verify a known plaintext file inside one of the resolved folders
    // round-trips byte-for-byte. Sweetie HD has `g00/` populated; pick
    // the first entry there.
    let g00 = realivedata.join("g00");
    if g00.is_dir() {
        let mut first_g00: Option<PathBuf> = None;
        if let Ok(entries) = std::fs::read_dir(&g00) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    first_g00 = Some(path);
                    break;
                }
            }
        }
        let Some(g00_path) = first_g00 else {
            eprintln!(
                "  Sweetie HD g00/ folder present but contained no files; skipping byte check"
            );
            return;
        };
        let logical = format!(
            "g00/{}",
            g00_path
                .file_name()
                .and_then(|name| name.to_str())
                .expect("ASCII g00 filename")
        );
        let id = composite
            .resolve(&logical)
            .expect("composite must resolve a real g00 entry");
        let composite_bytes = composite.open(&id).expect("composite must open the entry");
        let disk_bytes = std::fs::read(&g00_path).expect("disk must read the entry");
        assert_eq!(
            composite_bytes.as_slice(),
            &disk_bytes[..],
            "composite open must return byte-equal bytes to fs::read for {logical:?}"
        );
        eprintln!(
            "  Sweetie HD plaintext byte-equality verified for {logical:?} ({} bytes)",
            disk_bytes.len()
        );
    }
}

#[test]
fn composite_asset_package_real_bytes_lust_memory_www_data_system_json() {
    let env_path = if let Ok(value) = env::var(RPG_MAKER_MV_MZ_ROOT_ENV) {
        PathBuf::from(value)
    } else {
        // Visible-skip per UTSUSHI-222 acceptance criteria.
        assert!(env::var(RPG_MAKER_MV_MZ_ROOT_ENV).is_err());
        eprintln!(
            "SKIP composite_asset_package_real_bytes_lust_memory_www_data_system_json: \
             {RPG_MAKER_MV_MZ_ROOT_ENV} is unset; \
             multi-engine validation needs both ITOTORI_REAL_GAME_ROOT and \
             {RPG_MAKER_MV_MZ_ROOT_ENV} to confirm cross-engine genericity"
        );
        return;
    };

    let www = locate_subdir(&env_path, "www").unwrap_or_else(|| {
        panic!(
            "{RPG_MAKER_MV_MZ_ROOT_ENV} set but `www/` directory not found under root; \
             expected an RPG Maker MV/MZ installation tree"
        )
    });

    let public_source = PackageSource::PublicName("real-corpus:rpg-maker-mv-mz-www".into());
    let plaintext = PlaintextDirPackage::new(
        "rpgmv.www",
        &www,
        CaseRule::InsensitiveAscii,
        public_source.clone(),
    );
    let mut composite = CompositeAssetPackage::new("rpgmv.www", public_source);
    composite.push_plaintext_dir(Arc::new(plaintext));

    let id = composite
        .resolve("data/System.json")
        .expect("composite must resolve data/System.json via the plaintext source");
    assert_eq!(id.path(), "data/System.json");

    let composite_bytes = composite
        .open(&id)
        .expect("composite must open data/System.json");
    let disk_bytes =
        std::fs::read(www.join("data/System.json")).expect("disk must read www/data/System.json");
    assert_eq!(
        composite_bytes.as_slice(),
        &disk_bytes[..],
        "composite open must be byte-equal to fs::read"
    );
    eprintln!(
        "RPG Maker MV/MZ plaintext byte-equality verified for data/System.json ({} bytes)",
        disk_bytes.len()
    );

    // Also exercise list to prove the index-driven directory walk
    // matches the on-disk layout.
    let data_root = utsushi_core::AssetId::from_parts("rpgmv.www", "data/").unwrap();
    let children = composite
        .list(&data_root)
        .expect("composite must list data/");
    eprintln!("  data/ contains {} immediate children", children.len());
    assert!(
        children.iter().any(|id| id.path() == "data/System.json"),
        "list(data/) must include System.json"
    );
}
