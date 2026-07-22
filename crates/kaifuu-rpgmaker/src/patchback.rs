//! RPG Maker MV/MZ patchback + `.kaifuu` delta producer.
//! The analogue of `crates/kaifuu-reallive/src/patchback/bundle_driven.rs`
//! for the JSON-surface engine family. Given a translated v0.2
//! [`TranslatedBundleV02`] (the extraction bundle augmented with one
//! `target.{locale,text}` per unit), it writes each reviewed translation
//! back into `www/data/*.json` at exactly the JSON-pointer surface the
//! extractor keyed, then emits a `kaifuu-delta` package over the data
//! tree.
//! # Byte-fidelity (PROJECT LAW)
//! Files are patched by **byte-surgical splice**, never by re-serializing:
//! [`crate::json_locate`] walks the raw bytes to the byte span of the
//! target string literal and only that span is replaced. Consequences:
//! - An UNTRANSLATED bundle (`target == source`) produces **zero** byte
//!   edits — every unit is a no-op — so the file (and the delta) is
//!   byte-identical to the source. No structural / whitespace / key-order
//!   escaping churn.
//! - A translated patch changes only the targeted string literals; every
//!   other byte (structure, key order, untouched strings) is preserved
//!   verbatim.
//! # No silent corruption
//! Before any splice, each edit is gated against the source the bundle was
//! extracted from: the located literal is decoded and SHA-256-hashed, and
//! a mismatch with the unit's `sourceHash` is a typed
//! [`PatchbackError::StaleSource`] (the StaleSourceHash-style gate). A
//! surface id whose pointer does not resolve to a string in the current
//! JSON is a typed [`PatchbackError::UnresolvedSurface`] — never a silent
//! skip or a wrong-location splice.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use thiserror::Error;

use kaifuu_core::{BridgeBundleV02, BridgeContractValidationError, sha256_hash_bytes};
use kaifuu_delta::{SourceProvenance, create_delta};

use crate::json_locate::{Scanner, encode_json_string_ascii_safe, strip_utf8_bom};

/// Stable patchback error codes (published, mirroring the RealLive
/// `kaifuu.reallive.patchback_*` contract).
pub const PATCHBACK_BUNDLE_SCHEMA_INVALID_CODE: &str =
    "kaifuu.rpgmaker.patchback_bundle_schema_invalid";
pub const PATCHBACK_SURFACE_KEY_MALFORMED_CODE: &str =
    "kaifuu.rpgmaker.patchback_surface_key_malformed";
pub const PATCHBACK_UNRESOLVED_SURFACE_CODE: &str = "kaifuu.rpgmaker.patchback_unresolved_surface";
pub const PATCHBACK_STALE_SOURCE_CODE: &str = "kaifuu.rpgmaker.patchback_stale_source";
pub const PATCHBACK_OVERLAPPING_SURFACES_CODE: &str =
    "kaifuu.rpgmaker.patchback_overlapping_surfaces";
pub const PATCHBACK_VERIFICATION_FAILED_CODE: &str =
    "kaifuu.rpgmaker.patchback_verification_failed";
pub const PATCHBACK_TARGET_EMPTY_CODE: &str = "kaifuu.rpgmaker.patchback_target_empty";
pub const PATCHBACK_IO_CODE: &str = "kaifuu.rpgmaker.patchback_io";
pub const PATCHBACK_DELTA_PRODUCE_CODE: &str = "kaifuu.rpgmaker.patchback_delta_produce";

/// Fatal errors raised by the patchback / delta producer.
#[derive(Debug, Error)]
pub enum PatchbackError {
    /// The translated bundle's source side failed v0.2 validation, or a
    /// unit was missing its `target.{locale,text}` payload.
    #[error("{PATCHBACK_BUNDLE_SCHEMA_INVALID_CODE}: {message}")]
    BundleSchemaInvalid { message: String },
    /// A unit's `sourceUnitKey` did not match the canonical
    /// `rpgmaker:<file>#<json-pointer>` shape.
    #[error(
        "{PATCHBACK_SURFACE_KEY_MALFORMED_CODE}: source unit key {source_unit_key:?}: {reason}"
    )]
    SurfaceKeyMalformed {
        source_unit_key: String,
        reason: String,
    },
    /// A unit's JSON-pointer surface did not resolve to a string in the
    /// current file bytes (missing key / out-of-range index / not a
    /// string). Never a silent skip.
    #[error(
        "{PATCHBACK_UNRESOLVED_SURFACE_CODE}: surface {source_unit_key:?} did not resolve in {file}: {reason}"
    )]
    UnresolvedSurface {
        file: String,
        source_unit_key: String,
        reason: String,
    },
    /// The located source literal did not hash to the unit's recorded
    /// `sourceHash`: the file changed since extraction. Re-extract before
    /// re-applying (the StaleSourceHash-style gate).
    #[error(
        "{PATCHBACK_STALE_SOURCE_CODE}: surface {source_unit_key:?} in {file}: expected source hash {expected_hash}, found {actual_hash}; re-extract the bridge bundle before re-applying"
    )]
    StaleSource {
        file: String,
        source_unit_key: String,
        expected_hash: String,
        actual_hash: String,
    },
    /// Two edits targeted overlapping byte ranges in one file — a bundle
    /// defect that would corrupt the splice.
    #[error(
        "{PATCHBACK_OVERLAPPING_SURFACES_CODE}: in {file}, surfaces {first:?} and {second:?} resolve to overlapping byte ranges"
    )]
    OverlappingSurfaces {
        file: String,
        first: String,
        second: String,
    },
    /// A post-splice self-check failed: the patched bytes did not re-parse
    /// as JSON, or a patched surface did not decode back to its target.
    #[error("{PATCHBACK_VERIFICATION_FAILED_CODE}: {file}: {reason}")]
    VerificationFailed { file: String, reason: String },
    /// A unit carried an empty `target.text`. RPG Maker translatable
    /// surfaces are non-empty (the extractor never emits an empty
    /// `sourceText`), so an empty target is a bundle defect.
    #[error("{PATCHBACK_TARGET_EMPTY_CODE}: unit {bridge_unit_id} target text is empty")]
    TargetEmpty { bridge_unit_id: String },
    /// Filesystem I/O failed in the directory-driving / delta layer.
    #[error("{PATCHBACK_IO_CODE}: {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    /// `kaifuu-delta` failed to produce the `.kaifuu` package.
    #[error("{PATCHBACK_DELTA_PRODUCE_CODE}: {message}")]
    DeltaProduce { message: String },
}

impl From<BridgeContractValidationError> for PatchbackError {
    fn from(value: BridgeContractValidationError) -> Self {
        Self::BundleSchemaInvalid {
            message: value.to_string(),
        }
    }
}

#[path = "patchback_types.rs"]
mod types;
pub use types::{JsonStringEscaping, PatchbackOpts, TranslatedBundleV02, TranslatedUnitTarget};

/// One resolved edit: the JSON-pointer tokens, the target text, and the
/// source-hash gate, all attributed to a single `www/data/*.json` file.
/// `pub(crate)` so the map/common-event slice
/// ([`crate::map_common_event`]) reuses the same proven byte-surgical
/// splice + stale-source gate instead of re-implementing patchback.
#[derive(Debug, Clone)]
pub(crate) struct FileEdit {
    pub(crate) source_unit_key: String,
    pub(crate) tokens: Vec<String>,
    pub(crate) target_text: String,
    pub(crate) expected_source_hash: String,
}

/// Parse a `rpgmaker:<file>#<json-pointer>` surface key into the file name
/// and the RFC6901-decoded pointer tokens.
fn parse_surface_key(key: &str) -> Result<(String, Vec<String>), PatchbackError> {
    let malformed = |reason: &str| PatchbackError::SurfaceKeyMalformed {
        source_unit_key: key.to_string(),
        reason: reason.to_string(),
    };
    let rest = key
        .strip_prefix("rpgmaker:")
        .ok_or_else(|| malformed("missing `rpgmaker:` prefix"))?;
    let (file, pointer) = rest
        .split_once('#')
        .ok_or_else(|| malformed("missing `#<json-pointer>` separator"))?;
    if file.is_empty() {
        return Err(malformed("file component is empty"));
    }
    if !pointer.starts_with('/') {
        return Err(malformed("json pointer must start with '/'"));
    }
    // RFC6901 decode: split on '/', drop the leading empty segment, then
    // un-escape `~1` -> '/' and `~0` -> '~' (in that order).
    let tokens = pointer[1..]
        .split('/')
        .map(|segment| segment.replace("~1", "/").replace("~0", "~"))
        .collect::<Vec<_>>();
    Ok((file.to_string(), tokens))
}

/// Patch one file's raw JSON bytes with the given edits. Pure: no I/O.
/// Returns bytes byte-identical to `original` outside the targeted string
/// literals. When every edit is a no-op (`target == source`), the original
/// bytes are returned verbatim.
pub(crate) fn patch_file_bytes(
    file: &str,
    original: &[u8],
    edits: &[FileEdit],
) -> Result<Vec<u8>, PatchbackError> {
    // (start, end, new_bytes, source_unit_key) for each non-no-op edit.
    let mut splices: Vec<(usize, usize, Vec<u8>, String)> = Vec::new();

    for edit in edits {
        let mut scanner = Scanner::new(original);
        let span =
            scanner
                .locate(&edit.tokens)
                .map_err(|err| PatchbackError::UnresolvedSurface {
                    file: file.to_string(),
                    source_unit_key: edit.source_unit_key.clone(),
                    reason: err.to_string(),
                })?;
        let located_text = Scanner::decode_span(original, span).map_err(|err| {
            PatchbackError::UnresolvedSurface {
                file: file.to_string(),
                source_unit_key: edit.source_unit_key.clone(),
                reason: err.to_string(),
            }
        })?;
        // StaleSourceHash-style gate: the located literal must hash to the
        // source the bundle was extracted from. This both detects a stale
        // source AND guards against a wrong-location splice.
        let actual_hash = sha256_hash_bytes(located_text.as_bytes());
        if actual_hash != edit.expected_source_hash {
            return Err(PatchbackError::StaleSource {
                file: file.to_string(),
                source_unit_key: edit.source_unit_key.clone(),
                expected_hash: edit.expected_source_hash.clone(),
                actual_hash,
            });
        }
        // No-op when the translation equals the source: leave the original
        // literal bytes untouched (no spurious diff).
        if edit.target_text == located_text {
            continue;
        }
        let new_bytes = encode_json_string_ascii_safe(&edit.target_text).into_bytes();
        splices.push((
            span.start,
            span.end,
            new_bytes,
            edit.source_unit_key.clone(),
        ));
    }

    if splices.is_empty() {
        return Ok(original.to_vec());
    }

    // Order by ascending start to reject overlaps, then splice descending
    // so earlier splices do not shift later byte ranges.
    splices.sort_by_key(|(start, _, _, _)| *start);
    for window in splices.windows(2) {
        let (_, prev_end, _, prev_key) = &window[0];
        let (next_start, _, _, next_key) = &window[1];
        if prev_end > next_start {
            return Err(PatchbackError::OverlappingSurfaces {
                file: file.to_string(),
                first: prev_key.clone(),
                second: next_key.clone(),
            });
        }
    }

    let mut output = original.to_vec();
    for (start, end, new_bytes, _) in splices.iter().rev() {
        output.splice(*start..*end, new_bytes.iter().copied());
    }

    // Self-check: the patched bytes must still parse as JSON, and every
    // patched surface must decode back to its target. A locator/splice
    // defect surfaces a typed error here rather than corrupt output.
    serde_json::from_slice::<Value>(strip_utf8_bom(&output)).map_err(|err| {
        PatchbackError::VerificationFailed {
            file: file.to_string(),
            reason: format!("patched bytes failed to re-parse as JSON: {err}"),
        }
    })?;
    for (.., source_unit_key) in &splices {
        let edit = edits
            .iter()
            .find(|edit| &edit.source_unit_key == source_unit_key)
            .expect("spliced edit is one of the input edits");
        let mut scanner = Scanner::new(&output);
        let span =
            scanner
                .locate(&edit.tokens)
                .map_err(|err| PatchbackError::VerificationFailed {
                    file: file.to_string(),
                    reason: format!(
                        "patched surface {source_unit_key:?} no longer resolves: {err}"
                    ),
                })?;
        let decoded = Scanner::decode_span(&output, span).map_err(|err| {
            PatchbackError::VerificationFailed {
                file: file.to_string(),
                reason: format!("patched surface {source_unit_key:?} did not decode: {err}"),
            }
        })?;
        if decoded != edit.target_text {
            return Err(PatchbackError::VerificationFailed {
                file: file.to_string(),
                reason: format!("patched surface {source_unit_key:?} decoded to the wrong text"),
            });
        }
    }

    Ok(output)
}

/// Group the bundle's translations by file and resolve each to a
/// [`FileEdit`]. The `target == source` no-op detection is left to
/// [`patch_file_bytes`] (which also runs the stale-source gate).
fn collect_edits_by_file(
    bundle: &TranslatedBundleV02,
) -> Result<BTreeMap<String, Vec<FileEdit>>, PatchbackError> {
    if bundle.targets.len() != bundle.source.units.len() {
        return Err(PatchbackError::BundleSchemaInvalid {
            message: format!(
                "translated bundle has {targets} targets but {units} source units",
                targets = bundle.targets.len(),
                units = bundle.source.units.len()
            ),
        });
    }
    let mut by_file: BTreeMap<String, Vec<FileEdit>> = BTreeMap::new();
    for (target, unit) in bundle.targets.iter().zip(bundle.source.units.iter()) {
        if target.bridge_unit_id != unit.bridge_unit_id {
            return Err(PatchbackError::BundleSchemaInvalid {
                message: format!(
                    "translated bundle target bridgeUnitId {target_id} does not match unit bridgeUnitId {unit_id}",
                    target_id = target.bridge_unit_id,
                    unit_id = unit.bridge_unit_id,
                ),
            });
        }
        let (file, tokens) = parse_surface_key(&unit.source_unit_key)?;
        by_file.entry(file).or_default().push(FileEdit {
            source_unit_key: unit.source_unit_key.clone(),
            tokens,
            target_text: target.target_text.clone(),
            expected_source_hash: unit.source_hash.clone(),
        });
    }
    Ok(by_file)
}

/// Apply a translated v0.2 BridgeBundle to a game's `www/data/*.json`
/// files, returning the patched bytes per referenced file.
/// Reads (read-only) from `<www_dir>/data/<file>`; performs no writes.
/// Every referenced file appears in the result, byte-identical to its
/// source for files whose units are all no-ops. Mirrors the RealLive
/// `apply_translated_bundle` (in-memory, no side effects).
pub fn apply_translated_bundle(
    www_dir: &Path,
    bundle: &TranslatedBundleV02,
    _opts: &PatchbackOpts,
) -> Result<BTreeMap<String, Vec<u8>>, PatchbackError> {
    let edits_by_file = collect_edits_by_file(bundle)?;
    let data_dir = www_dir.join("data");
    let mut patched: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for (file, edits) in &edits_by_file {
        let path = data_dir.join(file);
        let original = fs::read(&path).map_err(|source| PatchbackError::Io {
            path: path.display().to_string(),
            source,
        })?;
        let bytes = patch_file_bytes(file, &original, edits)?;
        patched.insert(file.clone(), bytes);
    }
    Ok(patched)
}

/// Outcome of [`produce_delta_package`].
#[derive(Debug, Clone)]
pub struct ProducedDelta {
    /// The `.kaifuu` delta package JSON (the `kaifuu-delta` v0.3 shape).
    pub delta: Value,
    /// The materialized patched `data` tree the delta targets.
    pub patched_data_dir: PathBuf,
    /// Number of files whose bytes changed (non-no-op).
    pub changed_file_count: usize,
}

/// Patch a game's `www/data` tree with a translated bundle and produce the
/// `.kaifuu` delta package over it.
/// Materializes a full, writable copy of `<www_dir>/data` at
/// `patched_data_dir` (which must not yet exist), splices the reviewed
/// translations into the referenced files, then diffs source-vs-patched
/// via [`kaifuu_delta::create_delta`]. The returned delta + patched tree
/// are reproduced byte-for-byte by `kaifuu_delta::apply_delta`.
/// `<www_dir>/data` is treated strictly read-only.
pub fn produce_delta_package(
    www_dir: &Path,
    bundle: &TranslatedBundleV02,
    opts: &PatchbackOpts,
    patched_data_dir: &Path,
) -> Result<ProducedDelta, PatchbackError> {
    let patched_bytes = apply_translated_bundle(www_dir, bundle, opts)?;
    let source_data_dir = www_dir.join("data");

    // Materialize a writable copy of the source data tree.
    copy_dir_writable(&source_data_dir, patched_data_dir)?;

    // Overwrite the referenced files with their patched bytes. No-op files
    // re-write identical bytes (the delta then shows no change for them).
    let mut changed_file_count = 0usize;
    for (file, bytes) in &patched_bytes {
        let dest = patched_data_dir.join(file);
        let before = fs::read(&dest).map_err(|source| PatchbackError::Io {
            path: dest.display().to_string(),
            source,
        })?;
        if &before != bytes {
            changed_file_count += 1;
        }
        fs::write(&dest, bytes).map_err(|source| PatchbackError::Io {
            path: dest.display().to_string(),
            source,
        })?;
    }

    let delta = create_delta(
        &source_data_dir,
        patched_data_dir,
        SourceProvenance::complete(),
    )
    .map_err(|err| PatchbackError::DeltaProduce {
        message: err.to_string(),
    })?;

    Ok(ProducedDelta {
        delta,
        patched_data_dir: patched_data_dir.to_path_buf(),
        changed_file_count,
    })
}

/// Recursively copy `src` into `dest` writing fresh (default-writable)
/// files so the read-only mode bits of a corpus source tree are not
/// propagated to the writable patched copy.
fn copy_dir_writable(src: &Path, dest: &Path) -> Result<(), PatchbackError> {
    fs::create_dir_all(dest).map_err(|source| PatchbackError::Io {
        path: dest.display().to_string(),
        source,
    })?;
    let entries = fs::read_dir(src).map_err(|source| PatchbackError::Io {
        path: src.display().to_string(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| PatchbackError::Io {
            path: src.display().to_string(),
            source,
        })?;
        let file_type = entry.file_type().map_err(|source| PatchbackError::Io {
            path: entry.path().display().to_string(),
            source,
        })?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_writable(&from, &to)?;
        } else if file_type.is_file() {
            let bytes = fs::read(&from).map_err(|source| PatchbackError::Io {
                path: from.display().to_string(),
                source,
            })?;
            fs::write(&to, &bytes).map_err(|source| PatchbackError::Io {
                path: to.display().to_string(),
                source,
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "patchback_tests.rs"]
mod tests;
