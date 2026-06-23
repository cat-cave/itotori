//! Catalog-discovery layer.
//!
//! All queries are parameter-bound; no string interpolation reaches the
//! SQLite query planner.

use rusqlite::Connection;

use crate::error::VaultSourceError;
use crate::paths::ExternalId;

/// A claim about a work or release, in the shape the contract's *Discovery*
/// section names.
#[derive(Debug, Clone)]
pub enum ClaimQuery {
    /// Resolve by external identifier (VNDB v-id, DLsite RJ code, etc.).
    ByExternalId {
        /// `identifiers.source` value.
        source: String,
        /// `identifiers.kind` value.
        kind: String,
        /// `identifiers.value` value.
        value: String,
    },
    /// Resolve by the work's canonical title or by any localized title.
    ByWorkTitle {
        /// Optional `work_titles.lang`.
        language: Option<String>,
        /// `work_titles.title` (or `works.canonical_title`).
        title: String,
    },
    /// Resolve by a producer's external identifier (e.g. DLsite RG code).
    ByProducer {
        /// External id on the `producer_identifiers` row.
        producer_external_id: ExternalId,
    },
    /// Resolve by claimed engine (consults `v_current_facts`).
    ByEngineClaim {
        /// Engine string as stored in `facts.value` (e.g. `kirikiri`).
        engine: String,
        /// Optional engine-version filter.
        engine_version: Option<String>,
    },
    /// Resolve by an exact release id (caller already knows the id).
    ByReleaseId {
        /// `releases.id`.
        release_id: i64,
    },
    /// Catalog-bypass: extract the artifact addressed by sha256 only.
    /// The materialize result is flagged.
    ByArtifactSha {
        /// `artifacts.sha256`.
        sha256: String,
    },
}

impl ClaimQuery {
    /// Short, operator-readable summary used in `ReleaseNotResolved` errors.
    pub fn summary(&self) -> String {
        match self {
            Self::ByExternalId {
                source,
                kind,
                value,
            } => format!("external-id({source}:{kind}={value})"),
            Self::ByWorkTitle { language, title } => match language {
                Some(l) => format!("work-title({l}:{title})"),
                None => format!("work-title({title})"),
            },
            Self::ByProducer {
                producer_external_id,
            } => format!(
                "producer-external({}:{}={})",
                producer_external_id.source,
                producer_external_id.kind,
                producer_external_id.value
            ),
            Self::ByEngineClaim {
                engine,
                engine_version,
            } => match engine_version {
                Some(v) => format!("engine({engine}@{v})"),
                None => format!("engine({engine})"),
            },
            Self::ByReleaseId { release_id } => format!("release-id({release_id})"),
            Self::ByArtifactSha { sha256 } => format!("artifact-sha({sha256})"),
        }
    }
}

/// A discovered candidate release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseCandidate {
    /// `releases.id`.
    pub release_id: i64,
    /// `releases.work_id`.
    pub work_id: i64,
    /// `releases.edition_name`.
    pub edition_name: Option<String>,
    /// `releases.release_date`.
    pub release_date: Option<String>,
    /// `releases.store`.
    pub store: Option<String>,
    /// Engine pulled from `v_current_facts` (if any).
    pub engine: Option<String>,
    /// Engine version pulled from `v_current_facts` (if any).
    pub engine_version: Option<String>,
    /// True when the engine field is on the review queue
    /// (`v_facts_needs_review`).
    pub engine_needs_review: bool,
    /// `release_languages.language_code`.
    pub languages: Vec<String>,
    /// `release_platforms.platform`.
    pub platforms: Vec<String>,
}

/// Run discovery for a claim against a read-only catalog connection.
///
/// Returns one or more candidates, never zero — zero is reported as
/// [`VaultSourceError::ReleaseNotResolved`].
pub fn discover(
    conn: &Connection,
    claim: &ClaimQuery,
) -> Result<Vec<ReleaseCandidate>, VaultSourceError> {
    let release_ids = match claim {
        ClaimQuery::ByReleaseId { release_id } => {
            // direct: confirm row exists
            let exists: Result<i64, rusqlite::Error> = conn.query_row(
                "SELECT id FROM releases WHERE id = ?1",
                rusqlite::params![release_id],
                |r| r.get(0),
            );
            match exists {
                Ok(id) => vec![id],
                Err(_) => Vec::new(),
            }
        }
        ClaimQuery::ByExternalId {
            source,
            kind,
            value,
        } => {
            let mut stmt = conn
                .prepare(
                    "SELECT r.id FROM identifiers i \
                     JOIN releases r ON r.work_id = i.work_id \
                     WHERE i.source = ?1 AND i.kind = ?2 AND i.value = ?3 \
                     ORDER BY r.id",
                )
                .map_err(map_query_err)?;
            let rows = stmt
                .query_map(rusqlite::params![source, kind, value], |r| r.get::<_, i64>(0))
                .map_err(map_query_err)?;
            collect_ids(rows)?
        }
        ClaimQuery::ByWorkTitle { language, title } => {
            let mut stmt = conn
                .prepare(
                    "SELECT r.id FROM releases r \
                     JOIN works w ON w.id = r.work_id \
                     WHERE w.canonical_title = ?1 \
                     UNION \
                     SELECT r.id FROM releases r \
                     JOIN work_titles wt ON wt.work_id = r.work_id \
                     WHERE wt.title = ?1 AND (?2 IS NULL OR wt.lang = ?2) \
                     ORDER BY 1",
                )
                .map_err(map_query_err)?;
            let lang_param: Option<String> = language.clone();
            let rows = stmt
                .query_map(rusqlite::params![title, lang_param], |r| r.get::<_, i64>(0))
                .map_err(map_query_err)?;
            collect_ids(rows)?
        }
        ClaimQuery::ByProducer {
            producer_external_id,
        } => {
            let mut stmt = conn
                .prepare(
                    "SELECT r.id FROM releases r \
                     JOIN work_producers wp ON wp.work_id = r.work_id \
                     JOIN producer_identifiers pi ON pi.producer_id = wp.producer_id \
                     WHERE pi.source = ?1 AND pi.kind = ?2 AND pi.value = ?3 \
                     ORDER BY r.id",
                )
                .map_err(map_query_err)?;
            let rows = stmt
                .query_map(
                    rusqlite::params![
                        producer_external_id.source,
                        producer_external_id.kind,
                        producer_external_id.value,
                    ],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(map_query_err)?;
            collect_ids(rows)?
        }
        ClaimQuery::ByEngineClaim {
            engine,
            engine_version,
        } => {
            // Always include entity filters; v_current_facts is a window
            // function over facts so we restrict by entity_type to use the
            // facts(entity_type, entity_id) index.
            let mut stmt = conn
                .prepare(
                    "SELECT r.id FROM releases r \
                     JOIN v_current_facts vcf \
                       ON vcf.entity_type = 'release' \
                      AND vcf.entity_id   = r.id \
                      AND vcf.field       = 'engine' \
                     WHERE vcf.value = ?1 \
                     ORDER BY r.id",
                )
                .map_err(map_query_err)?;
            let rows = stmt
                .query_map(rusqlite::params![engine], |r| r.get::<_, i64>(0))
                .map_err(map_query_err)?;
            let mut candidates = collect_ids(rows)?;
            if let Some(v) = engine_version {
                let mut filtered = Vec::with_capacity(candidates.len());
                for id in candidates.drain(..) {
                    let observed: Option<String> = conn
                        .query_row(
                            "SELECT value FROM v_current_facts \
                             WHERE entity_type = 'release' \
                               AND entity_id = ?1 \
                               AND field = 'engine_version'",
                            rusqlite::params![id],
                            |r| r.get(0),
                        )
                        .ok();
                    if observed.as_deref() == Some(v.as_str()) {
                        filtered.push(id);
                    }
                }
                candidates = filtered;
            }
            candidates
        }
        ClaimQuery::ByArtifactSha { sha256 } => {
            let mut stmt = conn
                .prepare(
                    "SELECT ra.release_id FROM release_artifacts ra \
                     JOIN artifacts a ON a.id = ra.artifact_id \
                     WHERE a.sha256 = ?1 \
                     ORDER BY ra.release_id",
                )
                .map_err(map_query_err)?;
            let rows = stmt
                .query_map(rusqlite::params![sha256], |r| r.get::<_, i64>(0))
                .map_err(map_query_err)?;
            collect_ids(rows)?
        }
    };

    if release_ids.is_empty() {
        return Err(VaultSourceError::ReleaseNotResolved {
            claim_summary: claim.summary(),
        });
    }

    let mut out = Vec::with_capacity(release_ids.len());
    for rid in release_ids {
        out.push(load_candidate(conn, rid)?);
    }
    Ok(out)
}

fn load_candidate(conn: &Connection, rid: i64) -> Result<ReleaseCandidate, VaultSourceError> {
    let (work_id, edition_name, release_date, store): (
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT work_id, edition_name, release_date, store FROM releases WHERE id = ?1",
            rusqlite::params![rid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(map_query_err)?;

    let engine: Option<String> = conn
        .query_row(
            "SELECT value FROM v_current_facts \
             WHERE entity_type = 'release' AND entity_id = ?1 AND field = 'engine'",
            rusqlite::params![rid],
            |r| r.get(0),
        )
        .ok();

    let engine_version: Option<String> = conn
        .query_row(
            "SELECT value FROM v_current_facts \
             WHERE entity_type = 'release' AND entity_id = ?1 AND field = 'engine_version'",
            rusqlite::params![rid],
            |r| r.get(0),
        )
        .ok();

    let engine_needs_review = conn
        .query_row(
            "SELECT 1 FROM v_facts_needs_review \
             WHERE entity_type = 'release' AND entity_id = ?1 AND field = 'engine' LIMIT 1",
            rusqlite::params![rid],
            |_| Ok(()),
        )
        .is_ok();

    let mut langs_stmt = conn
        .prepare("SELECT language_code FROM release_languages WHERE release_id = ?1 ORDER BY 1")
        .map_err(map_query_err)?;
    let langs = langs_stmt
        .query_map(rusqlite::params![rid], |r| r.get::<_, String>(0))
        .map_err(map_query_err)?
        .filter_map(|r| r.ok())
        .collect();

    let mut plats_stmt = conn
        .prepare("SELECT platform FROM release_platforms WHERE release_id = ?1 ORDER BY 1")
        .map_err(map_query_err)?;
    let plats = plats_stmt
        .query_map(rusqlite::params![rid], |r| r.get::<_, String>(0))
        .map_err(map_query_err)?
        .filter_map(|r| r.ok())
        .collect();

    Ok(ReleaseCandidate {
        release_id: rid,
        work_id,
        edition_name,
        release_date,
        store,
        engine,
        engine_version,
        engine_needs_review,
        languages: langs,
        platforms: plats,
    })
}

/// Load every identifier attached to a work — used downstream by
/// game-id derivation and cross-check.
pub fn load_work_identifiers(
    conn: &Connection,
    work_id: i64,
) -> Result<Vec<ExternalId>, VaultSourceError> {
    let mut stmt = conn
        .prepare(
            "SELECT source, kind, value FROM identifiers \
             WHERE work_id = ?1 \
             ORDER BY source, kind, value",
        )
        .map_err(map_query_err)?;
    let rows = stmt
        .query_map(rusqlite::params![work_id], |r| {
            Ok(ExternalId {
                source: r.get::<_, String>(0)?,
                kind: r.get::<_, String>(1)?,
                value: r.get::<_, String>(2)?,
            })
        })
        .map_err(map_query_err)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(map_query_err)?);
    }
    Ok(out)
}

/// Load the canonical title for a work.
pub fn load_canonical_title(conn: &Connection, work_id: i64) -> Result<String, VaultSourceError> {
    conn.query_row(
        "SELECT canonical_title FROM works WHERE id = ?1",
        rusqlite::params![work_id],
        |r| r.get(0),
    )
    .map_err(map_query_err)
}

fn collect_ids<I>(rows: I) -> Result<Vec<i64>, VaultSourceError>
where
    I: Iterator<Item = rusqlite::Result<i64>>,
{
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(map_query_err)?);
    }
    Ok(out)
}

fn map_query_err(_e: rusqlite::Error) -> VaultSourceError {
    // We do not have a specific failure mode for "query error past open";
    // the contract expects discovery either succeeds, returns zero
    // (ReleaseNotResolved), or fails at open time (CatalogOpenFailed). A
    // genuine query error past open implies catalog corruption / schema
    // drift, which we surface as CatalogSchemaUnsupported to keep the
    // typed-error contract intact (the variant carries `observed=None`
    // when we cannot determine the version any more).
    VaultSourceError::CatalogSchemaUnsupported {
        observed: None,
        supported: crate::error::SUPPORTED_SCHEMA_VERSION,
    }
}
