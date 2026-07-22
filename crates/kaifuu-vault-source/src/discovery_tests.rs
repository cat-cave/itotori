use super::*;

#[test]
fn load_candidate_surfaces_language_row_decode_error_instead_of_dropping_it() {
    // A release_languages row whose language_code is NULL fails to
    // decode as String. The loader must surface that as a typed error,
    // not silently drop the row (which would mask/fabricate a
    // disjoint-set finding downstream in cross_check).
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE releases (\
             id INTEGER PRIMARY KEY, work_id INTEGER, \
             edition_name TEXT, release_date TEXT, store TEXT);\
         INSERT INTO releases (id, work_id) VALUES (1, 1);\
         CREATE TABLE v_current_facts (\
             entity_type TEXT, entity_id INTEGER, field TEXT, value TEXT);\
         CREATE TABLE v_facts_needs_review (\
             entity_type TEXT, entity_id INTEGER, field TEXT);\
         CREATE TABLE release_languages (release_id INTEGER, language_code);\
         INSERT INTO release_languages (release_id, language_code) \
             VALUES (1, NULL);\
         CREATE TABLE release_platforms (release_id INTEGER, platform TEXT);",
    )
    .unwrap();

    let err =
        load_candidate(&conn, 1).expect_err("a NULL language_code row must surface a typed error");
    assert!(
        matches!(err, VaultSourceError::CatalogSchemaUnsupported { .. }),
        "expected CatalogSchemaUnsupported, got {err:?}"
    );
}

#[test]
fn load_candidate_returns_decoded_language_and_platform_sets() {
    // Happy path: well-typed rows decode into the candidate's sets.
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE releases (\
             id INTEGER PRIMARY KEY, work_id INTEGER, \
             edition_name TEXT, release_date TEXT, store TEXT);\
         INSERT INTO releases (id, work_id) VALUES (1, 1);\
         CREATE TABLE v_current_facts (\
             entity_type TEXT, entity_id INTEGER, field TEXT, value TEXT);\
         CREATE TABLE v_facts_needs_review (\
             entity_type TEXT, entity_id INTEGER, field TEXT);\
         CREATE TABLE release_languages (release_id INTEGER, language_code);\
         INSERT INTO release_languages (release_id, language_code) \
             VALUES (1, 'ja');\
         CREATE TABLE release_platforms (release_id INTEGER, platform TEXT);\
         INSERT INTO release_platforms (release_id, platform) \
             VALUES (1, 'windows');",
    )
    .unwrap();

    let candidate = load_candidate(&conn, 1).unwrap();
    assert_eq!(candidate.languages, vec!["ja".to_string()]);
    assert_eq!(candidate.platforms, vec!["windows".to_string()]);
}

#[test]
fn load_candidate_returns_benign_none_when_engine_fact_row_is_absent() {
    // A genuinely-absent engine/engine_version fact (QueryReturnedNoRows)
    // is the benign default: engine/engine_version None, needs_review
    // false. This must NOT be conflated with a real DB error.
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE releases (\
             id INTEGER PRIMARY KEY, work_id INTEGER, \
             edition_name TEXT, release_date TEXT, store TEXT);\
         INSERT INTO releases (id, work_id) VALUES (1, 1);\
         CREATE TABLE v_current_facts (\
             entity_type TEXT, entity_id INTEGER, field TEXT, value TEXT);\
         CREATE TABLE v_facts_needs_review (\
             entity_type TEXT, entity_id INTEGER, field TEXT);\
         CREATE TABLE release_languages (release_id INTEGER, language_code);\
         CREATE TABLE release_platforms (release_id INTEGER, platform TEXT);",
    )
    .unwrap();

    let candidate = load_candidate(&conn, 1).unwrap();
    assert_eq!(candidate.engine, None);
    assert_eq!(candidate.engine_version, None);
    assert!(!candidate.engine_needs_review);
}

#[test]
fn load_candidate_propagates_engine_fact_decode_error_instead_of_none() {
    // Regression guard: a real query/decode error on the engine fact
    // (here an integer value that fails to decode as String) must
    // PROPAGATE as a typed error, not be silently swallowed to None via
    // `.ok`. Same guarantee as the ByEngineClaim path.
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE releases (\
             id INTEGER PRIMARY KEY, work_id INTEGER, \
             edition_name TEXT, release_date TEXT, store TEXT);\
         INSERT INTO releases (id, work_id) VALUES (1, 1);\
         CREATE TABLE v_current_facts (\
             entity_type TEXT, entity_id INTEGER, field TEXT, value);\
         INSERT INTO v_current_facts (entity_type, entity_id, field, value) \
             VALUES ('release', 1, 'engine', X'00');\
         CREATE TABLE v_facts_needs_review (\
             entity_type TEXT, entity_id INTEGER, field TEXT);\
         CREATE TABLE release_languages (release_id INTEGER, language_code);\
         CREATE TABLE release_platforms (release_id INTEGER, platform TEXT);",
    )
    .unwrap();

    let err = load_candidate(&conn, 1)
        .expect_err("a non-decodable engine fact value must surface a typed error");
    assert!(
        matches!(err, VaultSourceError::CatalogSchemaUnsupported { .. }),
        "expected CatalogSchemaUnsupported, got {err:?}"
    );
}

#[test]
fn load_candidate_propagates_needs_review_query_error_instead_of_false() {
    // Regression guard: if the needs-review lookup errors for a reason
    // other than "no row" (here the view/table is missing -> schema
    // drift), the loader must surface a typed error rather than defaulting
    // engine_needs_review to false via `.is_ok`.
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE releases (\
             id INTEGER PRIMARY KEY, work_id INTEGER, \
             edition_name TEXT, release_date TEXT, store TEXT);\
         INSERT INTO releases (id, work_id) VALUES (1, 1);\
         CREATE TABLE v_current_facts (\
             entity_type TEXT, entity_id INTEGER, field TEXT, value TEXT);\
         CREATE TABLE release_languages (release_id INTEGER, language_code);\
         CREATE TABLE release_platforms (release_id INTEGER, platform TEXT);",
    )
    .unwrap();

    let err = load_candidate(&conn, 1)
        .expect_err("a missing v_facts_needs_review view must surface a typed error");
    assert!(
        matches!(err, VaultSourceError::CatalogSchemaUnsupported { .. }),
        "expected CatalogSchemaUnsupported, got {err:?}"
    );
}
