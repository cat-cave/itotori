//! The MV/MZ runtime-observation PROOF command
//! (`utsushi mvmz-runtime-proof`).
//!
//! Consumes the browser trace-probe output (the runtime evidence
//! report a real launched Chromium `--dump-dom` produced from the public MV/MZ
//! fixture) plus the fixture's STATIC source bytes, and — optionally — the
//! screenshot capture evidence, and emits a strict-proof verdict
//! manifest.
//!
//! The verdict is `runtimeObservationProven: true` only when EVERY mandatory
//! check passes: E1 evidence tier, live-DOM observation source, full
//! bridge-unit / source-revision / runtime-target / adapter / environment
//! linkage, and — THE CRUX — that no observed plaintext is recoverable from the
//! static fixture source (so a static read could not have forged the E1
//! observation). When the verdict is false the command exits non-zero: a static
//! read cannot satisfy E1.
//!
//! Producing the consumed inputs (the contract):
//!
//! ```text
//! utsushi trace <FIXTURE> --adapter utsushi-browser --output trace.json
//! utsushi capture <FIXTURE> --adapter utsushi-browser --artifact-root <DIR> --output capture.json
//! utsushi mvmz-runtime-proof --runtime-trace trace.json --fixture-dir <FIXTURE> \
//!         --screenshot-evidence capture.json --output proof.json
//! ```

use std::error::Error;
use std::path::PathBuf;

use utsushi_core::write_json;
use utsushi_fixture::mvmz_runtime_proof::mvmz_runtime_observation_proof_from_paths;

const HELP: &str = r"utsushi mvmz-runtime-proof — MV/MZ launched-runtime observation proof (UTSUSHI-102)

Usage:
  utsushi mvmz-runtime-proof \
    --runtime-trace <PATH> \
    --fixture-dir <DIR> \
    [--screenshot-evidence <PATH>] \
    --output <PATH>

  --runtime-trace <PATH>         UTSUSHI-006 browser trace-probe output (E1 runtime evidence
                                 report from `utsushi trace --adapter utsushi-browser`).
  --fixture-dir <DIR>            The public MV/MZ fixture directory (its STATIC source bytes;
                                 the crux check confirms observed plaintext is absent from it).
  --screenshot-evidence <PATH>   Optional UTSUSHI-065 capture evidence (screenshot artifactRef).
  --output <PATH>                Runtime-observation proof manifest JSON.

Exit codes:
  0  runtimeObservationProven = true   — E1 launched-runtime observation proven.
  1  runtimeObservationProven = false  — the trace could not satisfy E1 (e.g. a static read).
";

const VALUE_FLAGS: &[&str] = &[
    "--runtime-trace",
    "--fixture-dir",
    "--screenshot-evidence",
    "--output",
];

/// Execute the `mvmz-runtime-proof` subcommand. Argv excludes the leading
/// `mvmz-runtime-proof` token.
pub fn run_mvmz_runtime_proof_command(args: &[String]) -> Result<(), Box<dyn Error>> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        print!("{HELP}");
        return Ok(());
    }

    // Strict flag validation: reject unknown flags and missing values.
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if VALUE_FLAGS.contains(&arg) {
            let value = args.get(index + 1);
            if value.is_none_or(|value| value.starts_with("--")) {
                return Err(format!("missing value for flag {arg}\n{HELP}").into());
            }
            index += 2;
            continue;
        }
        return Err(format!("unexpected argument {arg}\n{HELP}").into());
    }

    let runtime_trace = PathBuf::from(required_flag(args, "--runtime-trace")?);
    let fixture_dir = PathBuf::from(required_flag(args, "--fixture-dir")?);
    let screenshot_evidence = optional_flag(args, "--screenshot-evidence").map(PathBuf::from);
    let output = PathBuf::from(required_flag(args, "--output")?);

    let proof = mvmz_runtime_observation_proof_from_paths(
        &runtime_trace,
        &fixture_dir,
        screenshot_evidence.as_deref(),
    )?;
    write_json(&output, &proof)?;

    let proven = proof
        .get("runtimeObservationProven")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let tier = proof
        .get("provenEvidenceTier")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("none");

    if !proven {
        return Err(format!(
            "utsushi.mvmz_runtime_proof.not_proven: the consumed trace could not satisfy E1 \
             runtime observation (provenEvidenceTier={tier}); a static fixture read cannot forge E1"
        )
        .into());
    }

    eprintln!(
        "utsushi mvmz-runtime-proof: runtimeObservationProven=true provenEvidenceTier={tier}"
    );
    Ok(())
}

fn required_flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn Error>> {
    optional_flag(args, name).ok_or_else(|| format!("missing required flag {name}\n{HELP}").into())
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
    use std::path::Path;

    /// The committed real-launch evidence + fixture live in the utsushi-fixture
    /// crate; reference them relative to this crate's manifest.
    fn fixture_root() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../utsushi-fixture/tests/fixtures")
    }

    fn temp_output(name: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "utsushi-u102-cli-{name}-{}-{nonce}.json",
            std::process::id()
        ))
    }

    #[test]
    fn command_consumes_committed_trace_and_writes_e1_proof() {
        let root = fixture_root();
        let output = temp_output("proof");
        let args = vec![
            "--runtime-trace".to_string(),
            root.join("mvmz_runtime_proof/runtime-trace.json")
                .display()
                .to_string(),
            "--fixture-dir".to_string(),
            root.join("mvmz_observation").display().to_string(),
            "--screenshot-evidence".to_string(),
            root.join("mvmz_runtime_proof/screenshot-evidence.json")
                .display()
                .to_string(),
            "--output".to_string(),
            output.display().to_string(),
        ];

        run_mvmz_runtime_proof_command(&args).expect("proof command must succeed on real evidence");

        let proof: Value =
            serde_json::from_str(&std::fs::read_to_string(&output).unwrap()).unwrap();
        assert_eq!(proof["runtimeObservationProven"], true);
        assert_eq!(proof["provenEvidenceTier"], "E1");
        assert_eq!(proof["consumes"]["runtimeTraceSource"], "UTSUSHI-006");
        assert_eq!(proof["screenshotEvidence"]["available"], true);
        let _ = std::fs::remove_file(output);
    }

    #[test]
    fn command_fails_when_static_read_cannot_satisfy_e1() {
        // Feed the browser CAPTURE report as the "trace": its observations are
        // fixture_declared (not live_dom) and its text is the declared source
        // text present in the static fixture — a static-read surrogate. The
        // command must exit non-zero and NOT prove E1.
        let root = fixture_root();
        let output = temp_output("rejected");
        let args = vec![
            "--runtime-trace".to_string(),
            root.join("mvmz_runtime_proof/screenshot-evidence.json")
                .display()
                .to_string(),
            "--fixture-dir".to_string(),
            root.join("mvmz_observation").display().to_string(),
            "--output".to_string(),
            output.display().to_string(),
        ];

        let error = run_mvmz_runtime_proof_command(&args)
            .expect_err("a static-read surrogate must not satisfy E1");
        assert!(
            error.to_string().contains("not_proven"),
            "unexpected error: {error}"
        );

        // The manifest is still written (records the failed verdict honestly).
        let proof: Value =
            serde_json::from_str(&std::fs::read_to_string(&output).unwrap()).unwrap();
        assert_eq!(proof["runtimeObservationProven"], false);
        assert_eq!(proof["provenEvidenceTier"], "none");
        let _ = std::fs::remove_file(output);
    }

    #[test]
    fn command_rejects_unknown_flags() {
        let error = run_mvmz_runtime_proof_command(&["--bogus".to_string(), "x".to_string()])
            .expect_err("unknown flag must be rejected");
        assert!(error.to_string().contains("unexpected argument"));
    }
}
