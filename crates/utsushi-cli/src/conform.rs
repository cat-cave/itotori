use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use utsushi_core::{
    CONFORMANCE_SCHEMA_VERSION, ConformanceAbiVersion, ConformanceManifest, ConformanceProfile,
    ConformanceResult, EnginePort, EvidenceTier, InMemorySnapshotStore, PortRequest, ProfileId,
    ResultOutcome, Runner, RuntimeOperation, Snapshot, SnapshotConformanceCheck, SnapshotId,
    SnapshotRef, SnapshotRequest, SubsystemRequirement,
    cross_validate_conformance_manifest_against_port_manifest,
    cross_validate_results_against_manifest, diff_snapshots, take_snapshot, write_json,
};
use utsushi_fixture::{FixtureEnginePort, FixturePortInspectState, FixturePortStateInspectable};

const USAGE: &str = "usage: utsushi conform <game_dir> [--adapter utsushi-fixture] --output <path>";
const RUN_ID: &str = "cli-conformance-run";
const BASELINE_SNAPSHOT_ID: &str = "cli-baseline-golden-post-trace";
const OBSERVED_SNAPSHOT_ID: &str = "cli-observed-live-post-trace";
const BASELINE_PROVENANCE: &str = "golden_post_trace_from_source";
const OBSERVED_PROVENANCE: &str = "live_fixture_port_after_runner";

/// Source of RFC3339 instants for `recordedAt` / snapshot `generated_at`.
/// Production uses wall clock; tests inject a fixed instant.
pub(crate) trait InstantSource {
    fn now_rfc3339(&self) -> Result<String, Box<dyn std::error::Error>>;
}

/// Wall-clock instant source used by the shipping CLI path.
pub(crate) struct SystemInstantSource;

impl InstantSource for SystemInstantSource {
    fn now_rfc3339(&self) -> Result<String, Box<dyn std::error::Error>> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("system clock before unix epoch: {error}"))?;
        Ok(unix_secs_to_rfc3339_z(now.as_secs()))
    }
}

/// Deterministic instant source for tests only.
#[cfg(test)]
pub(crate) struct FixedInstantSource {
    instant: &'static str,
}

#[cfg(test)]
impl InstantSource for FixedInstantSource {
    fn now_rfc3339(&self) -> Result<String, Box<dyn std::error::Error>> {
        Ok(self.instant.to_string())
    }
}

pub fn run_conform_command(tail: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    validate_exact_flags(tail)?;

    let input_root = PathBuf::from(tail.first().ok_or("missing game_dir")?);
    let adapter_name =
        optional_flag(tail, "--adapter").unwrap_or(utsushi_fixture::FixtureRuntimeAdapter::NAME);
    if adapter_name != utsushi_fixture::FixtureRuntimeAdapter::NAME {
        return Err(format!(
            "unsupported conform adapter {adapter_name}; only {} is currently wired",
            utsushi_fixture::FixtureRuntimeAdapter::NAME
        )
        .into());
    }
    let output = PathBuf::from(flag(tail, "--output")?);

    let result = run_fixture_conformance(&input_root, &SystemInstantSource, None)?;
    write_json(&output, &result.to_json_value()?)?;
    Ok(())
}

/// Drive `FixtureEnginePort` through [`Runner`], compare an independently
/// prepared golden post-trace baseline against the live port's post-run
/// inspectable state, and emit a [`ConformanceResult`].
///
/// `mutate_observed` is an optional post-run hook used by negative tests to
/// deliberately alter live port state before the observed snapshot is taken.
fn run_fixture_conformance(
    input_root: &Path,
    clock: &dyn InstantSource,
    mutate_observed: Option<fn(&mut FixtureEnginePort)>,
) -> Result<ConformanceResult, Box<dyn std::error::Error>> {
    let manifest = fixture_conformance_manifest();
    manifest.validate()?;
    cross_validate_conformance_manifest_against_port_manifest(
        &manifest,
        &<FixtureEnginePort as EnginePort>::MANIFEST,
    )?;

    let recorded_at = clock.now_rfc3339()?;
    let units_loaded = count_fixture_source_units(input_root)?;

    // Independently prepared immutable golden baseline (not derived from the
    // live port after the run). Provenance: golden_post_trace_from_source.
    let baseline = take_golden_baseline_snapshot(units_loaded, &recorded_at)?;

    let mut port = FixtureEnginePort::new();
    let runner = Runner::new();
    let request = PortRequest::new(input_root, RUN_ID, RuntimeOperation::Trace);
    let _outcome = runner.run_trace(&mut port, &request)?;

    if let Some(mutate) = mutate_observed {
        mutate(&mut port);
    }

    // Observed snapshot from the real fixture-port Inspectable after Runner.
    // Provenance: live_fixture_port_after_runner.
    let observed = take_live_observed_snapshot(&port, &recorded_at)?;

    let store = InMemorySnapshotStore::new();
    store.insert(baseline.clone())?;
    store.insert(observed.clone())?;
    let check = SnapshotConformanceCheck {
        profile: ProfileId::SnapshotRestore,
        baseline: snapshot_ref(&baseline),
        observed: snapshot_ref(&observed),
        expected_tier: EvidenceTier::E1,
    };
    let check_outcome = check.run(&store);
    let diff = diff_snapshots(&baseline, &observed)?;

    let (outcome, evidence) = match check_outcome {
        ResultOutcome::Pass { evidence_tier } => {
            let evidence = SnapshotConformanceCheck::pass_evidence_for(&baseline)
                .into_iter()
                .collect::<Vec<_>>();
            (ResultOutcome::Pass { evidence_tier }, evidence)
        }
        ResultOutcome::Fail {
            semantic_code,
            detail,
        } => {
            let evidence = SnapshotConformanceCheck::state_path_evidence_from_diff(&diff);
            (
                ResultOutcome::Fail {
                    semantic_code,
                    detail: format!(
                        "{detail}; baseline_snapshot_id={BASELINE_SNAPSHOT_ID} \
                         (provenance={BASELINE_PROVENANCE}) \
                         observed_snapshot_id={OBSERVED_SNAPSHOT_ID} \
                         (provenance={OBSERVED_PROVENANCE})"
                    ),
                },
                evidence,
            )
        }
        other => (other, Vec::new()),
    };

    let result = ConformanceResult {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: utsushi_fixture::FixtureRuntimeAdapter::NAME.to_string(),
        profile_id: ProfileId::SnapshotRestore,
        outcome,
        evidence,
        recorded_at,
    };
    cross_validate_results_against_manifest(&manifest, std::slice::from_ref(&result))?;
    Ok(result)
}

fn fixture_conformance_manifest() -> ConformanceManifest {
    ConformanceManifest {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: utsushi_fixture::FixtureRuntimeAdapter::NAME.to_string(),
        abi_version: ConformanceAbiVersion(1),
        supported_profiles: vec![ConformanceProfile {
            id: ProfileId::SnapshotRestore,
            required_subsystems: vec![SubsystemRequirement::SnapshotPrimitives],
            evidence_tier_ceiling: EvidenceTier::E1,
        }],
        optional_extensions: Vec::new(),
    }
}

/// Count units in the fixture `source.json` independently of the port so the
/// golden baseline is not circular with the live run.
fn count_fixture_source_units(input_root: &Path) -> Result<u64, Box<dyn std::error::Error>> {
    let source_path = input_root.join("source.json");
    let raw = std::fs::read_to_string(&source_path)
        .map_err(|error| format!("fixture source read failed: {error}"))?;
    let source: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("fixture source parse failed: {error}"))?;
    let units = source["units"]
        .as_array()
        .ok_or("fixture source missing units array")?;
    if units.is_empty() {
        return Err("fixture source has no units".into());
    }
    Ok(units.len() as u64)
}

fn take_golden_baseline_snapshot(
    units_loaded: u64,
    recorded_at: &str,
) -> Result<Snapshot, Box<dyn std::error::Error>> {
    let golden = FixturePortStateInspectable::new(FixturePortInspectState::expected_post_trace(
        units_loaded,
    ));
    let request = SnapshotRequest::new(RUN_ID, recorded_at, EvidenceTier::E1)
        .with_snapshot_id(SnapshotId::parse(BASELINE_SNAPSHOT_ID)?);
    Ok(take_snapshot(&golden, &request)?)
}

fn take_live_observed_snapshot(
    port: &FixtureEnginePort,
    recorded_at: &str,
) -> Result<Snapshot, Box<dyn std::error::Error>> {
    let request = SnapshotRequest::new(RUN_ID, recorded_at, EvidenceTier::E1)
        .with_snapshot_id(SnapshotId::parse(OBSERVED_SNAPSHOT_ID)?);
    Ok(take_snapshot(port, &request)?)
}

fn snapshot_ref(snapshot: &Snapshot) -> SnapshotRef {
    SnapshotRef {
        snapshot_id: snapshot.snapshot_id().clone(),
        inspectable_id: snapshot.inspectable_id().to_string(),
        evidence_tier: snapshot.evidence_tier(),
    }
}

/// Convert unix seconds to an RFC3339 UTC instant (`YYYY-MM-DDTHH:MM:SSZ`).
/// Uses Howard Hinnant's civil-from-days algorithm (public domain).
fn unix_secs_to_rfc3339_z(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let hour = rem / 3_600;
    let min = (rem % 3_600) / 60;
    let sec = rem % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z")
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

fn validate_exact_flags(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    if args.is_empty() {
        return Err(format!("missing game_dir; {USAGE}").into());
    }
    if args[0].starts_with("--") {
        return Err(format!("missing game_dir; {USAGE}").into());
    }

    let mut seen_flags = std::collections::HashSet::new();
    let mut index = 1;
    while index < args.len() {
        let name = args[index].as_str();
        if !["--adapter", "--output"].contains(&name) {
            return Err(format!("unknown flag {name}; {USAGE}").into());
        }
        if !seen_flags.insert(name) {
            return Err(format!("duplicate flag {name}; {USAGE}").into());
        }
        let Some(value) = args.get(index + 1) else {
            return Err(format!("missing value for flag {name}; {USAGE}").into());
        };
        if value.starts_with("--") {
            return Err(format!("missing value for flag {name}; {USAGE}").into());
        }
        index += 2;
    }
    if !seen_flags.contains("--output") {
        return Err(format!("missing flag --output; {USAGE}").into());
    }
    Ok(())
}

fn flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn std::error::Error>> {
    optional_flag(args, name).ok_or_else(|| format!("missing flag {name}; {USAGE}").into())
}

fn optional_flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    const TEST_RECORDED_AT: &str = "2026-07-09T12:34:56Z";

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "utsushi-cli-conform-{name}-{}-{nonce}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_fixture_source(game_dir: &Path) {
        fs::create_dir_all(game_dir).unwrap();
        fs::write(
            game_dir.join("source.json"),
            r#"{
  "gameId": "conform-fixture",
  "title": "Conform Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "conform.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "確認。",
      "targetText": "Confirmed.",
      "protectedSpans": []
    }
  ]
}
"#,
        )
        .unwrap();
    }

    fn test_clock() -> FixedInstantSource {
        FixedInstantSource {
            instant: TEST_RECORDED_AT,
        }
    }

    #[test]
    fn conform_pass_when_live_port_matches_independent_golden_baseline() {
        let root = temp_dir("pass-match");
        let game_dir = root.join("game");
        write_fixture_source(&game_dir);

        let result = run_fixture_conformance(&game_dir, &test_clock(), None).unwrap();
        assert_eq!(result.recorded_at, TEST_RECORDED_AT);
        match &result.outcome {
            ResultOutcome::Pass { evidence_tier } => {
                assert_eq!(*evidence_tier, EvidenceTier::E1);
            }
            other => panic!("expected Pass from matching golden vs live state, got {other:?}"),
        }
        assert!(
            !result.evidence.is_empty(),
            "Pass must carry evidence from the real baseline state tree"
        );
        let path = match &result.evidence[0] {
            utsushi_core::EvidenceRef::StatePath { path } => path.as_str(),
            other => panic!("expected statePath evidence, got {other:?}"),
        };
        // Evidence must come from the real fixture-port state contract, not a
        // fabricated sentinel like port.observation_count.
        assert!(
            path.starts_with("port.") || path.starts_with("metadata."),
            "evidence path must be from the fixture-port contract, got {path}"
        );
        assert_ne!(path, "port.observation_count");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn conform_fail_when_observed_port_state_is_deliberately_mutated() {
        let root = temp_dir("fail-mutation");
        let game_dir = root.join("game");
        write_fixture_source(&game_dir);

        // Independently prepared expectation is units_loaded=1 after one unit.
        // Mutating the live port to 999 forces real state drift on
        // port.units_loaded — not a harness-fabricated baseline=0 sentinel.
        let result = run_fixture_conformance(
            &game_dir,
            &test_clock(),
            Some(|port| port.mutate_units_loaded_for_test(999)),
        )
        .unwrap();

        match &result.outcome {
            ResultOutcome::Fail {
                semantic_code,
                detail,
            } => {
                assert_eq!(semantic_code, "utsushi.snapshot.state_drift");
                assert!(
                    detail.contains(BASELINE_SNAPSHOT_ID),
                    "fail detail must keep baseline provenance: {detail}"
                );
                assert!(
                    detail.contains(OBSERVED_SNAPSHOT_ID),
                    "fail detail must keep observed provenance: {detail}"
                );
                assert!(
                    detail.contains(BASELINE_PROVENANCE),
                    "fail detail must name golden provenance: {detail}"
                );
                assert!(
                    detail.contains(OBSERVED_PROVENANCE),
                    "fail detail must name live-port provenance: {detail}"
                );
            }
            other => panic!("expected Fail from mutated observed state, got {other:?}"),
        }
        let paths: Vec<&str> = result
            .evidence
            .iter()
            .filter_map(|entry| match entry {
                utsushi_core::EvidenceRef::StatePath { path } => Some(path.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            paths.contains(&"port.units_loaded"),
            "mutated units_loaded must appear as statePath evidence, got {paths:?}"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn conform_command_writes_pass_result_from_real_fixture_port_state() {
        let root = temp_dir("writes-result");
        let game_dir = root.join("game");
        write_fixture_source(&game_dir);
        let output = root.join("result.json");

        run_conform_command(&[
            game_dir.display().to_string(),
            "--adapter".to_string(),
            utsushi_fixture::FixtureRuntimeAdapter::NAME.to_string(),
            "--output".to_string(),
            output.display().to_string(),
        ])
        .unwrap();

        let value: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
        assert_eq!(value["schemaVersion"], CONFORMANCE_SCHEMA_VERSION);
        assert_eq!(
            value["adapterId"],
            utsushi_fixture::FixtureRuntimeAdapter::NAME
        );
        assert_eq!(value["profileId"], "snapshot-restore");
        assert_eq!(value["outcome"]["kind"], "pass");
        assert_eq!(value["outcome"]["evidenceTier"], "E1");
        assert_eq!(value["evidence"][0]["artifactKind"], "statePath");
        let evidence_path = value["evidence"][0]["path"].as_str().unwrap();
        assert!(
            evidence_path.starts_with("port.") || evidence_path.starts_with("metadata."),
            "evidence must quote a real fixture-port path, got {evidence_path}"
        );
        // Production path uses a real wall-clock instant, not the old fixed
        // 2026-07-09T00:00:00Z constant.
        let recorded_at = value["recordedAt"].as_str().unwrap();
        assert_ne!(recorded_at, "2026-07-09T00:00:00Z");
        assert!(
            recorded_at.contains('T') && recorded_at.ends_with('Z'),
            "recordedAt must be RFC3339 Z, got {recorded_at}"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unix_secs_to_rfc3339_z_known_epoch() {
        assert_eq!(unix_secs_to_rfc3339_z(0), "1970-01-01T00:00:00Z");
        // 2026-07-09T00:00:00Z
        assert_eq!(
            unix_secs_to_rfc3339_z(1_783_555_200),
            "2026-07-09T00:00:00Z"
        );
    }
}
