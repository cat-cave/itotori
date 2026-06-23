-- Synthetic catalog for integration tests.
--
-- Mirrors /archive/vault/schema.sql v1 (subset relevant to the
-- vault-source adapter). Insertions are deterministic so the synthetic
-- catalog.db file is reproducible across runs.
--
-- Seven fixtures live in this synthetic vault. Each is keyed by a
-- well-known sha256 string (`fixture-<n>-...`) chosen so the by-sha
-- subdirectory layout exercises the resolver's `<aa>/<bb>/<hash>.7z`
-- math. Real sha256 hashes are computed and recorded at test setup time
-- because the archive bytes are constructed in-test (see
-- `tests/common/mod.rs`).
--
-- Note: this file is the seed for the *catalog.db committed-fixture*
-- (built by build.rs). Tests work with per-test temp copies that
-- additionally synchronise artifact sha256 values to the in-test bytes.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (1, '2026-06-23');

CREATE TABLE IF NOT EXISTS works (
  id              INTEGER PRIMARY KEY,
  canonical_title TEXT    NOT NULL,
  original_title  TEXT,
  work_kind       TEXT    NOT NULL CHECK (work_kind IN
    ('game', 'vn', 'audio', 'manga', 'illust', 'video', 'vr', 'other')),
  age_rating      TEXT,
  series_id       TEXT,
  series_name     TEXT,
  series_position INTEGER,
  series_total    INTEGER,
  length_bucket   INTEGER,
  length_minutes  INTEGER,
  first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS work_titles (
  work_id     INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  lang        TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  latin       TEXT,
  is_official INTEGER,
  is_main     INTEGER,
  PRIMARY KEY (work_id, lang)
);

CREATE TABLE IF NOT EXISTS producers (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  romaji        TEXT,
  producer_kind TEXT NOT NULL,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS producer_identifiers (
  id          INTEGER PRIMARY KEY,
  producer_id INTEGER NOT NULL REFERENCES producers(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  value       TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, kind, value)
);

CREATE TABLE IF NOT EXISTS work_producers (
  work_id        INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  producer_id    INTEGER NOT NULL REFERENCES producers(id) ON DELETE RESTRICT,
  role           TEXT NOT NULL,
  character_name TEXT,
  PRIMARY KEY (work_id, producer_id, role, character_name)
);

CREATE TABLE IF NOT EXISTS identifiers (
  id          INTEGER PRIMARY KEY,
  work_id     INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  value       TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, kind, value)
);

CREATE TABLE IF NOT EXISTS releases (
  id            INTEGER PRIMARY KEY,
  work_id       INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  edition_name  TEXT,
  edition_year  INTEGER,
  release_date  TEXT,
  updated_at    TEXT,
  region        TEXT,
  store         TEXT,
  drm_model     TEXT,
  is_portable   INTEGER,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS release_languages (
  release_id    INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL,
  PRIMARY KEY (release_id, language_code)
);

CREATE TABLE IF NOT EXISTS release_platforms (
  release_id INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  platform   TEXT NOT NULL,
  PRIMARY KEY (release_id, platform)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id                INTEGER PRIMARY KEY,
  sha256            TEXT NOT NULL UNIQUE,
  size_bytes        INTEGER NOT NULL,
  artifact_kind     TEXT NOT NULL,
  original_filename TEXT,
  original_url      TEXT,
  original_sha256   TEXT,
  source_account    TEXT,
  observed_at       TEXT NOT NULL DEFAULT (datetime('now')),
  vault_path        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS release_artifacts (
  release_id  INTEGER NOT NULL REFERENCES releases(id)  ON DELETE CASCADE,
  artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  role        TEXT NOT NULL,
  subpath     TEXT,
  PRIMARY KEY (release_id, artifact_id, role, subpath)
);

CREATE TABLE IF NOT EXISTS facts (
  id          INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   INTEGER NOT NULL,
  field       TEXT NOT NULL,
  value       TEXT NOT NULL,
  source      TEXT NOT NULL,
  evidence    TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes       TEXT
);
CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_type, entity_id);

CREATE VIEW IF NOT EXISTS v_current_facts AS
WITH ranked AS (
  SELECT f.*,
    ROW_NUMBER() OVER (
      PARTITION BY entity_type, entity_id, field
      ORDER BY
        CASE evidence
          WHEN 'resolution'         THEN 1
          WHEN 'manual'             THEN 2
          WHEN 'direct_observation' THEN 3
          WHEN 'source_assertion'   THEN 4
          WHEN 'inference'          THEN 5
        END,
        observed_at DESC, id DESC
    ) AS rn
  FROM facts f
)
SELECT entity_type, entity_id, field, value, source, evidence, observed_at, notes, id AS fact_id
FROM ranked WHERE rn = 1;

CREATE VIEW IF NOT EXISTS v_facts_needs_review AS
WITH latest_resolution AS (
  SELECT entity_type, entity_id, field,
         value AS resolved_value,
         MAX(observed_at) AS resolved_at,
         MAX(id) AS resolution_id
  FROM facts
  WHERE evidence = 'resolution'
  GROUP BY entity_type, entity_id, field
)
SELECT lr.entity_type, lr.entity_id, lr.field,
       lr.resolved_value, lr.resolved_at, lr.resolution_id,
       f.value AS conflicting_value, f.source AS conflicting_source,
       f.evidence AS conflicting_evidence, f.observed_at AS conflicting_observed_at,
       f.id AS conflicting_fact_id
FROM facts f
JOIN latest_resolution lr
  ON f.entity_type = lr.entity_type
 AND f.entity_id   = lr.entity_id
 AND f.field       = lr.field
WHERE f.observed_at > lr.resolved_at
  AND f.value != lr.resolved_value
  AND f.evidence != 'resolution';

-- ============================================================
-- Seed data
-- ============================================================

-- Work 1: a VN with VNDB + DLsite + EGS ids
INSERT INTO works (id, canonical_title, original_title, work_kind, age_rating)
VALUES (1, 'Hello Galaxy', 'こんにちは銀河', 'vn', 'r-18');

INSERT INTO work_titles (work_id, lang, title, latin, is_official, is_main)
VALUES
  (1, 'en', 'Hello Galaxy', NULL, 1, 1),
  (1, 'ja', 'こんにちは銀河', 'Konnichiwa Ginga', 1, 0);

INSERT INTO identifiers (id, work_id, source, kind, value) VALUES
  (1, 1, 'vndb',   'v',  'v1234'),
  (2, 1, 'dlsite', 'rj', 'RJ123456'),
  (3, 1, 'egs',    'id', '4321');

-- Work 2: only DLsite id
INSERT INTO works (id, canonical_title, work_kind, age_rating)
VALUES (2, 'Bundle World', 'game', 'all');

INSERT INTO identifiers (id, work_id, source, kind, value) VALUES
  (4, 2, 'dlsite', 'rj', 'RJ222222');

-- Releases
INSERT INTO releases (id, work_id, edition_name, release_date, store, drm_model)
VALUES
  (10, 1, 'Standard',           '2024-01-15', 'dlsite', 'drm-free'),
  (11, 1, 'Subpath Combined',   '2024-02-20', 'dlsite', 'drm-free'),
  (20, 2, 'Standard',           '2024-03-10', 'dlsite', 'drm-free');

INSERT INTO release_languages (release_id, language_code) VALUES
  (10, 'ja'),
  (11, 'ja'),
  (20, 'ja'),
  (20, 'en');

INSERT INTO release_platforms (release_id, platform) VALUES
  (10, 'windows'),
  (11, 'windows'),
  (11, 'macos'),
  (20, 'windows');

-- Artifact rows are inserted at test setup time once the synthetic 7z
-- archives have been built and their real sha256 computed. We keep the
-- table empty in the static seed.
-- (release_artifacts also defer.)

-- Facts: engine claim for release 10 + 11
INSERT INTO facts (id, entity_type, entity_id, field, value, source, evidence)
VALUES
  (1, 'release', 10, 'engine',         'kirikiri',  'filesystem', 'direct_observation'),
  (2, 'release', 10, 'engine_version', '2.32',      'filesystem', 'direct_observation'),
  (3, 'release', 11, 'engine',         'kirikiri',  'filesystem', 'direct_observation');
