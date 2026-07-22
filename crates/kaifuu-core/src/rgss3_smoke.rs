//! bounded RGSS3 / RPG Maker VX Ace extract→patch→rebuild→verify
//! smoke.
//! This module drives one bounded, end-to-end localization round-trip over the
//! RGSS3 layered transform, on PUBLIC SYNTHETIC fixtures only. It *composes* the
//! [`crate::rgss3_profile`] primitives — it does not reimplement the
//! container/codec/crypto:
//! - the synthetic RGSSAD v3 archive is built by
//!   [`crate::rgss3_profile::build_synthetic_rgss3a`] and decoded by
//!   [`crate::rgss3_profile::decode_synthetic_rgss3a`] (container + XOR crypto);
//! - the `.rvdata2` payloads are Ruby Marshal 4.8 blobs read/written by
//!   [`crate::rgss3_profile::read_marshal`] / [`crate::rgss3_profile::write_marshal`]
//!   (codec);
//! - the layered-transform tokens + patch-back dependency constraints come from
//!   the canonical [`crate::rgss3_profile::Rgss3LayeredTransformProfile`].
//! # The bounded path
//! 1. **EXTRACT** text-bearing data: decode the RGSSAD archive, then decode each
//!    `.rvdata2` payload to its Marshal object graph and walk it for the Ruby
//!    `String` leaves (the text-bearing data — dialogue / titles / speaker names).
//! 2. **PATCH** a TRIVIAL change: localize exactly one extracted string in place
//!    (a length-changing rewrite, so the codec length prefix + archive offsets
//!    must be recomputed — the [`StringTableRewriteBoundsUpdated`] and
//!    [`ArchiveOffsetsRecomputed`] patch-back dependencies).
//! 3. **REBUILD**: re-encode each Marshal tree, carry every other entry
//!    byte-exact, and repack the RGSSAD archive (reproducing the per-file XOR
//!    keystream + directory offsets — [`XorKeystreamReproduced`]).
//! 4. **VERIFY** through the layered transform metadata: the identity round-trip
//!    (rebuild(extract(x)) with no change) is byte-identical to the source; the
//!    patched round-trip carries the change and leaves every other entry
//!    byte-identical, and the patched entry's Marshal object graph differs at
//!    exactly the one localized path.
//! # Text-bearing scope (honest scoping)
//! "Text-bearing data" here is the set of Ruby `String` (`MarshalValue::ByteString`)
//! LEAVES in a `.rvdata2` object graph — this is where VX Ace stores dialogue,
//! titles, and system/term strings. Symbol tags and non-string scalars are NOT
//! treated as text and are carried structurally unchanged. `Scripts.rvdata2`
//! (Ruby code, additionally zlib-deflated inside the Marshal string) is OUT of
//! this bounded smoke's scope and is surfaced as a typed unsupported diagnostic
//! (it needs the [`ScriptsZlibRecompressed`] dependency this smoke does not
//! exercise), never silently dropped.
//! Everything here runs on bytes this module itself synthesises from known
//! values (see the fidelity boundary): before a production adapter
//! claims real-title extraction the RGSSAD constants must be validated against an
//! oracle (GARbro / rlvm) on real bytes — that is the adapter's job, not this
//! scaffold's.
//! [`StringTableRewriteBoundsUpdated`]: crate::rgss3_profile::Rgss3PatchBackDependency::StringTableRewriteBoundsUpdated
//! [`ArchiveOffsetsRecomputed`]: crate::rgss3_profile::Rgss3PatchBackDependency::ArchiveOffsetsRecomputed
//! [`XorKeystreamReproduced`]: crate::rgss3_profile::Rgss3PatchBackDependency::XorKeystreamReproduced
//! [`ScriptsZlibRecompressed`]: crate::rgss3_profile::Rgss3PatchBackDependency::ScriptsZlibRecompressed

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use crate::{
    KaifuuResult, OperationStatus, PartialDiagnosticSeverity, ProofHash, SemanticErrorCode,
    redact_for_log_or_report,
    rgss3_profile::{
        MarshalError, MarshalValue, Rgss3XorKeystreamScheme, RgssadError, build_synthetic_rgss3a,
        decode_synthetic_rgss3a, read_marshal, write_marshal,
    },
    sha256_hash_bytes, stable_json,
};

mod driver;
pub use driver::generate_rgss3_smoke;
#[cfg(test)]
use driver::{build_fixture_archive, synthetic_text_bearing_value};

/// Schema version of the RGSS3 smoke fixture + report.
pub const RGSS3_SMOKE_SCHEMA_VERSION: &str = "0.1.0";

/// Provenance node id stamped into generated reports.
pub const RGSS3_SMOKE_SOURCE_NODE_ID: &str = "KAIFUU-143";

/// Support boundary surfaced in every smoke report.
pub const RGSS3_SMOKE_SUPPORT_BOUNDARY: &str = "The RGSS3 smoke extracts the Ruby String leaves of a synthetic RGSSAD v3 archive's `.rvdata2` Marshal payloads, applies one trivial localization, repacks, and verifies the round-trip through the layered-transform metadata (container=rgssad, crypto=xor, codec=ruby_marshal, patch-back=repack_archive) on PUBLIC SYNTHETIC fixtures only. It requires no encryption key and no private corpus. `Scripts.rvdata2` (zlib-deflated Ruby code) and any Marshal type outside the bounded VX Ace subset are out of scope and are surfaced as typed unsupported diagnostics before any rebuild byte for that entry.";

/// The `.rvdata2` extension that marks a Ruby-Marshal, text-bearing entry.
const RVDATA2_EXTENSION: &str = ".rvdata2";

/// The `Scripts.rvdata2` member name — Ruby code, zlib-deflated inside the
/// Marshal string; out of this bounded smoke's scope.
const SCRIPTS_MEMBER_NAME: &str = "Data/Scripts.rvdata2";

// Marshal object-graph path — a structural, key-type-independent locator into a
// decoded `.rvdata2` tree. Used both to *report* an extracted string's location
// and to *navigate* to it for the in-place patch (no string parsing, no silent
// drop).

/// One navigation step into a decoded Marshal object graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarshalStep {
    /// The `index`-th element of a [`MarshalValue::Array`].
    Index(usize),
    /// The value of the `pair`-th key/value pair of a [`MarshalValue::Hash`]
    /// (insertion order — Marshal is order-significant).
    HashValueAt(usize),
}

/// A path from a `.rvdata2` root value to a leaf.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct MarshalPath(Vec<MarshalStep>);

impl MarshalPath {
    fn child(&self, step: MarshalStep) -> Self {
        let mut steps = self.0.clone();
        steps.push(step);
        Self(steps)
    }

    /// A stable, human-readable display of the path (e.g. `[2].{0}[1]`).
    fn locator(&self) -> String {
        if self.0.is_empty() {
            return "<root>".to_string();
        }
        let mut out = String::new();
        for step in &self.0 {
            match step {
                MarshalStep::Index(index) => {
                    let _ = write!(out, "[{index}]");
                }
                MarshalStep::HashValueAt(pair) => {
                    let _ = write!(out, ".{{{pair}}}");
                }
            }
        }
        out
    }

    fn get<'a>(&self, root: &'a MarshalValue) -> Option<&'a MarshalValue> {
        let mut cursor = root;
        for step in &self.0 {
            cursor = match (step, cursor) {
                (MarshalStep::Index(index), MarshalValue::Array(items)) => items.get(*index)?,
                (MarshalStep::HashValueAt(pair), MarshalValue::Hash(pairs)) => &pairs.get(*pair)?.1,
                _ => return None,
            };
        }
        Some(cursor)
    }

    fn get_mut<'a>(&self, root: &'a mut MarshalValue) -> Option<&'a mut MarshalValue> {
        let mut cursor = root;
        for step in &self.0 {
            cursor = match (step, cursor) {
                (MarshalStep::Index(index), MarshalValue::Array(items)) => items.get_mut(*index)?,
                (MarshalStep::HashValueAt(pair), MarshalValue::Hash(pairs)) => {
                    &mut pairs.get_mut(*pair)?.1
                }
                _ => return None,
            };
        }
        Some(cursor)
    }
}

/// Collect every Ruby `String` leaf (text-bearing data) in a decoded `.rvdata2`
/// object graph, in a deterministic pre-order walk, recording each leaf's path.
fn collect_text_paths(value: &MarshalValue, path: &MarshalPath, out: &mut Vec<MarshalPath>) {
    match value {
        MarshalValue::ByteString(_) => out.push(path.clone()),
        MarshalValue::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                collect_text_paths(item, &path.child(MarshalStep::Index(index)), out);
            }
        }
        MarshalValue::Hash(pairs) => {
            for (pair_index, (_, val)) in pairs.iter().enumerate() {
                collect_text_paths(val, &path.child(MarshalStep::HashValueAt(pair_index)), out);
            }
        }
        MarshalValue::Nil
        | MarshalValue::Bool(_)
        | MarshalValue::Int(_)
        | MarshalValue::Symbol(_) => {}
    }
}

/// The set of Marshal object-graph paths where two trees differ (leaf value
/// change or structural divergence). For the bounded smoke a single localized
/// string yields exactly one differing path.
fn marshal_structural_diff(old: &MarshalValue, new: &MarshalValue) -> Vec<MarshalPath> {
    let mut out = Vec::new();
    diff_into(old, new, &MarshalPath::default(), &mut out);
    out
}

fn diff_into(
    old: &MarshalValue,
    new: &MarshalValue,
    path: &MarshalPath,
    out: &mut Vec<MarshalPath>,
) {
    match (old, new) {
        (MarshalValue::Array(a), MarshalValue::Array(b)) if a.len() == b.len() => {
            for (index, (oa, ob)) in a.iter().zip(b.iter()).enumerate() {
                diff_into(oa, ob, &path.child(MarshalStep::Index(index)), out);
            }
        }
        (MarshalValue::Hash(a), MarshalValue::Hash(b)) if a.len() == b.len() => {
            for (pair_index, ((ka, va), (kb, vb))) in a.iter().zip(b.iter()).enumerate() {
                // A key change is itself a structural divergence at this pair.
                if ka == kb {
                    diff_into(
                        va,
                        vb,
                        &path.child(MarshalStep::HashValueAt(pair_index)),
                        out,
                    );
                } else {
                    out.push(path.child(MarshalStep::HashValueAt(pair_index)));
                }
            }
        }
        _ if old == new => {}
        _ => out.push(path.clone()),
    }
}

// Extraction / rebuild

/// A decoded RGSSAD entry's payload: either a text-bearing Marshal object graph
/// or opaque bytes carried through byte-exact.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Rgss3EntryPayload {
    /// A decoded `.rvdata2` Marshal object graph (text-bearing).
    Marshal(MarshalValue),
    /// A non-`.rvdata2` (or otherwise out-of-scope) entry carried byte-exact.
    Opaque(Vec<u8>),
}

/// One extracted archive entry.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Rgss3ExtractedEntry {
    name: String,
    payload: Rgss3EntryPayload,
}

/// The full extraction of a synthetic RGSSAD v3 archive: the header seed plus
/// every decoded entry, in archive order.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Rgss3Extraction {
    scheme: Rgss3XorKeystreamScheme,
    seed: u32,
    entries: Vec<Rgss3ExtractedEntry>,
}

/// A typed extraction error — never a panic, never a silent drop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rgss3ExtractError {
    /// The RGSSAD container could not be decoded.
    Container(RgssadError),
    /// A `.rvdata2` entry's Marshal codec could not be decoded (a type tag
    /// outside the bounded VX Ace subset, a truncated stream, etc.).
    Codec { entry: String, error: MarshalError },
    /// A `Scripts.rvdata2` entry was found — Ruby code, zlib-deflated inside the
    /// Marshal string, out of this bounded smoke's scope.
    ScriptsOutOfScope { entry: String },
}

impl std::fmt::Display for Rgss3ExtractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Container(error) => write!(f, "RGSSAD container decode failed: {error}"),
            Self::Codec { entry, error } => {
                write!(f, "Marshal codec decode failed for {entry}: {error}")
            }
            Self::ScriptsOutOfScope { entry } => write!(
                f,
                "{entry} is Ruby code (zlib-deflated) and is out of the bounded smoke's scope"
            ),
        }
    }
}

impl std::error::Error for Rgss3ExtractError {}

impl Rgss3ExtractError {
    fn semantic_code(&self) -> SemanticErrorCode {
        match self {
            Self::Container(_) => SemanticErrorCode::MissingContainerCapability,
            Self::Codec { .. } => SemanticErrorCode::MissingCodecCapability,
            // Scripts needs the zlib recompress dependency this smoke doesn't run.
            Self::ScriptsOutOfScope { .. } => SemanticErrorCode::UnsupportedLayeredTransform,
        }
    }
}

/// A typed patch error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rgss3PatchError {
    /// The entry index is out of range.
    EntryOutOfRange(usize),
    /// The target entry is not a decoded Marshal tree (it is opaque).
    EntryNotMarshal(String),
    /// The path does not resolve to a text-bearing (`String`) leaf.
    NotATextLeaf { entry: String, locator: String },
}

impl std::fmt::Display for Rgss3PatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EntryOutOfRange(index) => write!(f, "entry index {index} out of range"),
            Self::EntryNotMarshal(entry) => write!(f, "entry {entry} is not a Marshal tree"),
            Self::NotATextLeaf { entry, locator } => {
                write!(f, "path {locator} in {entry} is not a text leaf")
            }
        }
    }
}

impl std::error::Error for Rgss3PatchError {}

/// Extract a synthetic RGSSAD v3 archive into its decoded entries. Every
/// `.rvdata2` entry is decoded through the Marshal codec; a decode failure or an
/// out-of-scope `Scripts.rvdata2` is a typed error, never a silent drop.
fn extract_rgss3(
    scheme: Rgss3XorKeystreamScheme,
    bytes: &[u8],
) -> Result<Rgss3Extraction, Rgss3ExtractError> {
    let seed = read_seed(bytes).map_err(Rgss3ExtractError::Container)?;
    let raw = decode_synthetic_rgss3a(scheme, bytes).map_err(Rgss3ExtractError::Container)?;

    let mut entries = Vec::with_capacity(raw.len());
    for entry in raw {
        if entry.name == SCRIPTS_MEMBER_NAME {
            return Err(Rgss3ExtractError::ScriptsOutOfScope { entry: entry.name });
        }
        let payload = if entry.name.ends_with(RVDATA2_EXTENSION) {
            match read_marshal(&entry.payload) {
                Ok(value) => Rgss3EntryPayload::Marshal(value),
                Err(error) => {
                    return Err(Rgss3ExtractError::Codec {
                        entry: entry.name,
                        error,
                    });
                }
            }
        } else {
            Rgss3EntryPayload::Opaque(entry.payload)
        };
        entries.push(Rgss3ExtractedEntry {
            name: entry.name,
            payload,
        });
    }

    Ok(Rgss3Extraction {
        scheme,
        seed,
        entries,
    })
}

/// Read the RGSSAD header seed without a full decode (the seed is stored plain at
/// offset 8, after `RGSSAD\0` + version).
fn read_seed(bytes: &[u8]) -> Result<u32, RgssadError> {
    if bytes.len() < 8 || bytes[0..7] != crate::rgss3_profile::RGSSAD_MAGIC {
        return Err(RgssadError::BadMagic);
    }
    if bytes[7] != crate::rgss3_profile::RGSS3_ARCHIVE_VERSION {
        return Err(RgssadError::BadVersion(bytes[7]));
    }
    let slice = bytes.get(8..12).ok_or(RgssadError::UnexpectedEof)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

impl Rgss3Extraction {
    /// Every text-bearing (`String`) leaf across all Marshal entries, in a
    /// deterministic order, with its entry id, path locator, and current text.
    fn text_units(&self) -> Vec<(usize, MarshalPath, String)> {
        let mut units = Vec::new();
        for (entry_index, entry) in self.entries.iter().enumerate() {
            if let Rgss3EntryPayload::Marshal(value) = &entry.payload {
                let mut paths = Vec::new();
                collect_text_paths(value, &MarshalPath::default(), &mut paths);
                for path in paths {
                    let text = path
                        .get(value)
                        .and_then(MarshalValue::as_str_lossy)
                        .unwrap_or_default();
                    units.push((entry_index, path, text));
                }
            }
        }
        units
    }

    /// Localize the string at `path` in entry `entry_index` to `new_text`,
    /// returning the previous text. A path that is not a text leaf is a typed
    /// error, never a silent no-op.
    fn localize(
        &mut self,
        entry_index: usize,
        path: &MarshalPath,
        new_text: &str,
    ) -> Result<String, Rgss3PatchError> {
        let entry = self
            .entries
            .get_mut(entry_index)
            .ok_or(Rgss3PatchError::EntryOutOfRange(entry_index))?;
        let entry_name = entry.name.clone();
        let Rgss3EntryPayload::Marshal(value) = &mut entry.payload else {
            return Err(Rgss3PatchError::EntryNotMarshal(entry_name));
        };
        let leaf = path
            .get_mut(value)
            .ok_or_else(|| Rgss3PatchError::NotATextLeaf {
                entry: entry_name.clone(),
                locator: path.locator(),
            })?;
        let MarshalValue::ByteString(bytes) = leaf else {
            return Err(Rgss3PatchError::NotATextLeaf {
                entry: entry_name,
                locator: path.locator(),
            });
        };
        let previous = String::from_utf8_lossy(bytes).into_owned();
        *bytes = new_text.as_bytes().to_vec();
        Ok(previous)
    }
}

/// Rebuild an RGSSAD v3 archive from an extraction: re-encode each Marshal tree
/// (recomputing the Marshal length prefixes), carry opaque entries byte-exact,
/// and repack (reproducing the per-file XOR keystream + directory offsets). For
/// an unmodified extraction this is byte-identical to the source archive.
fn rebuild_rgss3(extraction: &Rgss3Extraction) -> Vec<u8> {
    let encoded: Vec<(String, Vec<u8>)> = extraction
        .entries
        .iter()
        .map(|entry| {
            let bytes = match &entry.payload {
                Rgss3EntryPayload::Marshal(value) => write_marshal(value),
                Rgss3EntryPayload::Opaque(bytes) => bytes.clone(),
            };
            (entry.name.clone(), bytes)
        })
        .collect();
    let refs: Vec<(&str, &[u8])> = encoded
        .iter()
        .map(|(name, bytes)| (name.as_str(), bytes.as_slice()))
        .collect();
    build_synthetic_rgss3a(extraction.scheme, extraction.seed, &refs)
}

// Report types (the layered-transform metadata verification)

fn proof_hash(bytes: &[u8]) -> KaifuuResult<ProofHash> {
    ProofHash::new(sha256_hash_bytes(bytes)).map_err(Into::into)
}

#[path = "rgss3_smoke/report.rs"]
mod report;
pub use report::*;

#[cfg(test)]
#[path = "rgss3_smoke/tests.rs"]
mod tests;
