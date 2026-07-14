//! **KAG replay through the XP3-backed VFS handoff**.
//!
//! This is the Utsushi consumer of the shared VFS boundary's XP3 handoff
//! ([`utsushi_core::vfs::xp3_handoff`]). The chain is:
//!
//! 1. **Kaifuu owns the bytes.** Kaifuu detects/profiles/extracts a *plain*
//!    (unencrypted) XP3 and hands Utsushi an
//!    [`Xp3HandoffManifest`](utsushi_core::vfs::xp3_handoff::Xp3HandoffManifest):
//!    a redacted archive id, a one-way content-hash, an optional key secret-ref
//!    and the already-extracted members. Utsushi never parses the container
//!    never touches a key, never decrypts.
//! 2. **Archive-capability gate.**
//!    [`admit_xp3_handoff`](utsushi_core::vfs::xp3_handoff::admit_xp3_handoff)
//!    refuses every out-of-profile archive with a typed diagnostic *before* any
//!    VFS reader is built. Only a cleared
//!    [`Xp3HandoffAdmission`](utsushi_core::vfs::xp3_handoff::Xp3HandoffAdmission)
//!    yields a reader.
//! 3. **KAG replay through the VFS.** [`replay_kag_through_vfs`] mounts the
//!    admission's extracted members into a
//!    [`MountedVfs`](utsushi_core::MountedVfs), resolves the `.ks` member
//!    opens it through the VFS, and replays it with [`crate::replay_kag`] into a
//!    [`KagVfsEvidence`] runtime-evidence claim.
//!
//! Because [`replay_kag_through_vfs`] takes an `&Xp3HandoffAdmission` — which can
//! only come from a cleared capability gate — the KAG runtime-evidence claim is
//! **structurally gated behind the archive-capability check**. An out-of-profile
//! archive never produces an admission, so it can never reach a KAG claim. The
//! one-shot [`admit_and_replay`] makes the reject-before-claim ordering explicit:
//! the `?` on the admission short-circuits before any replay.
//!
//! Every serialized [`KagVfsEvidence`] carries redacted archive metadata
//! (secret-refs + hashes, no keys/paths/private filenames) and the deterministic
//! KAG trace, and is funnelled through the substrate redaction sweep on the way
//! out.

use serde::Serialize;
use thiserror::Error;

use utsushi_core::EvidenceTier;
use utsushi_core::MountedVfs;
use utsushi_core::redaction::reject_unredacted_local_paths;
use utsushi_core::vfs::RuntimeVfs;
use utsushi_core::vfs::VfsError;
use utsushi_core::vfs::xp3_handoff::{
    Xp3HandoffAdmission, Xp3HandoffDiagnostic, Xp3HandoffManifest, Xp3HandoffMetadata,
    admit_xp3_handoff,
};

use crate::{KagTrace, parse_kag, replay_kag};

/// Schema version of the KAG-through-VFS runtime-evidence claim.
pub const KAG_VFS_EVIDENCE_SCHEMA_VERSION: &str = "0.1.0";

/// Stable capability id carried by every KAG-through-VFS claim.
pub const KAG_VFS_CAPABILITY_ID: &str = "utsushi-kirikiri-kag-vfs-handoff-replay";

/// The blunt support boundary surfaced in every claim.
pub const KAG_VFS_SUPPORT_BOUNDARY: &str = "Utsushi replays a plaintext KAG `.ks` script that it reads through the shared VFS boundary from a Kaifuu-owned, already-extracted plain XP3 handoff. Utsushi owns no archive decryption: Kaifuu extracts the members and hands them over; Utsushi consumes them via the VFS. The KAG runtime-evidence claim is gated behind the archive-capability check — an out-of-profile (encrypted / helper-required / other non-plain) archive is refused with a typed diagnostic before any VFS reader is built, so no KAG evidence is ever claimed for it. This is a plaintext KAG replay skeleton (see utsushi_kirikiri::capability_note), not a full KiriKiri runtime. Evidence is deterministic and non-visual (tier E1). Reports carry redacted metadata + secret-refs only.";

/// A runtime-evidence claim produced by replaying a KAG `.ks` script read
/// through the XP3-backed VFS handoff. Existence of this value is proof the
/// archive-capability gate was cleared: it can only be built from an
/// [`Xp3HandoffAdmission`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KagVfsEvidence {
    /// Report schema version.
    pub schema_version: String,
    /// The spec-DAG node id this claim is authored for.
    pub source_node_id: String,
    /// Capability id.
    pub capability_id: String,
    /// The blunt support boundary.
    pub support_boundary: String,
    /// Redacted archive metadata carried by the handoff (secret-refs + hashes
    /// no keys / protected paths / private local filenames).
    pub archive_metadata: Xp3HandoffMetadata,
    /// The `vfs://…` id the `.ks` member resolved to through the VFS.
    pub script_asset_id: String,
    /// Number of KAG message events replayed.
    pub message_count: u64,
    /// Number of KAG events replayed (messages, speaker changes, choices, …).
    pub event_count: u64,
    /// Number of typed KAG semantic diagnostics recorded during replay.
    pub diagnostic_count: u64,
    /// Evidence tier this claim is capped at (deterministic, non-visual → E1).
    pub evidence_tier: EvidenceTier,
    /// The deterministic KAG trace produced by the replay.
    pub trace: KagTrace,
}

impl KagVfsEvidence {
    /// The spec-DAG node id stamped on every claim.
    pub const SOURCE_NODE_ID: &'static str = "UTSUSHI-039";

    /// Serialize to stable, redaction-swept JSON. The sweep rejects any
    /// local-path-shaped string, so a leaked key / host path / private filename
    /// fails here rather than being committed. Returns the JSON on success.
    pub fn stable_json(&self) -> Result<String, String> {
        let value = serde_json::to_value(self)
            .map_err(|error| format!("kag-vfs evidence serialization failed: {error}"))?;
        reject_unredacted_local_paths("", &value)
            .map_err(|error| format!("kag-vfs evidence failed redaction sweep: {error}"))?;
        serde_json::to_string(&value)
            .map_err(|error| format!("kag-vfs evidence re-serialization failed: {error}"))
    }
}

/// A failure encountered while replaying a KAG script through an already-cleared
/// VFS handoff (the capability gate has passed by this point).
#[derive(Debug, Error)]
pub enum KagVfsError {
    /// The `.ks` member could not be resolved / opened through the VFS.
    #[error("utsushi.kirikiri.kag_vfs.asset: {0}")]
    Vfs(#[from] VfsError),
}

/// The full reject-before-claim outcome for [`admit_and_replay`]: either the
/// archive-capability gate refused the handoff (no KAG evidence), or the replay
/// failed after admission.
#[derive(Debug, Error)]
pub enum KagVfsHandoffError {
    /// The archive-capability gate refused the handoff. No VFS reader was built
    /// and NO KAG runtime-evidence claim was produced.
    #[error("utsushi.kirikiri.kag_vfs.capability: {0}")]
    Capability(#[from] Xp3HandoffDiagnostic),
    /// The handoff was admitted but the KAG replay through the VFS failed.
    #[error("utsushi.kirikiri.kag_vfs.replay: {0}")]
    Replay(#[from] KagVfsError),
}

/// Replay a KAG `.ks` script that is read through the VFS backed by a cleared
/// XP3 handoff `admission`. `script_logical` is the in-archive logical path of
/// the `.ks` member (e.g. `scenario/intro.ks`).
///
/// Taking an `&Xp3HandoffAdmission` is the structural gate: the caller must have
/// already cleared the archive-capability check to hold one, so this function
/// can only ever run against an admitted (plain-extracted) archive.
pub fn replay_kag_through_vfs(
    admission: &Xp3HandoffAdmission,
    script_logical: &str,
) -> Result<KagVfsEvidence, KagVfsError> {
    let vfs: MountedVfs = admission.mount();
    let asset_id = vfs.resolve(script_logical)?;
    let bytes = vfs.open(&asset_id)?;

    // Parse + replay entirely over the VFS-served bytes. Utsushi never sees the
    // XP3 container — only the extracted `.ks` bytes Kaifuu handed over.
    let script = parse_kag(asset_id.path(), bytes.as_slice());
    let trace = replay_kag(&script);

    Ok(KagVfsEvidence {
        schema_version: KAG_VFS_EVIDENCE_SCHEMA_VERSION.to_string(),
        source_node_id: KagVfsEvidence::SOURCE_NODE_ID.to_string(),
        capability_id: KAG_VFS_CAPABILITY_ID.to_string(),
        support_boundary: KAG_VFS_SUPPORT_BOUNDARY.to_string(),
        archive_metadata: admission.metadata(),
        script_asset_id: asset_id.as_str().to_string(),
        message_count: trace.message_count() as u64,
        event_count: trace.events.len() as u64,
        diagnostic_count: trace.diagnostics.len() as u64,
        evidence_tier: EvidenceTier::E1,
        trace,
    })
}

/// One-shot reject-before-claim: admit the handoff, then (only on success)
/// replay the KAG `.ks` through the VFS. The `?` on the admission short-circuits
/// on an out-of-profile archive, so a refused handoff never reaches the replay
/// and never yields a [`KagVfsEvidence`].
pub fn admit_and_replay(
    manifest: Xp3HandoffManifest,
    script_logical: &str,
) -> Result<KagVfsEvidence, KagVfsHandoffError> {
    let admission = admit_xp3_handoff(manifest)?;
    let evidence = replay_kag_through_vfs(&admission, script_logical)?;
    Ok(evidence)
}
