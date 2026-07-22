use super::*;
use crate::vfs::RuntimeVfs;

fn hash(bytes: &[u8]) -> ProofHash {
    ProofHash::commit(bytes)
}

fn plain_manifest() -> Xp3HandoffManifest {
    Xp3HandoffManifest::new(
        "public-fixture:kirikiri-plain-xp3",
        Xp3HandoffProfile::PlainExtracted,
        hash(b"synthetic-plain-xp3-bytes"),
    )
    .with_member(Xp3ExtractedMember::new(
        "scenario/intro.ks",
        b"*start\n#Alice\nHello there.\n".to_vec(),
    ))
    .with_member(Xp3ExtractedMember::new(
        "system/config.tjs",
        b"; config\n".to_vec(),
    ))
}

#[test]
fn plain_handoff_admits_and_serves_members_through_the_vfs() {
    let admission = admit_xp3_handoff(plain_manifest()).expect("plain handoff admits");
    assert_eq!(admission.member_count(), 2);

    let vfs = admission.mount();
    let id = vfs.resolve("scenario/intro.ks").expect("resolve member");
    let bytes = vfs.open(&id).expect("open member");
    assert_eq!(bytes.as_slice(), b"*start\n#Alice\nHello there.\n");

    // Case-folded resolution reaches the same member.
    let folded = vfs
        .resolve("SCENARIO/INTRO.KS")
        .expect("case-folded resolve");
    assert_eq!(folded.path(), "scenario/intro.ks");
}

#[test]
fn out_of_profile_archive_is_refused_before_any_reader() {
    for profile in [
        Xp3HandoffProfile::Encrypted,
        Xp3HandoffProfile::HelperRequired,
        Xp3HandoffProfile::Unsupported,
    ] {
        let manifest = Xp3HandoffManifest::new(
            "public-fixture:kirikiri-encrypted-xp3",
            profile,
            hash(b"synthetic-encrypted-xp3-bytes"),
        )
        .with_member(Xp3ExtractedMember::new("scenario/intro.ks", b"x".to_vec()));
        let diagnostic = admit_xp3_handoff(manifest).expect_err("must refuse");
        match diagnostic {
            Xp3HandoffDiagnostic::OutOfProfileArchive {
                profile: refused, ..
            } => assert_eq!(refused, profile),
            other => panic!("expected OutOfProfileArchive, got {other:?}"),
        }
    }
}

#[test]
fn out_of_profile_diagnostic_serializes_cleanly() {
    let manifest = Xp3HandoffManifest::new(
        "public-fixture:kirikiri-encrypted-xp3",
        Xp3HandoffProfile::Encrypted,
        hash(b"bytes"),
    )
    .with_key_ref(SecretRef::new("local-secret:kirikiri.archive.key.v1").unwrap())
    .with_member(Xp3ExtractedMember::new("scenario/intro.ks", b"x".to_vec()));
    let diagnostic = admit_xp3_handoff(manifest).expect_err("must refuse");
    assert_eq!(
        diagnostic.semantic_code(),
        "utsushi.vfs.xp3_handoff.out_of_profile_archive"
    );
    let json = diagnostic.stable_json().expect("stable json");
    // The serde `tag = "code"` carries the camelCase variant discriminant.
    assert!(json.contains("outOfProfileArchive"));
    // No raw key / local path leaked into the rejection evidence.
    assert!(!json.contains("/home/"));
}

#[test]
fn metadata_report_carries_secret_ref_and_hash_but_no_key_or_path() {
    let key_bytes = b"THIS-IS-RAW-ARCHIVE-KEY-MATERIAL";
    let manifest = plain_manifest()
        .with_key_ref(SecretRef::new("local-secret:kirikiri.archive.key.v1").unwrap());
    let admission = admit_xp3_handoff(manifest).expect("admit");
    let metadata = admission.metadata();
    let json = metadata.stable_json().expect("stable json");

    // The secret-ref and content hash are present.
    assert!(json.contains("local-secret:kirikiri.archive.key.v1"));
    assert!(json.contains(admission.metadata().content_hash.as_str()));
    // In-archive member ids survive (they are logical paths, not secrets).
    assert!(json.contains("scenario/intro.ks"));
    // No raw key material.
    assert!(!json.contains(std::str::from_utf8(key_bytes).unwrap()));
    assert_eq!(metadata.redaction_status, "redacted");
}

#[test]
fn unsafe_member_id_is_refused() {
    for bad in ["../escape.ks", "/abs.ks", "a/../b.ks", "dir/"] {
        let manifest = Xp3HandoffManifest::new(
            "public-fixture:plain",
            Xp3HandoffProfile::PlainExtracted,
            hash(b"x"),
        )
        .with_member(Xp3ExtractedMember::new(bad, b"x".to_vec()));
        let diagnostic = admit_xp3_handoff(manifest).expect_err("must refuse");
        assert!(
            matches!(diagnostic, Xp3HandoffDiagnostic::UnsafeMemberId { .. }),
            "bad id {bad} should be refused, got {diagnostic:?}"
        );
    }
}

#[test]
fn duplicate_case_folded_member_id_is_refused() {
    let manifest = Xp3HandoffManifest::new(
        "public-fixture:plain",
        Xp3HandoffProfile::PlainExtracted,
        hash(b"x"),
    )
    .with_member(Xp3ExtractedMember::new("scenario/Intro.ks", b"a".to_vec()))
    .with_member(Xp3ExtractedMember::new("scenario/intro.ks", b"b".to_vec()));
    let diagnostic = admit_xp3_handoff(manifest).expect_err("must refuse");
    assert!(matches!(
        diagnostic,
        Xp3HandoffDiagnostic::DuplicateMemberId { .. }
    ));
}

#[test]
fn empty_plain_handoff_is_refused() {
    let manifest = Xp3HandoffManifest::new(
        "public-fixture:plain",
        Xp3HandoffProfile::PlainExtracted,
        hash(b"x"),
    );
    let diagnostic = admit_xp3_handoff(manifest).expect_err("must refuse");
    assert!(matches!(
        diagnostic,
        Xp3HandoffDiagnostic::EmptyHandoff { .. }
    ));
}

#[test]
fn archive_reader_index_is_built_once() {
    let admission = admit_xp3_handoff(plain_manifest()).expect("admit");
    let reader = admission.archive_reader();
    let first = std::ptr::from_ref(reader.case_folded_index().unwrap());
    let second = std::ptr::from_ref(reader.case_folded_index().unwrap());
    assert_eq!(first, second, "OnceLock must hand back the same index");
}

#[test]
fn secret_ref_rejects_bad_shapes() {
    assert!(SecretRef::new("local-secret:kirikiri.key.v1").is_ok());
    assert!(SecretRef::new("plain-key").is_err());
    assert!(SecretRef::new("local-secret:/home/user/key").is_err());
    assert!(SecretRef::new("local-secret:../escape").is_err());
    assert!(SecretRef::new("bogus:name").is_err());
}

#[test]
fn descriptor_reports_composite_backed_handoff_package() {
    let admission = admit_xp3_handoff(plain_manifest()).expect("admit");
    let vfs = admission.mount();
    let descriptors = vfs.packages();
    assert_eq!(descriptors.len(), 1);
    assert_eq!(descriptors[0].id, XP3_HANDOFF_PACKAGE_ID);
}
