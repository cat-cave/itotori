//! Read-only asset package for private real-byte replay tests.

use std::fs;
use std::path::PathBuf;

use utsushi_core::substrate::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule,
    PackageDescriptor, PackageKind, PackageSource, VfsError, VfsResult,
};

#[derive(Debug)]
pub struct RealG00Package {
    g00_dir: PathBuf,
}

impl RealG00Package {
    pub fn new(g00_dir: PathBuf) -> Self {
        Self { g00_dir }
    }
}

fn asset_path(g00_dir: &std::path::Path, logical: &str) -> PathBuf {
    g00_dir.join(logical.strip_prefix("g00/").unwrap_or(logical))
}

impl AssetPackage for RealG00Package {
    fn id(&self) -> &'static str {
        "real-g00-replay"
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: self.id().to_owned(),
            kind: PackageKind::Plaintext,
            case_rule: CaseRule::Sensitive,
            source: PackageSource::PublicName(self.id().to_owned()),
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
        Ok(asset_path(&self.g00_dir, id.path()).is_file())
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        let path = asset_path(&self.g00_dir, id.path());
        let metadata = fs::metadata(path).map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetMetadata {
            id: id.clone(),
            kind: AssetKind::File,
            size: AssetSize::Bytes(metadata.len()),
            revision: None,
        })
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        let path = asset_path(&self.g00_dir, id.path());
        let bytes = fs::read(path).map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetBytes::from(bytes))
    }

    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
}
