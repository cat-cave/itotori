//! Request-bound construction of the RealLive engine-port adapter.
//!
//! The CLI owns the filesystem-to-port boundary because the port itself is
//! deliberately constructed over typed inputs: a staged `ReplayEngine`, the
//! parsed Gameexe configuration, and an `AssetPackage` for g00 files. Runtime
//! replay commands then enter the generic `EnginePortAdapter` and `Runner`.

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use utsushi_core::EnginePortAdapter;
use utsushi_core::substrate::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule,
    PackageDescriptor, PackageKind, PackageSource, VfsError, VfsResult,
};
use utsushi_reallive::{Gameexe, UtsushiReallivePort};

use crate::staged_replay::staged_engine;

/// Build the concrete RealLive port adapter for one replay request.
pub(crate) fn build_adapter(
    seen_path: &Path,
    scene_id: u16,
    gameexe_path: &Path,
    g00_dir: &Path,
) -> Result<EnginePortAdapter<UtsushiReallivePort>, Box<dyn Error>> {
    if !g00_dir.is_dir() {
        return Err(format!(
            "utsushi.cli.reallive_port.g00_dir_missing: {} is not a directory",
            g00_dir.display()
        )
        .into());
    }

    let gameexe_bytes = fs::read(gameexe_path).map_err(|error| {
        format!(
            "utsushi.cli.reallive_port.gameexe_read: {}: {error}",
            gameexe_path.display()
        )
    })?;
    let gameexe = Gameexe::parse(&gameexe_bytes)
        .map_err(|error| format!("utsushi.cli.reallive_port.gameexe_parse: {error}"))?;

    let engine = staged_engine(seen_path)
        .map_err(|error| format!("utsushi.cli.reallive_port.driver: {error}"))?;
    if !engine.scene_ids().contains(&scene_id) {
        return Err(format!(
            "utsushi.cli.reallive_port.scene_not_found: scene {scene_id} did not decode into the staged store"
        )
        .into());
    }

    let assets: Arc<dyn AssetPackage> = Arc::new(OnDiskG00Package::new(g00_dir.to_path_buf()));
    let port = UtsushiReallivePort::new(
        engine,
        assets,
        scene_id,
        gameexe.message_window(0),
        gameexe.screen_size_px(),
    );
    EnginePortAdapter::new(port)
        .map_err(|error| format!("utsushi.cli.reallive_port.adapter: {error}").into())
}

/// Minimal [`AssetPackage`] resolving `g00/<STEM>.g00` against a real
/// on-disk g00 directory. The port only opens assets it observes; it does not
/// index the rest of the game tree.
#[derive(Debug)]
struct OnDiskG00Package {
    g00_dir: PathBuf,
}

impl OnDiskG00Package {
    fn new(g00_dir: PathBuf) -> Self {
        Self { g00_dir }
    }

    fn host_path(&self, id: &AssetId) -> PathBuf {
        let logical = id.path();
        let stem = logical.strip_prefix("g00/").unwrap_or(logical);
        self.g00_dir.join(stem)
    }
}

impl AssetPackage for OnDiskG00Package {
    fn id(&self) -> &'static str {
        "reallive-replay-on-disk-g00"
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: self.id().to_string(),
            kind: PackageKind::Plaintext,
            case_rule: CaseRule::Sensitive,
            source: PackageSource::PublicName(self.id().to_string()),
            revision: None,
        }
    }

    fn case_rule(&self) -> CaseRule {
        CaseRule::Sensitive
    }

    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        AssetId::from_parts(self.id(), logical)
    }

    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        Ok(self.host_path(id).exists())
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        let metadata = fs::metadata(self.host_path(id))
            .map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetMetadata {
            id: id.clone(),
            kind: AssetKind::File,
            size: AssetSize::Bytes(metadata.len()),
            revision: None,
        })
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        let bytes =
            fs::read(self.host_path(id)).map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetBytes::from(bytes))
    }

    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
}
