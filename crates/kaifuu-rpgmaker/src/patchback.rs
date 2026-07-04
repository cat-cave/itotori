//! RPG Maker MV/MZ patchback + `.kaifuu` delta producer.
//!
//! The analogue of `crates/kaifuu-reallive/src/patchback/bundle_driven.rs`
//! for the JSON-surface engine family. Given a translated v0.2
//! [`TranslatedBundleV02`] (the extraction bundle augmented with one
//! `target.{locale,text}` per unit), it writes each reviewed translation
//! back into `www/data/*.json` at exactly the JSON-pointer surface the
//! extractor keyed, then emits a `kaifuu-delta` package over the data
//! tree.
//!
//! # Byte-fidelity (PROJECT LAW)
//!
//! Files are patched by **byte-surgical splice**, never by re-serializing:
//! [`crate::json_locate`] walks the raw bytes to the byte span of the
//! target string literal and only that span is replaced. Consequences:
//!
//! - An UNTRANSLATED bundle (`target == source`) produces **zero** byte
//!   edits — every unit is a no-op — so the file (and the delta) is
//!   byte-identical to the source. No structural / whitespace / key-order
//!   / escaping churn.
//! - A translated patch changes only the targeted string literals; every
//!   other byte (structure, key order, untouched strings) is preserved
//!   verbatim.
//!
//! # No silent corruption
//!
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

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use kaifuu_core::{BridgeBundleV02, BridgeContractValidationError, sha256_hash_bytes};
use kaifuu_delta::{SourceProvenance, create_delta};

use crate::json_locate::{Scanner, encode_json_string_ascii_safe};

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

/// Named string-escaping choice for the patched JSON bytes.
///
/// The RPG Maker MV/MZ editor serializes `www/data/*.json` ASCII-safe:
/// every non-ASCII codepoint is `\uXXXX`-escaped. Naming the choice in
/// code (rather than defaulting it silently) is the
/// "Encoding/escaping corruption of MV/MZ JSON" audit-focus mitigation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JsonStringEscaping {
    /// `"`/`\` backslash-escaped, control codes via short/`\u00XX`
    /// escapes, every codepoint `>= 0x80` as `\uXXXX` (surrogate pair for
    /// astral codepoints). Printable ASCII verbatim.
    AsciiSafeUnicodeEscapes,
}

/// Caller-supplied knobs for the patchback. All fields are required;
/// there are no implicit defaults.
#[derive(Debug, Clone, Copy)]
pub struct PatchbackOpts {
    pub string_escaping: JsonStringEscaping,
}

impl PatchbackOpts {
    /// The canonical RPG Maker MV/MZ emission mode: ASCII-safe `\u`
    /// escaping, matching the editor's own output.
    pub const fn rpg_maker_default() -> Self {
        Self {
            string_escaping: JsonStringEscaping::AsciiSafeUnicodeEscapes,
        }
    }
}

/// One per-unit translation entry consumed by the patchback driver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslatedUnitTarget {
    /// Matches the source [`kaifuu_core::LocalizationUnitV02::bridge_unit_id`].
    pub bridge_unit_id: String,
    /// Locale tag of the target text (e.g. `"en-US"`).
    pub target_locale: String,
    /// The translated body (the literal that will be written back).
    pub target_text: String,
}

/// Translated v0.2 BridgeBundle: the validated source side plus one
/// `target.{locale,text}` per unit. Identical in shape to the RealLive
/// [`kaifuu_reallive::TranslatedBundleV02`] so itotori populates both the
/// same way.
#[derive(Debug, Clone)]
pub struct TranslatedBundleV02 {
    pub source: BridgeBundleV02,
    pub targets: Vec<TranslatedUnitTarget>,
}

impl TranslatedBundleV02 {
    /// Parse a translated-bundle JSON value: validate the source side
    /// against the v0.2 contract and pull `target.{locale,text}` per unit.
    pub fn from_json(value: &Value) -> Result<Self, PatchbackError> {
        let source = BridgeBundleV02::validate_json(value)?;
        let units_json = value
            .get("units")
            .and_then(Value::as_array)
            .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                message: "translated bundle JSON has no `units` array".into(),
            })?;
        if units_json.len() != source.units.len() {
            return Err(PatchbackError::BundleSchemaInvalid {
                message: format!(
                    "translated bundle units array length {observed} does not match validated unit count {expected}",
                    observed = units_json.len(),
                    expected = source.units.len()
                ),
            });
        }
        let mut targets = Vec::with_capacity(source.units.len());
        for (index, unit_json) in units_json.iter().enumerate() {
            let bridge_unit_id = source.units[index].bridge_unit_id.clone();
            let target_obj = unit_json
                .get("target")
                .and_then(Value::as_object)
                .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                    message: format!(
                        "translated bundle unit[{index}] is missing the `target` object"
                    ),
                })?;
            let target_locale = target_obj
                .get("locale")
                .and_then(Value::as_str)
                .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                    message: format!(
                        "translated bundle unit[{index}].target.locale must be a string"
                    ),
                })?
                .to_string();
            let target_text = target_obj
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                    message: format!(
                        "translated bundle unit[{index}].target.text must be a string"
                    ),
                })?
                .to_string();
            if target_text.is_empty() {
                return Err(PatchbackError::TargetEmpty { bridge_unit_id });
            }
            targets.push(TranslatedUnitTarget {
                bridge_unit_id,
                target_locale,
                target_text,
            });
        }
        Ok(Self { source, targets })
    }
}

/// One resolved edit: the JSON-pointer tokens, the target text, and the
/// source-hash gate, all attributed to a single `www/data/*.json` file.
///
/// `pub(crate)` so the KAIFUU-109 map/common-event slice
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
///
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
    serde_json::from_slice::<Value>(&output).map_err(|err| PatchbackError::VerificationFailed {
        file: file.to_string(),
        reason: format!("patched bytes failed to re-parse as JSON: {err}"),
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
///
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
///
/// Materializes a full, writable copy of `<www_dir>/data` at
/// `patched_data_dir` (which must not yet exist), splices the reviewed
/// translations into the referenced files, then diffs source-vs-patched
/// via [`kaifuu_delta::create_delta`]. The returned delta + patched tree
/// are reproduced byte-for-byte by `kaifuu_delta::apply_delta`.
///
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
mod tests {
    use super::*;

    #[test]
    fn parses_surface_key_with_rfc6901_decoding() {
        let (file, tokens) = parse_surface_key("rpgmaker:Items.json#/1/description").unwrap();
        assert_eq!(file, "Items.json");
        assert_eq!(tokens, vec!["1".to_string(), "description".to_string()]);

        let (file, tokens) =
            parse_surface_key("rpgmaker:System.json#/terms/messages/possession").unwrap();
        assert_eq!(file, "System.json");
        assert_eq!(
            tokens,
            vec![
                "terms".to_string(),
                "messages".to_string(),
                "possession".to_string()
            ]
        );

        // RFC6901 escapes: ~1 -> '/', ~0 -> '~'.
        let (_, tokens) = parse_surface_key("rpgmaker:M.json#/a~1b/c~0d").unwrap();
        assert_eq!(tokens, vec!["a/b".to_string(), "c~d".to_string()]);
    }

    #[test]
    fn malformed_surface_keys_are_typed_errors() {
        assert!(matches!(
            parse_surface_key("notrpgmaker:x#/a"),
            Err(PatchbackError::SurfaceKeyMalformed { .. })
        ));
        assert!(matches!(
            parse_surface_key("rpgmaker:Items.json/1/name"),
            Err(PatchbackError::SurfaceKeyMalformed { .. })
        ));
    }

    fn edit(key: &str, tokens: &[&str], target: &str, source: &str) -> FileEdit {
        FileEdit {
            source_unit_key: key.to_string(),
            tokens: tokens
                .iter()
                .map(std::string::ToString::to_string)
                .collect(),
            target_text: target.to_string(),
            expected_source_hash: sha256_hash_bytes(source.as_bytes()),
        }
    }

    #[test]
    fn untranslated_edit_is_byte_identical_noop() {
        // Top-level array, mirroring a real database file shape.
        let original = br#"[null,{"id":1,"name":"Potion","description":"Heals."}]"#;
        // target == source for every edit.
        let edits = vec![
            edit(
                "rpgmaker:Items.json#/1/name",
                &["1", "name"],
                "Potion",
                "Potion",
            ),
            edit(
                "rpgmaker:Items.json#/1/description",
                &["1", "description"],
                "Heals.",
                "Heals.",
            ),
        ];
        let out = patch_file_bytes("Items.json", original, &edits).unwrap();
        assert_eq!(out, original, "untranslated patch must be byte-identical");
    }

    #[test]
    fn translated_edit_changes_only_targeted_surface() {
        let original = br#"[null,{"id":1,"name":"Potion","description":"Heals."}]"#;
        // A non-ASCII translation (katakana "ポーション").
        let target = "\u{30dd}\u{30fc}\u{30b7}\u{30e7}\u{30f3}";
        let edits = vec![edit(
            "rpgmaker:Items.json#/1/name",
            &["1", "name"],
            target,
            "Potion",
        )];
        let out = patch_file_bytes("Items.json", original, &edits).unwrap();
        assert_ne!(out, original);

        // The whole file is byte-identical except the targeted `name`
        // literal, which is replaced by the ASCII-safe `\u`-escaped target
        // (the encoder output is pinned by its own unit test).
        let encoded_name = encode_json_string_ascii_safe(target);
        let expected = format!(r#"[null,{{"id":1,"name":{encoded_name},"description":"Heals."}}]"#);
        assert_eq!(out, expected.as_bytes());

        // The non-targeted `description` surface still decodes intact.
        let mut scanner = Scanner::new(&out);
        let span = scanner
            .locate(&["1".to_string(), "description".to_string()])
            .unwrap();
        assert_eq!(Scanner::decode_span(&out, span).unwrap(), "Heals.");
    }

    #[test]
    fn stale_source_is_typed_error() {
        let original = br#"[null,{"id":1,"name":"Potion"}]"#;
        // Hash gate computed against a different source string.
        let edits = vec![edit(
            "rpgmaker:Items.json#/1/name",
            &["1", "name"],
            "Elixir",
            "DIFFERENT-SOURCE",
        )];
        let err = patch_file_bytes("Items.json", original, &edits).unwrap_err();
        assert!(
            matches!(err, PatchbackError::StaleSource { .. }),
            "expected StaleSource, got {err:?}"
        );
        assert!(err.to_string().contains(PATCHBACK_STALE_SOURCE_CODE));
    }

    #[test]
    fn unresolved_surface_is_typed_error() {
        let original = br#"[null,{"id":1,"name":"Potion"}]"#;
        let edits = vec![edit(
            "rpgmaker:Items.json#/1/missing",
            &["1", "missing"],
            "x",
            "Potion",
        )];
        let err = patch_file_bytes("Items.json", original, &edits).unwrap_err();
        assert!(
            matches!(err, PatchbackError::UnresolvedSurface { .. }),
            "expected UnresolvedSurface, got {err:?}"
        );
    }
}
