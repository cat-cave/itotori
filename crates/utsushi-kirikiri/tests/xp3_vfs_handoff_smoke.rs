//! Acceptance — **KiriKiri XP3-backed VFS handoff smoke**.
//!
//! Proves the handoff boundary end-to-end on synthetic bytes:
//!
//! - **Kaifuu owns the bytes.** A synthetic *plain* (unencrypted) XP3 is built
//!   and then EXTRACTED through the Kaifuu container reader
//!   (`kaifuu_core::encode_xp3` / `read_plain_xp3_archive`, a dev-dep oracle).
//!   Utsushi never parses the XP3 container — it consumes only the already
//!   extracted members Kaifuu hands over.
//! - **Utsushi consumes via the VFS.** The extracted members are handed to the
//!   shared VFS boundary's XP3 handoff; the KAG `.ks` member is resolved, opened
//!   and replayed THROUGH the VFS.
//! - **Redacted reports.** The runtime-evidence report carries no archive keys
//!   protected paths, or private local filenames — secret-refs + hashes only.
//! - **Reject-before-claim.** An out-of-profile (encrypted) archive is refused
//!   with a typed diagnostic BEFORE any KAG runtime-evidence claim.
//!
//! No retail bytes and no retail key: the XP3 members are synthetic, authored
//! CC0 KAG script bytes assembled in-process.

use kaifuu_core::{
    PLAIN_XP3_MANIFEST_SCHEMA_VERSION, PLAIN_XP3_MANIFEST_VARIANT, PlainXp3Archive,
    PlainXp3ArchiveEntry, PlainXp3ArchiveSegment, encode_xp3, read_plain_xp3_archive,
};
use utsushi_core::vfs::xp3_handoff::{
    ProofHash, SecretRef, Xp3ExtractedMember, Xp3HandoffDiagnostic, Xp3HandoffManifest,
    Xp3HandoffProfile, admit_xp3_handoff,
};
use utsushi_kirikiri::{KagEvent, KagVfsHandoffError, admit_and_replay};

/// The in-archive path of the KAG script member.
const SCRIPT_MEMBER: &str = "scenario/intro.ks";

/// A synthetic, authored, CC0 KAG `.ks` script: a named speaker, message runs
/// a same-file `@jump`, and a `[link]…[endlink]` choice menu with per-branch
/// text. ASCII so the byte assertions are transparent.
const KAG_SOURCE: &[u8] = b"; UTSUSHI-039 synthetic KAG (CC0)\n\
*start|Intro\n\
#Alice\n\
Hello, traveler.\n\
@jump target=*menu\n\
\n\
*menu\n\
[link target=*left]Go left[endlink]\n\
[link target=*right]Go right[endlink]\n\
\n\
*left\n\
#Alice\n\
The left path is calm.\n\
@jump target=*end\n\
\n\
*right\n\
#Alice\n\
The right path is loud.\n\
@jump target=*end\n\
\n\
*end\n\
#\n\
The journey ends here.\n";

/// Build a single-segment, uncompressed plain-XP3 entry for `path`.
fn plain_entry(path: &str, payload: Vec<u8>) -> PlainXp3ArchiveEntry {
    let size = payload.len() as u64;
    PlainXp3ArchiveEntry {
        path: path.to_string(),
        original_size: size,
        archive_size: size,
        stored_adler32: None,
        segments: vec![PlainXp3ArchiveSegment {
            flags: 0,
            original_size: size,
            archive_size: size,
        }],
        payload,
    }
}

/// Build synthetic plain-XP3 container bytes carrying the KAG member + a decoy
/// then EXTRACT them through the Kaifuu reader. Returns `(archive_bytes
/// extracted_members)` — the archive bytes are Kaifuu's to own; the members are
/// what Kaifuu hands Utsushi.
fn kaifuu_extract() -> (Vec<u8>, Vec<Xp3ExtractedMember>) {
    let archive = PlainXp3Archive {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: PLAIN_XP3_MANIFEST_VARIANT.to_string(),
        entries: vec![
            plain_entry(SCRIPT_MEMBER, KAG_SOURCE.to_vec()),
            plain_entry("system/note.txt", b"decoy asset\n".to_vec()),
        ],
    };
    // Kaifuu owns the container bytes.
    let archive_bytes = encode_xp3(&archive).expect("encode synthetic plain XP3");
    // Kaifuu extracts (this is the decryption/extraction step Utsushi never does).
    let extracted = read_plain_xp3_archive(&archive_bytes).expect("Kaifuu extracts plain XP3");
    // The extracted KAG payload round-trips to the original bytes.
    let script_member = extracted
        .entries
        .iter()
        .find(|entry| entry.path == SCRIPT_MEMBER)
        .expect("extracted KAG member present");
    assert_eq!(
        script_member.payload, KAG_SOURCE,
        "Kaifuu-extracted KAG payload must round-trip to the authored bytes"
    );

    let members = extracted
        .entries
        .iter()
        .map(|entry| Xp3ExtractedMember::new(entry.path.clone(), entry.payload.clone()))
        .collect();
    (archive_bytes, members)
}

/// A plain handoff manifest built from the Kaifuu extraction, optionally
/// carrying an archive-key secret-ref.
fn plain_manifest(with_key: bool) -> Xp3HandoffManifest {
    let (archive_bytes, members) = kaifuu_extract();
    let mut manifest = Xp3HandoffManifest::new(
        "public-fixture:kirikiri-plain-xp3",
        Xp3HandoffProfile::PlainExtracted,
        ProofHash::commit(&archive_bytes),
    )
    .with_members(members);
    if with_key {
        manifest =
            manifest.with_key_ref(SecretRef::new("local-secret:kirikiri.archive.key.v1").unwrap());
    }
    manifest
}

#[test]
fn plain_handoff_replays_kag_read_through_the_vfs() {
    let evidence = admit_and_replay(plain_manifest(false), SCRIPT_MEMBER)
        .expect("plain handoff admits and replays");

    // The KAG smoke replayed through the VFS: default selection [0] takes *left.
    let messages: Vec<(String, Option<String>)> = evidence
        .trace
        .events
        .iter()
        .filter_map(|event| match event {
            KagEvent::Message { text, speaker } => Some((text.clone(), speaker.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        messages,
        vec![
            ("Hello, traveler.".to_string(), Some("Alice".to_string())),
            (
                "The left path is calm.".to_string(),
                Some("Alice".to_string())
            ),
            ("The journey ends here.".to_string(), None),
        ],
        "KAG replay through the VFS must reproduce the authored dialogue"
    );
    assert_eq!(evidence.message_count, 3);
    assert_eq!(evidence.source_node_id, "UTSUSHI-039");

    // The `.ks` was read through the VFS at the fixed handoff package id.
    assert_eq!(
        evidence.script_asset_id,
        "vfs://xp3-handoff/scenario/intro.ks"
    );

    // A choice menu was presented (proves control flow ran, not a flat dump).
    let choice_count = evidence
        .trace
        .events
        .iter()
        .filter(|event| matches!(event, KagEvent::Choice { .. }))
        .count();
    assert_eq!(choice_count, 1);
}

#[test]
fn out_of_profile_archive_fails_before_any_kag_claim() {
    // Same extracted members, but the profile marks the archive out-of-profile
    // (encrypted). The capability gate must refuse BEFORE any KAG claim.
    let (archive_bytes, members) = kaifuu_extract();
    let manifest = Xp3HandoffManifest::new(
        "public-fixture:kirikiri-encrypted-xp3",
        Xp3HandoffProfile::Encrypted,
        ProofHash::commit(&archive_bytes),
    )
    .with_members(members);

    let error = admit_and_replay(manifest, SCRIPT_MEMBER).expect_err("must reject before claim");
    match error {
        KagVfsHandoffError::Capability(Xp3HandoffDiagnostic::OutOfProfileArchive {
            profile,
            ..
        }) => {
            assert_eq!(profile, Xp3HandoffProfile::Encrypted);
        }
        other => panic!("expected capability rejection, got {other:?}"),
    }

    // The rejection is committable evidence and carries NO KAG runtime evidence:
    // the authored dialogue never appears (no replay happened).
    let (_, members) = kaifuu_extract();
    let diagnostic = admit_xp3_handoff(
        Xp3HandoffManifest::new(
            "public-fixture:kirikiri-encrypted-xp3",
            Xp3HandoffProfile::Encrypted,
            ProofHash::commit(b"bytes"),
        )
        .with_members(members),
    )
    .expect_err("admit refuses");
    let json = diagnostic.stable_json().expect("diagnostic stable json");
    assert!(
        !json.contains("Hello, traveler."),
        "an out-of-profile rejection must not carry KAG runtime evidence: {json}"
    );
    assert!(!json.contains(".xp3"));
}

#[test]
fn runtime_report_carries_no_keys_paths_or_filenames() {
    let manifest = plain_manifest(true);
    let content_hash = {
        // Recompute the same archive-bytes hash to assert it survives into the report.
        let (archive_bytes, _) = kaifuu_extract();
        ProofHash::commit(&archive_bytes).as_str().to_string()
    };

    let evidence =
        admit_and_replay(manifest, SCRIPT_MEMBER).expect("plain handoff admits and replays");
    let json = evidence.stable_json().expect("evidence stable json");

    // The redacted metadata carries the secret-ref, the archive content hash
    // and the in-archive member ids (public logical paths).
    assert!(json.contains("local-secret:kirikiri.archive.key.v1"));
    assert!(json.contains(&content_hash));
    assert!(json.contains("scenario/intro.ks"));

    // NO archive keys, protected paths, or private local filenames.
    assert!(
        !json.contains(".xp3"),
        "no archive container filename: {json}"
    );
    assert!(!json.contains("/scratch/"), "no host path: {json}");
    assert!(
        !json.contains(env!("CARGO_MANIFEST_DIR")),
        "no build path: {json}"
    );
    for forbidden in ["/home/", "file://", "\\\\", "C:\\"] {
        assert!(!json.contains(forbidden), "leak {forbidden}: {json}");
    }

    // The redacted metadata report on its own is likewise clean.
    let metadata_json = evidence
        .archive_metadata
        .stable_json()
        .expect("metadata stable json");
    assert!(metadata_json.contains("\"redactionStatus\":\"redacted\""));
    assert!(!metadata_json.contains(".xp3"));
}
