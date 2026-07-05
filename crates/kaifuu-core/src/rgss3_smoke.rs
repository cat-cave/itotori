//! KAIFUU-143 — bounded RGSS3 / RPG Maker VX Ace extract→patch→rebuild→verify
//! smoke.
//!
//! This module drives one bounded, end-to-end localization round-trip over the
//! RGSS3 layered transform, on PUBLIC SYNTHETIC fixtures only. It *composes* the
//! KAIFUU-055 [`crate::rgss3_profile`] primitives — it does not reimplement the
//! container/codec/crypto:
//!
//! - the synthetic RGSSAD v3 archive is built by
//!   [`crate::rgss3_profile::build_synthetic_rgss3a`] and decoded by
//!   [`crate::rgss3_profile::decode_synthetic_rgss3a`] (container + XOR crypto);
//! - the `.rvdata2` payloads are Ruby Marshal 4.8 blobs read/written by
//!   [`crate::rgss3_profile::read_marshal`] / [`crate::rgss3_profile::write_marshal`]
//!   (codec);
//! - the layered-transform tokens + patch-back dependency constraints come from
//!   the canonical [`crate::rgss3_profile::Rgss3LayeredTransformProfile`].
//!
//! # The bounded path
//!
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
//!
//! # Text-bearing scope (honest scoping)
//!
//! "Text-bearing data" here is the set of Ruby `String` (`MarshalValue::ByteString`)
//! LEAVES in a `.rvdata2` object graph — this is where VX Ace stores dialogue,
//! titles, and system/term strings. Symbol tags and non-string scalars are NOT
//! treated as text and are carried structurally unchanged. `Scripts.rvdata2`
//! (Ruby code, additionally zlib-deflated inside the Marshal string) is OUT of
//! this bounded smoke's scope and is surfaced as a typed unsupported diagnostic
//! (it needs the [`ScriptsZlibRecompressed`] dependency this smoke does not
//! exercise), never silently dropped.
//!
//! Everything here runs on bytes this module itself synthesises from known
//! values (see the KAIFUU-055 fidelity boundary): before a production adapter
//! claims real-title extraction the RGSSAD constants must be validated against an
//! oracle (GARbro / rlvm) on real bytes — that is the adapter's job, not this
//! scaffold's.
//!
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
        MarshalError, MarshalValue, Rgss3LayeredTransformProfile, Rgss3PatchBackDependency,
        Rgss3XorKeystreamScheme, RgssadError, build_synthetic_rgss3a, decode_synthetic_rgss3a,
        read_marshal, write_marshal,
    },
    sha256_hash_bytes, stable_json,
};

/// Schema version of the RGSS3 smoke fixture + report.
pub const RGSS3_SMOKE_SCHEMA_VERSION: &str = "0.1.0";

/// The spec-DAG node this smoke is authored for.
pub const RGSS3_SMOKE_SOURCE_NODE_ID: &str = "KAIFUU-143";

/// Support boundary surfaced in every smoke report.
pub const RGSS3_SMOKE_SUPPORT_BOUNDARY: &str = "The RGSS3 smoke extracts the Ruby String leaves of a synthetic RGSSAD v3 archive's `.rvdata2` Marshal payloads, applies one trivial localization, repacks, and verifies the round-trip through the layered-transform metadata (container=rgssad, crypto=xor, codec=ruby_marshal, patch-back=repack_archive) on PUBLIC SYNTHETIC fixtures only. It requires no encryption key and no private corpus. `Scripts.rvdata2` (zlib-deflated Ruby code) and any Marshal type outside the bounded VX Ace subset are out of scope and are surfaced as typed unsupported diagnostics before any rebuild byte for that entry.";

/// The `.rvdata2` extension that marks a Ruby-Marshal, text-bearing entry.
const RVDATA2_EXTENSION: &str = ".rvdata2";

/// The `Scripts.rvdata2` member name — Ruby code, zlib-deflated inside the
/// Marshal string; out of this bounded smoke's scope.
const SCRIPTS_MEMBER_NAME: &str = "Data/Scripts.rvdata2";

// ===========================================================================
// Marshal object-graph path — a structural, key-type-independent locator into a
// decoded `.rvdata2` tree. Used both to *report* an extracted string's location
// and to *navigate* to it for the in-place patch (no string parsing, no silent
// drop).
// ===========================================================================

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

// ===========================================================================
// Extraction / rebuild
// ===========================================================================

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

// ===========================================================================
// Report types (the layered-transform metadata verification)
// ===========================================================================

fn proof_hash(bytes: &[u8]) -> KaifuuResult<ProofHash> {
    ProofHash::new(sha256_hash_bytes(bytes)).map_err(Into::into)
}

/// A structured smoke finding — typed, never a bare string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3SmokeFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub semantic_code: String,
    pub message: String,
}

impl Rgss3SmokeFinding {
    fn redacted(&self) -> Self {
        Self {
            code: self.code.clone(),
            severity: self.severity,
            field: self.field.clone(),
            semantic_code: self.semantic_code.clone(),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

/// One extracted text unit surfaced in the report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3TextUnitReport {
    /// The in-archive entry id the string was extracted from.
    pub entry_id: String,
    /// The Marshal object-graph locator of the string.
    pub locator: String,
    /// A lossy UTF-8 view of the extracted string (synthetic, public).
    pub text: String,
}

/// The identity round-trip proof: rebuild(extract(x)) with no change == x.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3IdentityReport {
    pub byte_identical: bool,
    pub source_hash: ProofHash,
    pub rebuilt_hash: ProofHash,
    pub source_bytes: u64,
    pub rebuilt_bytes: u64,
}

/// The trivial-change proof: the localized string is present, the patched entry
/// diverges at exactly one Marshal path, and every other entry stays
/// byte-identical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3PatchReport {
    pub entry_id: String,
    pub locator: String,
    pub old_text: String,
    pub new_text: String,
    /// The rebuilt archive carries the new text and not the old text.
    pub change_applied: bool,
    /// Length delta of the localized string (proves the bounds/offsets were
    /// recomputed, not a same-length in-place poke).
    pub length_delta: i64,
    /// Marshal object-graph paths at which the patched entry diverges from the
    /// source (exactly one for the trivial change).
    pub diverging_paths: Vec<String>,
    /// Every archive entry other than the patched one is byte-identical to the
    /// source (decrypted-payload comparison).
    pub other_entries_byte_identical: bool,
}

/// Per-layer verification outcome — the layered transform metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3LayerVerification {
    /// container=rgssad
    pub container_transform: String,
    pub entry_names_preserved: bool,
    pub entry_count: u64,
    /// crypto=xor
    pub crypto_transform: String,
    /// The rebuilt archive re-applies the XOR keystream (ciphertext != plaintext)
    /// yet decrypts back to the intended payloads.
    pub keystream_reproduced: bool,
    /// codec=ruby_marshal
    pub codec_transform: String,
    /// patch-back=repack_archive
    pub patch_back_transform: String,
    /// The patch-back dependency tokens this round-trip exercised.
    pub dependencies_exercised: Vec<String>,
}

/// The full RGSS3 smoke report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3SmokeReport {
    pub schema_version: String,
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    /// The archive entry ids, in archive order.
    pub entry_ids: Vec<String>,
    pub text_units: Vec<Rgss3TextUnitReport>,
    pub identity: Rgss3IdentityReport,
    pub patch: Rgss3PatchReport,
    pub layers: Rgss3LayerVerification,
    /// Typed unsupported diagnostics (negative cases) — explicit, never dropped.
    pub unsupported: Vec<Rgss3UnsupportedReport>,
    pub findings: Vec<Rgss3SmokeFinding>,
}

impl Rgss3SmokeReport {
    fn redacted(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: self.source_node_id.clone(),
            engine_family: self.engine_family.clone(),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            entry_ids: self.entry_ids.clone(),
            text_units: self.text_units.clone(),
            identity: self.identity.clone(),
            patch: self.patch.clone(),
            layers: self.layers.clone(),
            unsupported: self
                .unsupported
                .iter()
                .map(Rgss3UnsupportedReport::redacted)
                .collect(),
            findings: self
                .findings
                .iter()
                .map(Rgss3SmokeFinding::redacted)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted())
    }

    pub fn is_ok(&self) -> bool {
        self.status == OperationStatus::Passed
    }
}

// ===========================================================================
// Unsupported (negative) cases — explicit typed diagnostics
// ===========================================================================

/// The unsupported class a negative case exercises.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rgss3UnsupportedKind {
    /// The container bytes are not a valid RGSSAD v3 archive.
    BadContainer,
    /// A `.rvdata2` payload uses a Marshal type outside the bounded subset.
    UnsupportedMarshalType,
    /// A `Scripts.rvdata2` (zlib-deflated Ruby code) entry is out of scope.
    ScriptsOutOfScope,
    /// A patch targeted a non-text (non-`String`) Marshal node.
    PatchTargetNotText,
}

impl Rgss3UnsupportedKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BadContainer => "bad_container",
            Self::UnsupportedMarshalType => "unsupported_marshal_type",
            Self::ScriptsOutOfScope => "scripts_out_of_scope",
            Self::PatchTargetNotText => "patch_target_not_text",
        }
    }
}

/// A typed unsupported diagnostic surfaced by a negative case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3UnsupportedReport {
    pub case_id: String,
    pub kind: Rgss3UnsupportedKind,
    /// True when the case was rejected with a typed diagnostic before any rebuild
    /// byte was produced for the offending entry.
    pub rejected_before_rebuild: bool,
    pub semantic_code: String,
    pub message: String,
}

impl Rgss3UnsupportedReport {
    fn redacted(&self) -> Self {
        Self {
            case_id: self.case_id.clone(),
            kind: self.kind,
            rejected_before_rebuild: self.rejected_before_rebuild,
            semantic_code: self.semantic_code.clone(),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

// ===========================================================================
// Synthetic fixture (public, in-module — no retail bytes)
// ===========================================================================

/// The seed of the canonical synthetic fixture archive.
const FIXTURE_SEED: u32 = 0x1234_5678;

/// The synthetic fixture's text-bearing `.rvdata2` object graph: a VX Ace
/// `System`/`CommonEvent`-style record with a title, a nested message list, and
/// a speaker — all from KNOWN synthetic values, no retail bytes.
fn synthetic_text_bearing_value() -> MarshalValue {
    MarshalValue::Array(vec![
        MarshalValue::Int(1),
        MarshalValue::ByteString(b"Prologue".to_vec()),
        MarshalValue::Hash(vec![
            (
                MarshalValue::Symbol("messages".to_string()),
                MarshalValue::Array(vec![
                    MarshalValue::ByteString("Hello, traveler.".as_bytes().to_vec()),
                    MarshalValue::ByteString("Welcome to the village.".as_bytes().to_vec()),
                    MarshalValue::ByteString("Safe travels.".as_bytes().to_vec()),
                ]),
            ),
            (
                MarshalValue::Symbol("speaker".to_string()),
                MarshalValue::ByteString("Guide".as_bytes().to_vec()),
            ),
            (
                MarshalValue::Symbol("visited".to_string()),
                MarshalValue::Bool(false),
            ),
        ]),
    ])
}

/// Build the canonical synthetic RGSSAD v3 fixture archive: a text-bearing
/// `System.rvdata2` Marshal payload plus an opaque `Map001.rvdata2` binary entry.
fn build_fixture_archive(scheme: Rgss3XorKeystreamScheme) -> Vec<u8> {
    let system_payload = write_marshal(&synthetic_text_bearing_value());
    // A non-`.rvdata2` asset (a synthetic PNG-shaped blob) carried byte-exact —
    // proves the opaque path leaves non-text entries untouched.
    let asset_payload: &[u8] = b"\x89PNG\r\n\x1a\n synthetic title art \x00\x01\x02\x03\xff";
    let entries: Vec<(&str, &[u8])> = vec![
        ("Data/System.rvdata2", system_payload.as_slice()),
        ("Graphics/Titles/Title.png", asset_payload),
    ];
    build_synthetic_rgss3a(scheme, FIXTURE_SEED, &entries)
}

// ===========================================================================
// The smoke driver
// ===========================================================================

/// Run the bounded RGSS3 extract→patch→rebuild→verify smoke on the in-module
/// public synthetic fixture.
///
/// Returns `Err` only on an environmental failure (e.g. a hashing failure the
/// report cannot represent). Extraction / patch / verification / unsupported
/// outcomes are folded into the report's `status` and typed diagnostics.
pub fn generate_rgss3_smoke() -> KaifuuResult<Rgss3SmokeReport> {
    let profile = Rgss3LayeredTransformProfile::canonical();
    let scheme = profile.crypto_scheme;
    let mut findings = Vec::new();

    // --- Fixture + EXTRACT ---------------------------------------------------
    let source = build_fixture_archive(scheme);
    let source_hash = proof_hash(&source)?;
    let extraction = extract_rgss3(scheme, &source)
        .map_err(|error| format!("synthetic fixture must extract cleanly: {error}"))?;
    let entry_ids: Vec<String> = extraction.entries.iter().map(|e| e.name.clone()).collect();

    let text_units_raw = extraction.text_units();
    let text_units: Vec<Rgss3TextUnitReport> = text_units_raw
        .iter()
        .map(|(entry_index, path, text)| Rgss3TextUnitReport {
            entry_id: extraction.entries[*entry_index].name.clone(),
            locator: path.locator(),
            text: text.clone(),
        })
        .collect();
    if text_units.is_empty() {
        findings.push(finding(
            "rgss3.smoke.no_text_extracted",
            PartialDiagnosticSeverity::P0,
            "textUnits",
            SemanticErrorCode::MissingCodecCapability,
            "no text-bearing data extracted from the synthetic fixture".to_string(),
        ));
    }

    // --- IDENTITY round-trip (no change) -------------------------------------
    let identity_rebuilt = rebuild_rgss3(&extraction);
    let identity_byte_identical = identity_rebuilt == source;
    if !identity_byte_identical {
        findings.push(finding(
            "rgss3.smoke.identity_not_byte_preserving",
            PartialDiagnosticSeverity::P0,
            "identity",
            SemanticErrorCode::MissingPatchBackCapability,
            "rebuild(extract(x)) with no change was not byte-identical to the source".to_string(),
        ));
    }
    let identity = Rgss3IdentityReport {
        byte_identical: identity_byte_identical,
        source_hash: source_hash.clone(),
        rebuilt_hash: proof_hash(&identity_rebuilt)?,
        source_bytes: source.len() as u64,
        rebuilt_bytes: identity_rebuilt.len() as u64,
    };

    // --- PATCH one string (trivial, length-changing localization) ------------
    // Target the first text-bearing string of the System entry (its title).
    let (target_entry, target_path, old_text) = text_units_raw
        .iter()
        .find(|(entry_index, _, _)| extraction.entries[*entry_index].name == "Data/System.rvdata2")
        .cloned()
        .ok_or("synthetic fixture must contain a System.rvdata2 text unit")?;
    // A length-changing localization (proves bounds + offsets are recomputed).
    let new_text = "Josho: Tabidachi no Hi";
    let length_delta = new_text.len() as i64 - old_text.len() as i64;

    let mut patched = extraction.clone();
    let applied_old = patched
        .localize(target_entry, &target_path, new_text)
        .map_err(|error| format!("trivial localization must apply: {error}"))?;

    // --- REBUILD the patched archive -----------------------------------------
    let patched_rebuilt = rebuild_rgss3(&patched);

    // --- VERIFY through the layered transform metadata -----------------------
    // Re-extract both archives and compare layer by layer.
    let source_entries = decode_synthetic_rgss3a(scheme, &source)
        .map_err(|error| format!("re-decode source: {error}"))?;
    let patched_entries = decode_synthetic_rgss3a(scheme, &patched_rebuilt)
        .map_err(|error| format!("re-decode patched: {error}"))?;

    // Container layer: entry names + count preserved.
    let entry_names_preserved = source_entries.len() == patched_entries.len()
        && source_entries
            .iter()
            .zip(patched_entries.iter())
            .all(|(a, b)| a.name == b.name);

    // Crypto layer: the patched archive is genuinely re-obfuscated (its raw bytes
    // do not contain the new plaintext) yet decrypts back to it.
    let keystream_reproduced = !patched_rebuilt
        .windows(new_text.len())
        .any(|w| w == new_text.as_bytes())
        && patched_entries.iter().any(|e| {
            read_marshal(&e.payload)
                .ok()
                .is_some_and(|v| marshal_contains_text(&v, new_text))
        });

    // Patch-back layer: every entry other than the patched one is byte-identical.
    let mut other_entries_byte_identical = true;
    for (index, (src, pat)) in source_entries
        .iter()
        .zip(patched_entries.iter())
        .enumerate()
    {
        if index == target_entry {
            continue;
        }
        if src.payload != pat.payload {
            other_entries_byte_identical = false;
        }
    }

    // Codec layer: the patched entry diverges at exactly one Marshal path.
    let source_tree = read_marshal(&source_entries[target_entry].payload)
        .map_err(|error| format!("decode source patched entry: {error}"))?;
    let patched_tree = read_marshal(&patched_entries[target_entry].payload)
        .map_err(|error| format!("decode patched entry: {error}"))?;
    let diverging = marshal_structural_diff(&source_tree, &patched_tree);
    let diverging_paths: Vec<String> = diverging.iter().map(MarshalPath::locator).collect();
    let single_divergence = diverging.len() == 1 && diverging[0] == target_path;

    // The rebuilt archive carries the new text, not the old text.
    let change_applied = marshal_contains_text(&patched_tree, new_text)
        && !marshal_contains_text(&patched_tree, &applied_old);

    if !change_applied {
        findings.push(finding(
            "rgss3.smoke.change_not_applied",
            PartialDiagnosticSeverity::P0,
            "patch",
            SemanticErrorCode::MissingCodecCapability,
            "the localized string was not present in the rebuilt archive".to_string(),
        ));
    }
    if !single_divergence {
        findings.push(finding(
            "rgss3.smoke.unexpected_divergence",
            PartialDiagnosticSeverity::P0,
            "patch",
            SemanticErrorCode::MissingCodecCapability,
            format!(
                "patched entry diverged at {} paths, expected exactly the localized one",
                diverging.len()
            ),
        ));
    }
    if !other_entries_byte_identical {
        findings.push(finding(
            "rgss3.smoke.collateral_change",
            PartialDiagnosticSeverity::P0,
            "patch",
            SemanticErrorCode::MissingPatchBackCapability,
            "a non-patched entry changed during the patched rebuild".to_string(),
        ));
    }
    if !entry_names_preserved {
        findings.push(finding(
            "rgss3.smoke.entry_names_changed",
            PartialDiagnosticSeverity::P0,
            "layers.container",
            SemanticErrorCode::MissingContainerCapability,
            "the archive entry set changed across the rebuild".to_string(),
        ));
    }
    if !keystream_reproduced {
        findings.push(finding(
            "rgss3.smoke.keystream_not_reproduced",
            PartialDiagnosticSeverity::P0,
            "layers.crypto",
            SemanticErrorCode::MissingCryptoCapability,
            "the rebuilt archive did not reproduce the XOR keystream".to_string(),
        ));
    }

    let patch = Rgss3PatchReport {
        entry_id: extraction.entries[target_entry].name.clone(),
        locator: target_path.locator(),
        old_text: applied_old,
        new_text: new_text.to_string(),
        change_applied,
        length_delta,
        diverging_paths,
        other_entries_byte_identical,
    };

    // The patch-back dependencies this bounded round-trip actually exercised.
    let dependencies_exercised = vec![
        Rgss3PatchBackDependency::MarshalStructurePreserved
            .as_str()
            .to_string(),
        Rgss3PatchBackDependency::StringTableRewriteBoundsUpdated
            .as_str()
            .to_string(),
        Rgss3PatchBackDependency::XorKeystreamReproduced
            .as_str()
            .to_string(),
        Rgss3PatchBackDependency::ArchiveOffsetsRecomputed
            .as_str()
            .to_string(),
    ];

    let layers = Rgss3LayerVerification {
        container_transform: format!("{:?}", profile.container).to_lowercase(),
        entry_names_preserved,
        entry_count: source_entries.len() as u64,
        crypto_transform: format!("{:?}", profile.crypto).to_lowercase(),
        keystream_reproduced,
        codec_transform: "ruby_marshal".to_string(),
        patch_back_transform: "repack_archive".to_string(),
        dependencies_exercised,
    };

    // --- Unsupported (negative) cases ----------------------------------------
    let unsupported = evaluate_unsupported_cases(scheme);
    for case in &unsupported {
        if !case.rejected_before_rebuild {
            findings.push(finding(
                "rgss3.smoke.unsupported_not_rejected",
                PartialDiagnosticSeverity::P0,
                "unsupported",
                SemanticErrorCode::UnsupportedLayeredTransform,
                format!(
                    "unsupported case {} was not rejected with a typed diagnostic",
                    case.case_id
                ),
            ));
        }
    }

    let status = if findings.iter().any(|f| f.severity.is_blocking()) {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    Ok(Rgss3SmokeReport {
        schema_version: RGSS3_SMOKE_SCHEMA_VERSION.to_string(),
        fixture_id: "fixture/rgss3/vx-ace/localization-smoke".to_string(),
        source_node_id: RGSS3_SMOKE_SOURCE_NODE_ID.to_string(),
        engine_family: profile.engine_family.clone(),
        support_boundary: RGSS3_SMOKE_SUPPORT_BOUNDARY.to_string(),
        status,
        entry_ids,
        text_units,
        identity,
        patch,
        layers,
        unsupported,
        findings,
    })
}

/// Whether any `String` leaf in a Marshal tree equals `needle`.
fn marshal_contains_text(value: &MarshalValue, needle: &str) -> bool {
    match value {
        MarshalValue::ByteString(bytes) => bytes.as_slice() == needle.as_bytes(),
        MarshalValue::Array(items) => items.iter().any(|v| marshal_contains_text(v, needle)),
        MarshalValue::Hash(pairs) => pairs.iter().any(|(_, v)| marshal_contains_text(v, needle)),
        MarshalValue::Nil
        | MarshalValue::Bool(_)
        | MarshalValue::Int(_)
        | MarshalValue::Symbol(_) => false,
    }
}

/// Build + evaluate the negative cases, each producing a typed unsupported
/// diagnostic. Every case must be rejected before any rebuild byte for the
/// offending entry.
fn evaluate_unsupported_cases(scheme: Rgss3XorKeystreamScheme) -> Vec<Rgss3UnsupportedReport> {
    let mut cases = Vec::new();

    // 1. Bad container: not an RGSSAD archive at all.
    let bad = b"NOTRGSS\x03 garbage bytes that are not a real archive";
    let report = match extract_rgss3(scheme, bad) {
        Err(error @ Rgss3ExtractError::Container(_)) => Rgss3UnsupportedReport {
            case_id: "bad-container".to_string(),
            kind: Rgss3UnsupportedKind::BadContainer,
            rejected_before_rebuild: true,
            semantic_code: error.semantic_code().as_str().to_string(),
            message: error.to_string(),
        },
        other => did_not_reject("bad-container", Rgss3UnsupportedKind::BadContainer, other),
    };
    cases.push(report);

    // 2. Unsupported Marshal type: a `.rvdata2` payload using a type tag outside
    //    the bounded subset (`c` = class), which the codec rejects (no silent
    //    drop of the entry's text).
    let bad_marshal = vec![0x04u8, 0x08, b'c'];
    let archive = build_synthetic_rgss3a(scheme, 7, &[("Data/System.rvdata2", &bad_marshal)]);
    let report = match extract_rgss3(scheme, &archive) {
        Err(error @ Rgss3ExtractError::Codec { .. }) => Rgss3UnsupportedReport {
            case_id: "unsupported-marshal-type".to_string(),
            kind: Rgss3UnsupportedKind::UnsupportedMarshalType,
            rejected_before_rebuild: true,
            semantic_code: error.semantic_code().as_str().to_string(),
            message: error.to_string(),
        },
        other => did_not_reject(
            "unsupported-marshal-type",
            Rgss3UnsupportedKind::UnsupportedMarshalType,
            other,
        ),
    };
    cases.push(report);

    // 3. Scripts.rvdata2 (zlib-deflated Ruby code) is out of scope.
    let scripts = build_synthetic_rgss3a(scheme, 9, &[(SCRIPTS_MEMBER_NAME, b"\x04\x08[\x00")]);
    let report = match extract_rgss3(scheme, &scripts) {
        Err(error @ Rgss3ExtractError::ScriptsOutOfScope { .. }) => Rgss3UnsupportedReport {
            case_id: "scripts-out-of-scope".to_string(),
            kind: Rgss3UnsupportedKind::ScriptsOutOfScope,
            rejected_before_rebuild: true,
            semantic_code: error.semantic_code().as_str().to_string(),
            message: error.to_string(),
        },
        other => did_not_reject(
            "scripts-out-of-scope",
            Rgss3UnsupportedKind::ScriptsOutOfScope,
            other,
        ),
    };
    cases.push(report);

    // 4. Patch target is not a text leaf: localizing an Int node is a typed error.
    let good = build_fixture_archive(scheme);
    let report = match extract_rgss3(scheme, &good) {
        Ok(mut extraction) => {
            // Path [0] of System.rvdata2 is the Int(1) header — not a String.
            let int_path = MarshalPath(vec![MarshalStep::Index(0)]);
            match extraction.localize(0, &int_path, "not text") {
                Err(error @ Rgss3PatchError::NotATextLeaf { .. }) => Rgss3UnsupportedReport {
                    case_id: "patch-target-not-text".to_string(),
                    kind: Rgss3UnsupportedKind::PatchTargetNotText,
                    rejected_before_rebuild: true,
                    semantic_code: SemanticErrorCode::MissingCodecCapability
                        .as_str()
                        .to_string(),
                    message: error.to_string(),
                },
                other => Rgss3UnsupportedReport {
                    case_id: "patch-target-not-text".to_string(),
                    kind: Rgss3UnsupportedKind::PatchTargetNotText,
                    rejected_before_rebuild: false,
                    semantic_code: SemanticErrorCode::MissingCodecCapability
                        .as_str()
                        .to_string(),
                    message: format!("expected a NotATextLeaf error, got {other:?}"),
                },
            }
        }
        Err(error) => Rgss3UnsupportedReport {
            case_id: "patch-target-not-text".to_string(),
            kind: Rgss3UnsupportedKind::PatchTargetNotText,
            rejected_before_rebuild: false,
            semantic_code: error.semantic_code().as_str().to_string(),
            message: format!("fixture extraction failed: {error}"),
        },
    };
    cases.push(report);

    cases
}

fn did_not_reject(
    case_id: &str,
    kind: Rgss3UnsupportedKind,
    got: Result<Rgss3Extraction, Rgss3ExtractError>,
) -> Rgss3UnsupportedReport {
    let detail = match got {
        Ok(_) => "extraction unexpectedly succeeded".to_string(),
        Err(error) => format!("wrong error class: {error}"),
    };
    Rgss3UnsupportedReport {
        case_id: case_id.to_string(),
        kind,
        rejected_before_rebuild: false,
        semantic_code: SemanticErrorCode::UnsupportedLayeredTransform
            .as_str()
            .to_string(),
        message: detail,
    }
}

fn finding(
    code: &str,
    severity: PartialDiagnosticSeverity,
    field: &str,
    semantic_code: SemanticErrorCode,
    message: String,
) -> Rgss3SmokeFinding {
    Rgss3SmokeFinding {
        code: code.to_string(),
        severity,
        field: field.to_string(),
        semantic_code: semantic_code.as_str().to_string(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Deliverable 2: the bounded extract→patch→rebuild→verify path --------

    #[test]
    fn smoke_passes_and_verifies_all_layers() {
        let report = generate_rgss3_smoke().expect("smoke runs");
        assert_eq!(report.status, OperationStatus::Passed, "{report:#?}");
        assert!(report.findings.is_empty(), "{:#?}", report.findings);
        assert_eq!(report.engine_family, "rgss3");
        // The layered-transform metadata is present and pinned.
        assert_eq!(report.layers.container_transform, "rgssad");
        assert_eq!(report.layers.crypto_transform, "xor");
        assert_eq!(report.layers.codec_transform, "ruby_marshal");
        assert_eq!(report.layers.patch_back_transform, "repack_archive");
        assert!(report.layers.entry_names_preserved);
        assert!(report.layers.keystream_reproduced);
        assert_eq!(report.layers.entry_count, 2);
    }

    #[test]
    fn extracts_text_bearing_data() {
        let report = generate_rgss3_smoke().expect("smoke runs");
        // Title, 3 messages, speaker = 5 text units, all from System.rvdata2.
        let texts: Vec<&str> = report.text_units.iter().map(|u| u.text.as_str()).collect();
        assert!(texts.contains(&"Prologue"));
        assert!(texts.contains(&"Hello, traveler."));
        assert!(texts.contains(&"Welcome to the village."));
        assert!(texts.contains(&"Safe travels."));
        assert!(texts.contains(&"Guide"));
        assert_eq!(report.text_units.len(), 5);
        assert!(
            report
                .text_units
                .iter()
                .all(|u| u.entry_id == "Data/System.rvdata2"),
            "opaque Title.png contributes no text units"
        );
    }

    // --- Crux: identity byte-preserving round-trip ---------------------------

    #[test]
    fn identity_round_trip_is_byte_preserving() {
        let scheme = Rgss3XorKeystreamScheme::rgss3();
        let source = build_fixture_archive(scheme);
        let extraction = extract_rgss3(scheme, &source).expect("extract");
        let rebuilt = rebuild_rgss3(&extraction);
        assert_eq!(
            rebuilt, source,
            "rebuild(extract(x)) must equal x byte-for-byte"
        );

        let report = generate_rgss3_smoke().expect("smoke runs");
        assert!(report.identity.byte_identical);
        assert_eq!(
            report.identity.source_hash.as_str(),
            report.identity.rebuilt_hash.as_str()
        );
    }

    // --- Crux: trivial change applied + everything else byte-identical -------

    #[test]
    fn trivial_change_applied_and_isolated() {
        let report = generate_rgss3_smoke().expect("smoke runs");
        assert!(report.patch.change_applied);
        assert_eq!(report.patch.entry_id, "Data/System.rvdata2");
        assert_eq!(report.patch.old_text, "Prologue");
        assert_eq!(report.patch.new_text, "Josho: Tabidachi no Hi");
        // A length-changing localization proves offsets/bounds were recomputed.
        assert_ne!(report.patch.length_delta, 0);
        // The patched entry diverges at exactly the one localized Marshal path.
        assert_eq!(report.patch.diverging_paths.len(), 1);
        // Every other entry is byte-identical.
        assert!(report.patch.other_entries_byte_identical);
    }

    #[test]
    fn patched_rebuild_isolates_the_change_at_byte_level() {
        // Directly prove: only the System entry's decrypted payload changes; the
        // opaque asset entry is byte-identical across the patched rebuild.
        let scheme = Rgss3XorKeystreamScheme::rgss3();
        let source = build_fixture_archive(scheme);
        let mut extraction = extract_rgss3(scheme, &source).expect("extract");
        let path = MarshalPath(vec![
            MarshalStep::Index(2),
            MarshalStep::HashValueAt(0),
            MarshalStep::Index(0),
        ]);
        let old = extraction.localize(0, &path, "localized").expect("patch");
        assert_eq!(old, "Hello, traveler.");
        let rebuilt = rebuild_rgss3(&extraction);

        let src = decode_synthetic_rgss3a(scheme, &source).unwrap();
        let pat = decode_synthetic_rgss3a(scheme, &rebuilt).unwrap();
        assert_eq!(src[1].name, "Graphics/Titles/Title.png");
        assert_eq!(src[1].payload, pat[1].payload, "opaque entry unchanged");
        assert_ne!(src[0].payload, pat[0].payload, "patched entry changed");
    }

    // --- Deliverable 3: unsupported cases are explicit + typed ---------------

    #[test]
    fn unsupported_cases_are_typed_and_rejected() {
        let report = generate_rgss3_smoke().expect("smoke runs");
        assert_eq!(report.unsupported.len(), 4);
        for case in &report.unsupported {
            assert!(
                case.rejected_before_rebuild,
                "case {} must be rejected with a typed diagnostic",
                case.case_id
            );
            assert!(!case.semantic_code.is_empty());
        }
        let by_kind = |kind: Rgss3UnsupportedKind| {
            report.unsupported.iter().find(|c| c.kind == kind).unwrap()
        };
        assert_eq!(
            by_kind(Rgss3UnsupportedKind::BadContainer).semantic_code,
            SemanticErrorCode::MissingContainerCapability.as_str()
        );
        assert_eq!(
            by_kind(Rgss3UnsupportedKind::UnsupportedMarshalType).semantic_code,
            SemanticErrorCode::MissingCodecCapability.as_str()
        );
        assert_eq!(
            by_kind(Rgss3UnsupportedKind::ScriptsOutOfScope).semantic_code,
            SemanticErrorCode::UnsupportedLayeredTransform.as_str()
        );
        assert_eq!(
            by_kind(Rgss3UnsupportedKind::PatchTargetNotText).semantic_code,
            SemanticErrorCode::MissingCodecCapability.as_str()
        );
    }

    #[test]
    fn extract_bad_container_is_typed_error() {
        let scheme = Rgss3XorKeystreamScheme::rgss3();
        let error = extract_rgss3(scheme, b"NOTRGSS\x03 nope").unwrap_err();
        assert!(matches!(
            error,
            Rgss3ExtractError::Container(RgssadError::BadMagic)
        ));
        assert_eq!(
            error.semantic_code(),
            SemanticErrorCode::MissingContainerCapability
        );
    }

    #[test]
    fn extract_unsupported_marshal_type_is_typed_error() {
        let scheme = Rgss3XorKeystreamScheme::rgss3();
        let archive =
            build_synthetic_rgss3a(scheme, 1, &[("Data/Bad.rvdata2", &[0x04, 0x08, b'c'])]);
        let error = extract_rgss3(scheme, &archive).unwrap_err();
        assert!(matches!(
            error,
            Rgss3ExtractError::Codec {
                error: MarshalError::UnsupportedType(b'c'),
                ..
            }
        ));
    }

    #[test]
    fn patch_non_text_leaf_is_typed_error() {
        let scheme = Rgss3XorKeystreamScheme::rgss3();
        let source = build_fixture_archive(scheme);
        let mut extraction = extract_rgss3(scheme, &source).unwrap();
        let int_path = MarshalPath(vec![MarshalStep::Index(0)]);
        let error = extraction.localize(0, &int_path, "x").unwrap_err();
        assert!(matches!(error, Rgss3PatchError::NotATextLeaf { .. }));
    }

    // --- Report hygiene ------------------------------------------------------

    #[test]
    fn report_stable_json_redacts_and_serializes() {
        let report = generate_rgss3_smoke().expect("smoke runs");
        let json = report.stable_json().expect("stable json");
        assert!(json.ends_with('\n'));
        // The synthetic text units survive (they are public, not secrets).
        assert!(json.contains("Data/System.rvdata2"));
        // Round-trips through serde.
        let back: Rgss3SmokeReport = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.status, report.status);
    }

    // --- Marshal path navigation unit tests ----------------------------------

    #[test]
    fn marshal_path_locator_is_stable() {
        let path = MarshalPath(vec![
            MarshalStep::Index(2),
            MarshalStep::HashValueAt(0),
            MarshalStep::Index(1),
        ]);
        assert_eq!(path.locator(), "[2].{0}[1]");
    }

    #[test]
    fn structural_diff_pinpoints_single_change() {
        let a = synthetic_text_bearing_value();
        let mut b = a.clone();
        // Change the speaker string (path [2].{1}).
        if let MarshalValue::Array(items) = &mut b
            && let MarshalValue::Hash(pairs) = &mut items[2]
        {
            pairs[1].1 = MarshalValue::ByteString(b"Narrator".to_vec());
        }
        let diff = marshal_structural_diff(&a, &b);
        assert_eq!(diff.len(), 1);
        assert_eq!(diff[0].locator(), "[2].{1}");
    }
}
