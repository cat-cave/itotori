//! Private real-corpus addressing.
//!
//! A test asks for an engine, ordinal, and variant. It never constructs an
//! environment-variable name. The sole machine-specific setting is
//! `ITOTORI_CORPUS_ROOT`; a local manifest maps stable identities to relative
//! paths below that root. The manifest is deliberately not checked in because
//! its paths identify private local installations.

use std::collections::BTreeMap;
use std::env;
use std::fmt;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::de::{self, MapAccess, Visitor};

const ROOT_ENV: &str = "ITOTORI_CORPUS_ROOT";
const MANIFEST_RELATIVE_PATH: &str = "../../corpora/manifest.v1.json";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    #[serde(rename = "$schema")]
    _schema: Option<String>,
    version: u8,
    corpora: Entries,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: PathBuf,
}

#[derive(Debug)]
struct Entries(BTreeMap<String, Entry>);

impl<'de> Deserialize<'de> for Entries {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct EntriesVisitor;

        impl<'de> Visitor<'de> for EntriesVisitor {
            type Value = Entries;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a map of unique corpus identities to entries")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut entries = BTreeMap::new();
                while let Some((identity, entry)) = map.next_entry::<String, Entry>()? {
                    if let Some(previous) = entries.insert(identity.clone(), entry) {
                        let current = entries.get(&identity).expect("inserted entry");
                        return Err(de::Error::custom(format!(
                            "duplicate corpus identity {identity}: paths {} and {}",
                            previous.path.display(),
                            current.path.display()
                        )));
                    }
                }
                Ok(Entries(entries))
            }
        }

        deserializer.deserialize_map(EntriesVisitor)
    }
}

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
    RootUnset,
    ManifestMissing {
        path: PathBuf,
    },
    ManifestInvalid {
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
            Self::RootUnset => write!(formatter, "{ROOT_ENV} is unset"),
            Self::ManifestMissing { path } => write!(
                formatter,
                "corpus registry manifest is missing at {}; copy corpora/manifest.v1.example.json to corpora/manifest.v1.json and replace its role-shaped paths with local directories",
                path.display()
            ),
            Self::ManifestInvalid { path, reason } => write!(
                formatter,
                "corpus registry manifest at {} is invalid: {reason}",
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

/// Resolve a corpus from the process root. A missing root, entry, or directory
/// is an explicit `Unavailable`, never a panic.
pub fn resolve(need: Need<'_>) -> Result<PathBuf, Unavailable> {
    let Some(root) = env::var_os(ROOT_ENV).map(PathBuf::from) else {
        return Err(Unavailable::RootUnset);
    };
    resolve_at(&root, need)
}

/// Resolve against an explicit root; useful for deterministic registry tests.
pub fn resolve_at(root: &Path, need: Need<'_>) -> Result<PathBuf, Unavailable> {
    resolve_with_manifest(root, &manifest_path(), need)
}

/// Resolve against an explicit corpus root and manifest path. This keeps the
/// parser testable without making private local manifest paths part of a build.
pub fn resolve_with_manifest(
    root: &Path,
    manifest_path: &Path,
    need: Need<'_>,
) -> Result<PathBuf, Unavailable> {
    let manifest = parse_manifest(manifest_path)?;
    let identity = need.to_string();
    let Some(entry) = manifest.corpora.0.get(&identity) else {
        return Err(unavailable_not_declared(need));
    };
    let path = root.join(&entry.path);
    if path.is_dir() {
        Ok(path)
    } else {
        Err(unavailable_path_missing(need, path))
    }
}

/// Location of the private local manifest relative to this crate's source.
pub fn manifest_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(MANIFEST_RELATIVE_PATH)
}

fn parse_manifest(path: &Path) -> Result<Manifest, Unavailable> {
    let text = std::fs::read_to_string(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            Unavailable::ManifestMissing {
                path: path.to_path_buf(),
            }
        } else {
            Unavailable::ManifestInvalid {
                path: path.to_path_buf(),
                reason: error.to_string(),
            }
        }
    })?;
    let manifest =
        serde_json::from_str::<Manifest>(&text).map_err(|error| Unavailable::ManifestInvalid {
            path: path.to_path_buf(),
            reason: error.to_string(),
        })?;
    if manifest.version != 1 {
        return Err(Unavailable::ManifestInvalid {
            path: path.to_path_buf(),
            reason: format!("unsupported version {}; expected 1", manifest.version),
        });
    }
    if manifest.corpora.0.is_empty() {
        return Err(Unavailable::ManifestInvalid {
            path: path.to_path_buf(),
            reason: "corpora must contain at least one identity".to_owned(),
        });
    }
    if manifest.corpora.0.iter().any(|(identity, entry)| {
        !valid_identity(identity)
            || entry.path.is_absolute()
            || entry
                .path
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
    }) {
        return Err(Unavailable::ManifestInvalid {
            path: path.to_path_buf(),
            reason: "corpus identities must be engine/ordinal/variant and paths must be relative without `..`".to_owned(),
        });
    }
    Ok(manifest)
}

fn valid_identity(identity: &str) -> bool {
    let mut parts = identity.split('/');
    let Some(engine) = parts.next() else {
        return false;
    };
    let Some(ordinal) = parts.next() else {
        return false;
    };
    let Some(variant) = parts.next() else {
        return false;
    };
    parts.next().is_none()
        && valid_token(engine)
        && ordinal.parse::<u16>().is_ok_and(|number| number > 0)
        && valid_token(variant)
}

fn valid_token(token: &str) -> bool {
    let mut chars = token.chars();
    matches!(chars.next(), Some('a'..='z'))
        && chars.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
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
    use super::{Need, Unavailable, resolve_with_manifest};
    use std::path::Path;

    fn write_manifest(path: &Path, relative_path: &str) {
        std::fs::write(
            path,
            format!(
                r#"{{"$schema":"./manifest.v1.schema.json","version":1,"corpora":{{"reallive/1/encrypted":{{"path":"{relative_path}"}}}}}}"#
            ),
        )
        .expect("write manifest");
    }

    #[test]
    fn resolves_manifest_selected_corpus_from_single_root() {
        let root = tempfile::tempdir().expect("temporary corpus root");
        let manifest = tempfile::NamedTempFile::new().expect("temporary manifest");
        std::fs::create_dir(root.path().join("role-primary")).expect("declared path");
        write_manifest(manifest.path(), "role-primary");

        let actual = resolve_with_manifest(
            root.path(),
            manifest.path(),
            Need {
                engine: "reallive",
                ordinal: 1,
                variant: "encrypted",
            },
        )
        .expect("declared corpus resolves");

        assert_eq!(actual, root.path().join("role-primary"));
    }

    #[test]
    fn reports_absent_declared_corpus_without_panicking() {
        let manifest = tempfile::NamedTempFile::new().expect("temporary manifest");
        write_manifest(manifest.path(), "role-secondary");
        let error = resolve_with_manifest(
            Path::new("/definitely-missing-corpus-root"),
            manifest.path(),
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
    fn reports_missing_private_manifest_with_copy_instruction() {
        let error = resolve_with_manifest(
            Path::new("/corpus-root"),
            Path::new("/definitely-missing-manifest.json"),
            Need {
                engine: "reallive",
                ordinal: 1,
                variant: "encrypted",
            },
        )
        .expect_err("missing private manifest must be actionable");

        assert!(error.to_string().contains("manifest.v1.example.json"));
    }

    #[test]
    fn rejects_duplicate_identity_and_names_both_paths() {
        let manifest = tempfile::NamedTempFile::new().expect("temporary manifest");
        std::fs::write(
            manifest.path(),
            r#"{"version":1,"corpora":{"reallive/1/encrypted":{"path":"old"},"reallive/1/encrypted":{"path":"new"}}}"#,
        )
        .expect("write duplicate manifest");

        let error = resolve_with_manifest(
            Path::new("/corpus-root"),
            manifest.path(),
            Need {
                engine: "reallive",
                ordinal: 1,
                variant: "encrypted",
            },
        )
        .expect_err("duplicate identities must not select one declaration");

        let message = error.to_string();
        assert!(message.contains("reallive/1/encrypted"));
        assert!(message.contains("old") && message.contains("new"));
    }
}
