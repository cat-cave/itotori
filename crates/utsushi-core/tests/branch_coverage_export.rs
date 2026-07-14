//! Export SNAPSHOT tests.
//!
//! Loads the committed synthetic read-model fixture
//! `tests/fixtures/conformance/branch_coverage/coverage_status.json` (shared
//! byte-for-byte with the read-model test), builds the export with
//! an INJECTED generated-at, and byte-compares the JSON + Markdown outputs
//! against committed goldens.
//!
//! Determinism is the whole point: because the generated-at is injected (never
//! `SystemTime::now()`), the same fixture always produces the same bytes, so
//! the goldens are stable. The goldens are pinned in `vite.config.ts`
//! fmt.ignorePatterns so the formatter never rewrites them out from under the
//! byte-compare.
//!
//! Set `UPDATE_BRANCH_COVERAGE_EXPORT_GOLDEN=1` to (re)write the goldens.

use std::path::PathBuf;

use serde_json::Value;
use utsushi_core::conformance::branch_coverage::read_model_from_json;
use utsushi_core::conformance::branch_coverage_export::{
    BRANCH_COVERAGE_EXPORT_SCHEMA_VERSION, build_branch_coverage_export,
    render_branch_coverage_markdown,
};

/// The injected generated-at for the snapshot. A fixed instant so the golden
/// bytes never move.
const GENERATED_AT: &str = "2026-07-05T00:00:00Z";

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("conformance")
        .join("branch_coverage")
}

fn load_read_model() -> Value {
    let path = fixtures_dir().join("coverage_status.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("read fixture {}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|_| panic!("parse fixture {}", path.display()))
}

/// Byte-compare `actual` against the committed golden `name`, or (re)write it
/// when `UPDATE_BRANCH_COVERAGE_EXPORT_GOLDEN` is set.
fn assert_golden(name: &str, actual: &str) {
    let path = fixtures_dir().join(name);
    if std::env::var_os("UPDATE_BRANCH_COVERAGE_EXPORT_GOLDEN").is_some() {
        std::fs::write(&path, actual).unwrap_or_else(|_| panic!("write golden {}", path.display()));
        return;
    }
    let expected =
        std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("read golden {}", path.display()));
    assert_eq!(
        actual,
        expected,
        "golden {} is stale; re-run with UPDATE_BRANCH_COVERAGE_EXPORT_GOLDEN=1",
        path.display()
    );
}

#[test]
fn json_export_matches_committed_golden_bytes() {
    let read_model = read_model_from_json(load_read_model()).expect("read model builds");
    let export =
        build_branch_coverage_export(&read_model, GENERATED_AT, true).expect("export builds");

    // Injected generated-at rode through verbatim, and the required fields are
    // all present before the byte-compare.
    assert_eq!(export.generated_at, GENERATED_AT);
    assert_eq!(export.schema_version, BRANCH_COVERAGE_EXPORT_SCHEMA_VERSION);
    assert!(!export.read_model.records.is_empty());
    assert!(export.gaps.findings.is_some());

    let json = serde_json::to_string_pretty(&export).expect("serialize export");
    // Trailing newline for a POSIX-clean file (matches `write_json`).
    assert_golden("export.golden.json", &format!("{json}\n"));
}

#[test]
fn markdown_export_matches_committed_golden_bytes() {
    let read_model = read_model_from_json(load_read_model()).expect("read model builds");
    let export =
        build_branch_coverage_export(&read_model, GENERATED_AT, true).expect("export builds");
    let markdown = render_branch_coverage_markdown(&export);
    assert_golden("export.golden.md", &markdown);
}

#[test]
fn export_without_findings_omits_findings_and_findings_section() {
    let read_model = read_model_from_json(load_read_model()).expect("read model builds");
    let export =
        build_branch_coverage_export(&read_model, GENERATED_AT, false).expect("export builds");
    // Gap COUNTS are still present even without the detailed findings.
    assert!(export.gaps.findings.is_none());
    assert!(export.gaps.summary.gap_count > 0);
    let markdown = render_branch_coverage_markdown(&export);
    assert!(!markdown.contains("## Gap Findings"));
}
