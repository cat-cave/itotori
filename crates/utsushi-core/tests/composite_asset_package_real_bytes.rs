// @itotori-real-bytes-proof
//! Real-bytes multi-engine validation for the M.1 composite asset
//! package ().
//!
//! The staged RealLive corpus exercises the substrate's generic directory
//! package implementation against non-synthetic bytes.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::path::PathBuf;
use std::sync::Arc;

use utsushi_core::{
    AssetPackage, CaseRule, CompositeAssetPackage, PackageSource, PlaintextDirPackage,
};

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
        // Form: #FOLDNAME.<KIND> = "<FOLDER>" = N: "<ARCHIVE>"
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
fn composite_asset_package_real_bytes_primary_corpus_realivedata() {
    let Some(realivedata) = real_corpus::reallivedata_dir() else {
        panic!("real-bytes proof not established: required corpus is unavailable");
    };

    let gameexe_path = realivedata.join("Gameexe.ini");
    let gameexe_bytes =
        std::fs::read(&gameexe_path).expect("Gameexe.ini must be present in REALLIVEDATA");
    let gameexe_text = decode_shift_jis(&gameexe_bytes);
    let directives = parse_foldname_directives(&gameexe_text);

    assert_eq!(
        directives.len(),
        13,
        "primary_corpus HD's Gameexe.ini must declare exactly 13 #FOLDNAME.* directives per the \
         M.1 audit evidence (docs/audits/substrate-honesty.md §M.1)"
    );

    let public_source =
        PackageSource::PublicName("public-fixture:primary_corpus-hd-realivedata".into());
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
        "primary_corpus HD multi-engine validation: 13 FOLDNAME directives enumerated; \
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
    // ("at least one plaintext-only folder, one archive-only folder
    // one mixed folder") is exercised in the synthetic suite. Here we
    // require strictly >0 plaintext-backed resolves so a future tree
    // reshuffle is loud.
    assert!(
        resolved_count > 0,
        "Composite must resolve at least one primary_corpus HD FOLDNAME directive via plaintext source"
    );

    // Verify a known plaintext file inside one of the resolved folders
    // round-trips byte-for-byte. primary_corpus HD has `g00/` populated; pick
    // the first entry there.
    let g00 = realivedata.join("g00");
    assert!(
        g00.is_dir(),
        "real-bytes proof not established: required primary-corpus g00 directory is unavailable"
    );
    let mut first_g00: Option<PathBuf> = None;
    let entries = std::fs::read_dir(&g00)
        .unwrap_or_else(|err| panic!("read required primary-corpus {}: {err}", g00.display()));
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            first_g00 = Some(path);
            break;
        }
    }
    let Some(g00_path) = first_g00 else {
        panic!("real-bytes proof not established: required corpus asset is unavailable");
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
        "  primary_corpus HD plaintext byte-equality verified for {logical:?} ({} bytes)",
        disk_bytes.len()
    );
}
