//! Read-only `catalog.db` access.
//!
//! `rusqlite::Connection` is opened with `OPEN_READ_ONLY | OPEN_URI` and a
//! `mode=ro` URI. No `PRAGMA` writes, no migrations, no inserts. The
//! connection is created per [`crate::source::VaultSource`] operation and
//! dropped at the end of the call *(Contract: §Discovery — "does not cache
//! the catalog")*.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};

use crate::error::{SUPPORTED_SCHEMA_VERSION, VaultSourceError};

/// Open the catalog read-only.
///
/// Uses a SQLite URI (`file://...?mode=ro`) so the open is genuinely
/// read-only (the underlying connection refuses any write attempt with
/// `SQLITE_READONLY`).
pub fn open_catalog(catalog_path: &Path) -> Result<Connection, VaultSourceError> {
    // SQLite URI requires forward slashes; on Windows this is also accepted
    // by the SQLite URI parser. The `mode=ro` query disables all writes
    // including journal-mode changes.
    let path_str = catalog_path.to_string_lossy();
    let uri = format!("file:{path_str}?mode=ro&immutable=0");
    Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|source| VaultSourceError::CatalogOpenFailed {
        path: catalog_path.to_path_buf(),
        source,
    })
}

/// Probe the highest known schema version. Raises
/// [`VaultSourceError::CatalogSchemaUnsupported`] when the table is empty or
/// the observed version exceeds [`SUPPORTED_SCHEMA_VERSION`].
pub fn probe_schema_version(conn: &Connection) -> Result<u32, VaultSourceError> {
    let observed: Option<u32> = conn
        .query_row(
            "SELECT MAX(version) FROM schema_version",
            [],
            |row| row.get::<_, Option<u32>>(0),
        )
        .map_err(|_| VaultSourceError::CatalogSchemaUnsupported {
            observed: None,
            supported: SUPPORTED_SCHEMA_VERSION,
        })?;
    match observed {
        Some(v) if v == SUPPORTED_SCHEMA_VERSION => Ok(v),
        _ => Err(VaultSourceError::CatalogSchemaUnsupported {
            observed,
            supported: SUPPORTED_SCHEMA_VERSION,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    fn make_catalog_with_schema(version: Option<u32>) -> NamedTempFile {
        let tf = NamedTempFile::new().unwrap();
        let conn = Connection::open(tf.path()).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);",
        )
        .unwrap();
        if let Some(v) = version {
            conn.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?1, '2026-01-01')",
                rusqlite::params![v],
            )
            .unwrap();
        }
        drop(conn);
        tf
    }

    #[test]
    fn open_catalog_succeeds_in_read_only_mode_when_catalog_is_a_file() {
        let tf = make_catalog_with_schema(Some(1));
        let conn = open_catalog(tf.path()).unwrap();
        // confirm we *cannot* write
        let err = conn.execute("CREATE TABLE x(y INTEGER)", []).unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("readonly") || msg.contains("read-only") || msg.contains("read only"),
            "expected readonly error, got: {msg}"
        );
    }

    #[test]
    fn probe_schema_version_returns_pinned_version_when_supported() {
        let tf = make_catalog_with_schema(Some(1));
        let conn = open_catalog(tf.path()).unwrap();
        assert_eq!(probe_schema_version(&conn).unwrap(), 1);
    }

    #[test]
    fn probe_schema_version_raises_when_version_row_is_absent() {
        let tf = make_catalog_with_schema(None);
        let conn = open_catalog(tf.path()).unwrap();
        let err = probe_schema_version(&conn).unwrap_err();
        assert!(matches!(
            err,
            VaultSourceError::CatalogSchemaUnsupported {
                observed: None,
                ..
            }
        ));
    }

    #[test]
    fn probe_schema_version_raises_when_observed_exceeds_supported() {
        let tf = make_catalog_with_schema(Some(99));
        let conn = open_catalog(tf.path()).unwrap();
        let err = probe_schema_version(&conn).unwrap_err();
        match err {
            VaultSourceError::CatalogSchemaUnsupported {
                observed: Some(99),
                ..
            } => {}
            other => panic!("unexpected: {other:?}"),
        }
    }
}
