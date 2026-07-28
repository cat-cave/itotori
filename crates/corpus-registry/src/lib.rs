//! Private real-corpus addressing.
//!
//! A test asks for an engine, ordinal, and variant. It never constructs an
//! environment-variable name. The operator provides one mounted media root;
//! users select libraries beneath it in the platform configuration directory's
//! `itotori/inventory.toml`.

use std::fmt;
use std::path::{Path, PathBuf};

use engine_contract::{Inventory, parse_inventory};

/// A request for one corpus. Engine identifiers are manifest data, not an enum,
/// so supporting another engine needs no registry code branch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Need<'a> {
    pub engine: &'a str,
    pub ordinal: u16,
    pub variant: &'a str,
}

impl fmt::Display for Need<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}/{}/{}",
            self.engine, self.ordinal, self.variant
        )
    }
}

/// The reason a requested corpus is unavailable. Strict proof callers must
/// surface this as a non-passing result rather than claim coverage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Unavailable {
    MediaRootMissing,
    ConfigDirectoryUnavailable,
    InventoryMissing {
        path: PathBuf,
    },
    InventoryInvalid {
        path: PathBuf,
        reason: String,
    },
    NotDeclared {
        engine: String,
        ordinal: u16,
        variant: String,
    },
    PathMissing {
        engine: String,
        ordinal: u16,
        variant: String,
        path: PathBuf,
    },
}

impl fmt::Display for Unavailable {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MediaRootMissing => write!(
                formatter,
                "ITOTORI_VAULT_ROOT is required as the operator-owned media mount; inventory entries must stay mount-relative"
            ),
            Self::ConfigDirectoryUnavailable => write!(
                formatter,
                "platform configuration directory is unavailable; pass an explicit inventory path to the caller"
            ),
            Self::InventoryMissing { path } => write!(
                formatter,
                "private corpus inventory is missing at {}; copy the matching catalog inventory template to this path and add mount-relative library paths",
                path.display()
            ),
            Self::InventoryInvalid { path, reason } => write!(
                formatter,
                "private corpus inventory at {} is invalid: {reason}",
                path.display()
            ),
            Self::NotDeclared {
                engine,
                ordinal,
                variant,
            } => {
                write!(
                    formatter,
                    "corpus {engine}/{ordinal}/{variant} is not declared"
                )
            }
            Self::PathMissing {
                engine,
                ordinal,
                variant,
                path,
            } => {
                write!(
                    formatter,
                    "corpus {engine}/{ordinal}/{variant} is declared but {} is absent",
                    path.display()
                )
            }
        }
    }
}

/// Resolve a corpus from the platform-standard private inventory. A missing
/// inventory, entry, or directory is an explicit `Unavailable`, never a panic.
pub fn resolve(need: Need<'_>) -> Result<PathBuf, Unavailable> {
    resolve_with_inventory_at(&inventory_path()?, &media_root()?, need)
}

/// Resolve a slash-delimited inventory identity (`engine/ordinal/variant`).
///
/// This is the loader used by cross-crate real-byte harnesses. Keeping the
/// identity as table data avoids reviving one environment variable per title.
pub fn resolve_identity(identity: &str) -> Result<PathBuf, Unavailable> {
    let config_path = inventory_path()?;
    resolve_identity_with_inventory_at(&config_path, &media_root()?, identity)
}

/// Resolve a slash-delimited inventory identity against a supplied inventory.
///
/// This makes the identity parser and the inventory lookup independently
/// testable without changing a process-wide configuration directory.
pub fn resolve_identity_with_inventory_at(
    inventory_path: &Path,
    media_root: &Path,
    identity: &str,
) -> Result<PathBuf, Unavailable> {
    let mut parts = identity.split('/');
    let (Some(engine), Some(ordinal), Some(variant), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(Unavailable::InventoryInvalid {
            path: inventory_path.to_path_buf(),
            reason: format!(
                "invalid corpus identity `{identity}`; expected engine/ordinal/variant"
            ),
        });
    };
    let ordinal = ordinal
        .parse::<u16>()
        .map_err(|_| Unavailable::InventoryInvalid {
            path: inventory_path.to_path_buf(),
            reason: format!("invalid corpus identity `{identity}`; ordinal must be a positive u16"),
        })?;
    if ordinal == 0 {
        return Err(Unavailable::InventoryInvalid {
            path: inventory_path.to_path_buf(),
            reason: format!("invalid corpus identity `{identity}`; ordinal must be positive"),
        });
    }
    resolve_with_inventory_at(
        inventory_path,
        media_root,
        Need {
            engine,
            ordinal,
            variant,
        },
    )
}

/// Resolve against an explicit private inventory path; useful for deterministic
/// registry tests and commands that provide an explicit configuration location.
pub fn resolve_with_inventory_at(
    inventory_path: &Path,
    media_root: &Path,
    need: Need<'_>,
) -> Result<PathBuf, Unavailable> {
    let inventory = read_inventory(inventory_path)?;
    let id = format!("corpus-{}-{}-{}", need.engine, need.ordinal, need.variant);
    let engine = format!("engine-{}", need.engine);
    let Some(corpus) = inventory
        .corpus
        .iter()
        .find(|corpus| corpus.id == id && corpus.engine == engine)
    else {
        return Err(unavailable_not_declared(need));
    };
    let path = media_root.join(&corpus.relative_path);
    if path.is_dir() {
        Ok(path)
    } else {
        Err(unavailable_path_missing(need, path))
    }
}

/// The sole deployment-owned corpus mount. Individual titles are inventory
/// records below this root, never environment variables of their own.
pub fn media_root() -> Result<PathBuf, Unavailable> {
    std::env::var_os("ITOTORI_VAULT_ROOT")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or(Unavailable::MediaRootMissing)
}

/// Default private inventory location following the platform configuration
/// convention. Commands with a configuration argument should call
/// [`resolve_with_inventory_at`] instead.
pub fn inventory_path() -> Result<PathBuf, Unavailable> {
    dirs::config_dir()
        .map(|path| path.join("itotori").join("inventory.toml"))
        .ok_or(Unavailable::ConfigDirectoryUnavailable)
}

fn read_inventory(path: &Path) -> Result<Inventory, Unavailable> {
    let text = std::fs::read_to_string(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            Unavailable::InventoryMissing {
                path: path.to_path_buf(),
            }
        } else {
            Unavailable::InventoryInvalid {
                path: path.to_path_buf(),
                reason: error.to_string(),
            }
        }
    })?;
    parse_inventory(&text).map_err(|error| Unavailable::InventoryInvalid {
        path: path.to_path_buf(),
        reason: error.to_string(),
    })
}

fn unavailable_not_declared(need: Need<'_>) -> Unavailable {
    Unavailable::NotDeclared {
        engine: need.engine.to_owned(),
        ordinal: need.ordinal,
        variant: need.variant.to_owned(),
    }
}

fn unavailable_path_missing(need: Need<'_>, path: PathBuf) -> Unavailable {
    Unavailable::PathMissing {
        engine: need.engine.to_owned(),
        ordinal: need.ordinal,
        variant: need.variant.to_owned(),
        path,
    }
}

#[cfg(test)]
mod tests {
    use super::{Need, Unavailable, resolve_identity_with_inventory_at, resolve_with_inventory_at};
    use std::path::Path;

    fn write_inventory(path: &Path, relative_path: &str) {
        std::fs::write(
            path,
            format!(
                "schema = \"inventory/v1\"\n\n[[corpus]]\nid = \"corpus-reallive-1-encrypted\"\nengine = \"engine-reallive\"\nvariant = \"variant-encrypted\"\nrelative_path = \"{relative_path}\"\ncontent_address = \"sha256:test\"\ntags = [\"strict\"]\naccess = \"read-only\"\n",
            ),
        )
        .expect("write inventory");
    }

    #[test]
    fn resolves_inventory_selected_corpus() {
        let root = tempfile::tempdir().expect("temporary corpus root");
        let inventory = tempfile::NamedTempFile::new().expect("temporary inventory");
        write_inventory(inventory.path(), "reallive/first");
        std::fs::create_dir_all(root.path().join("reallive/first")).expect("create library");

        let actual = resolve_with_inventory_at(
            inventory.path(),
            root.path(),
            Need {
                engine: "reallive",
                ordinal: 1,
                variant: "encrypted",
            },
        )
        .expect("declared corpus resolves");

        assert_eq!(actual, root.path().join("reallive/first"));
    }

    #[test]
    fn reports_absent_declared_corpus_without_panicking() {
        let inventory = tempfile::NamedTempFile::new().expect("temporary inventory");
        write_inventory(inventory.path(), "missing/library");
        let media_root = tempfile::tempdir().expect("temporary media root");
        let error = resolve_with_inventory_at(
            inventory.path(),
            media_root.path(),
            Need {
                engine: "reallive",
                ordinal: 1,
                variant: "encrypted",
            },
        )
        .expect_err("missing staged corpus is an explicit skip reason");

        assert!(matches!(error, Unavailable::PathMissing { .. }));
    }

    #[test]
    fn identity_loader_rejects_a_mutated_root_then_recovers_after_restore() {
        let root = tempfile::tempdir().expect("temporary corpus root");
        let inventory = tempfile::NamedTempFile::new().expect("temporary inventory");
        write_inventory(inventory.path(), "reallive/first");
        std::fs::create_dir_all(root.path().join("reallive/first")).expect("create library");

        let initial = resolve_identity_with_inventory_at(
            inventory.path(),
            root.path(),
            "reallive/1/encrypted",
        )
        .expect("declared root resolves before mutation");
        assert_eq!(initial, root.path().join("reallive/first"));

        write_inventory(inventory.path(), "removed/library");
        let failure = resolve_identity_with_inventory_at(
            inventory.path(),
            root.path(),
            "reallive/1/encrypted",
        )
        .expect_err("a wrong configured root must fail");
        assert!(matches!(failure, Unavailable::PathMissing { .. }));
        assert!(failure.to_string().contains("declared but"));

        write_inventory(inventory.path(), "reallive/first");
        let restored = resolve_identity_with_inventory_at(
            inventory.path(),
            root.path(),
            "reallive/1/encrypted",
        )
        .expect("restored root resolves");
        assert_eq!(restored, root.path().join("reallive/first"));
    }

    #[test]
    fn reports_missing_private_inventory_with_copy_instruction() {
        let error = resolve_with_inventory_at(
            Path::new("/definitely-missing-inventory.toml"),
            Path::new("/media-root"),
            Need {
                engine: "reallive",
                ordinal: 1,
                variant: "encrypted",
            },
        )
        .expect_err("missing private manifest must be actionable");

        assert!(error.to_string().contains("catalog inventory template"));
    }

    #[test]
    fn rejects_invalid_inventory_without_selecting_a_corpus() {
        let inventory = tempfile::NamedTempFile::new().expect("temporary inventory");
        std::fs::write(
            inventory.path(),
            "schema = \"inventory/v1\"\n\n[[corpus]]\nid = \"corpus-reallive-1-encrypted\"\nengine = \"engine-reallive\"\nvariant = \"variant-encrypted\"\nrelative_path = \"../escape\"\ncontent_address = \"sha256:test\"\ntags = []\naccess = \"read-only\"\n",
        )
        .expect("write invalid inventory");

        let error = resolve_with_inventory_at(
            inventory.path(),
            Path::new("/media-root"),
            Need {
                engine: "reallive",
                ordinal: 1,
                variant: "encrypted",
            },
        )
        .expect_err("invalid inventory must not select a corpus");

        let message = error.to_string();
        assert!(message.contains("mount-relative path"));
    }
}
