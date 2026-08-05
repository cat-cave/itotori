// @itotori-real-bytes-proof
//! Real-byte launch hydration through a mounted request VFS.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use utsushi_core::substrate::{EnginePort, PortRequest, RuntimeVfs};
use utsushi_core::{CaseRule, MountedVfs, PackageSource, PlaintextDirPackage, RuntimeOperation};
use utsushi_siglus::UtsushiSiglusPort;

const FIRST_TITLE: &str = "siglus/1/encrypted";
const SECOND_TITLE: &str = "siglus/2/encrypted";

#[test]
fn two_real_siglus_titles_launch_through_vfs() {
    let first = corpus_root(FIRST_TITLE);
    let second = corpus_root(SECOND_TITLE);

    let mut scene_counts = [
        exercise_real_title(&first, "siglus-title-one"),
        exercise_real_title(&second, "siglus-title-two"),
    ];
    scene_counts.sort_unstable();
    assert_eq!(scene_counts, [278, 298]);
}

fn corpus_root(identity: &str) -> PathBuf {
    let candidate = corpus_registry::resolve_identity(identity)
        .unwrap_or_else(|reason| panic!("real-bytes proof not established: {identity}: {reason}"));
    let root = if candidate.is_dir() {
        candidate
    } else {
        candidate.parent().map_or_else(
            || panic!("real-bytes proof not established: {identity} has no parent directory"),
            Path::to_path_buf,
        )
    };
    for logical in ["Scene.pck", "Gameexe.dat", "SiglusEngine.exe"] {
        assert!(
            root.join(logical).is_file(),
            "real-bytes proof not established: {identity} lacks {logical}"
        );
    }
    root
}

fn exercise_real_title(root: &Path, package_id: &str) -> usize {
    let request = PortRequest::new(
        Path::new("siglus-launch-input-is-vfs-only"),
        package_id,
        RuntimeOperation::Trace,
    )
    .with_vfs(mounted_vfs(root, package_id));
    let mut port = UtsushiSiglusPort::new();
    port.launch(&request)
        .expect("real Siglus launch hydration succeeds through VFS");
    assert_eq!(port.scene_count(), port.moment_count());
    assert!(port.gameexe_entry_count() > 0);
    assert!(port.context().asset_package().is_some());
    port.scene_count()
}

fn mounted_vfs(root: &Path, package_id: &str) -> Arc<dyn RuntimeVfs> {
    let package = PlaintextDirPackage::new(
        package_id,
        root,
        CaseRule::InsensitiveAscii,
        PackageSource::PublicName(format!("fixture:{package_id}")),
    );
    let mut vfs = MountedVfs::new(
        package_id,
        PackageSource::PublicName(format!("fixture:{package_id}")),
    );
    vfs.mount_plaintext_dir(package);
    Arc::new(vfs)
}
