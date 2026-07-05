//! UTSUSHI-119: the MV/MZ **patched-output** runtime-observation PROOF command
//! (`utsushi mvmz-patched-runtime-proof`).
//!
//! Consumes the UTSUSHI-006 browser trace-probe output over the PATCHED fixture
//! (a real launched Chromium `--dump-dom` of the game AFTER a Kaifuu patch-back
//! swapped the translation in), the Kaifuu `PatchResult` that attests the
//! patched output by hash, and the UTSUSHI-102 alpha proof, and emits a
//! strict-proof verdict that the observed runtime text is the TRANSLATION the
//! PatchResult attests to — not the pre-patch original — linked to bridge units.
//!
//! The verdict is `patchedRuntimeObservationProven: true` only when every
//! mandatory check passes: the patched trace re-derives the full UTSUSHI-102 E1
//! strict proof (live-DOM, E1 tier, full linkage, observed translation absent
//! from EVERY consumed static input), the observed output hashes to the
//! PatchResult.outputHash, every observed string differs from the pre-patch
//! source, and the alpha proof is a proven E1 UTSUSHI-102 proof over the same
//! bridge units. When the verdict is false the command exits non-zero.
//!
//! ```text
//! utsushi trace <PATCHED_FIXTURE> --adapter utsushi-browser --output trace.json
//! utsushi mvmz-patched-runtime-proof --patched-runtime-trace trace.json \
//!         --patched-fixture-dir <PATCHED_FIXTURE> --patch-result patch-result.json \
//!         --alpha-proof alpha-proof.json [--screenshot-evidence capture.json] --output proof.json
//! ```

use std::error::Error;
use std::path::PathBuf;

use utsushi_core::write_json;
use utsushi_fixture::mvmz_patched_runtime_proof::mvmz_patched_runtime_proof_from_paths;

const HELP: &str = r"utsushi mvmz-patched-runtime-proof — MV/MZ PATCHED launched-runtime observation proof (UTSUSHI-119)

Usage:
  utsushi mvmz-patched-runtime-proof \
    --patched-runtime-trace <PATH> \
    --patched-fixture-dir <DIR> \
    --patch-result <PATH> \
    --alpha-proof <PATH> \
    [--screenshot-evidence <PATH>] \
    --output <PATH>

  --patched-runtime-trace <PATH>  UTSUSHI-006 trace of the PATCHED fixture launch (E1 runtime
                                  evidence from `utsushi trace --adapter utsushi-browser`).
  --patched-fixture-dir <DIR>     The PATCHED MV/MZ fixture directory (its STATIC source bytes;
                                  the crux confirms the observed translation is absent from it).
  --patch-result <PATH>           Kaifuu PatchResult whose outputHash attests the patched output.
  --alpha-proof <PATH>            The UTSUSHI-102 runtime-observation proof (alpha baseline).
  --screenshot-evidence <PATH>    Optional UTSUSHI-065 capture evidence (screenshot artifactRef).
  --output <PATH>                 Patched-runtime-observation proof manifest JSON.

Exit codes:
  0  patchedRuntimeObservationProven = true   — E1 launched patched-output observation proven.
  1  patchedRuntimeObservationProven = false  — the trace could not satisfy the patched E1 proof.
";

const VALUE_FLAGS: &[&str] = &[
    "--patched-runtime-trace",
    "--patched-fixture-dir",
    "--patch-result",
    "--alpha-proof",
    "--screenshot-evidence",
    "--output",
];

/// Execute the `mvmz-patched-runtime-proof` subcommand. Argv excludes the
/// leading `mvmz-patched-runtime-proof` token.
pub fn run_mvmz_patched_runtime_proof_command(args: &[String]) -> Result<(), Box<dyn Error>> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        print!("{HELP}");
        return Ok(());
    }

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

    let patched_runtime_trace = PathBuf::from(required_flag(args, "--patched-runtime-trace")?);
    let patched_fixture_dir = PathBuf::from(required_flag(args, "--patched-fixture-dir")?);
    let patch_result = PathBuf::from(required_flag(args, "--patch-result")?);
    let alpha_proof = PathBuf::from(required_flag(args, "--alpha-proof")?);
    let screenshot_evidence = optional_flag(args, "--screenshot-evidence").map(PathBuf::from);
    let output = PathBuf::from(required_flag(args, "--output")?);

    let proof = mvmz_patched_runtime_proof_from_paths(
        &patched_runtime_trace,
        &patched_fixture_dir,
        &patch_result,
        &alpha_proof,
        screenshot_evidence.as_deref(),
    )?;
    write_json(&output, &proof)?;

    let proven = proof
        .get("patchedRuntimeObservationProven")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let tier = proof
        .get("provenEvidenceTier")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("none");

    if !proven {
        return Err(format!(
            "utsushi.mvmz_patched_runtime_proof.not_proven: the consumed patched trace could not \
             satisfy the patched E1 runtime observation (provenEvidenceTier={tier}); a static read \
             cannot forge the patched observation, and the observation must reproduce the \
             PatchResult-attested translation"
        )
        .into());
    }

    eprintln!(
        "utsushi mvmz-patched-runtime-proof: patchedRuntimeObservationProven=true provenEvidenceTier={tier}"
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
            "utsushi-u119-cli-{name}-{}-{nonce}.json",
            std::process::id()
        ))
    }

    #[test]
    fn command_consumes_committed_evidence_and_writes_patched_e1_proof() {
        let root = fixture_root();
        let output = temp_output("proof");
        let args = vec![
            "--patched-runtime-trace".to_string(),
            root.join("mvmz_patched_runtime_proof/patched-runtime-trace.json")
                .display()
                .to_string(),
            "--patched-fixture-dir".to_string(),
            root.join("mvmz_patched_observation").display().to_string(),
            "--patch-result".to_string(),
            root.join("mvmz_patched_runtime_proof/patch-result.json")
                .display()
                .to_string(),
            "--alpha-proof".to_string(),
            root.join("mvmz_patched_runtime_proof/alpha-proof.json")
                .display()
                .to_string(),
            "--output".to_string(),
            output.display().to_string(),
        ];

        run_mvmz_patched_runtime_proof_command(&args)
            .expect("patched proof command must succeed on real committed evidence");

        let proof: Value =
            serde_json::from_str(&std::fs::read_to_string(&output).unwrap()).unwrap();
        assert_eq!(proof["patchedRuntimeObservationProven"], true);
        assert_eq!(proof["provenEvidenceTier"], "E1");
        assert_eq!(proof["patchAttestation"]["hashMatches"], true);
        assert_eq!(
            proof["consumes"]["patchedRuntimeTraceSource"],
            "UTSUSHI-006"
        );
        let _ = std::fs::remove_file(output);
    }

    #[test]
    fn command_fails_when_static_read_cannot_satisfy_patched_e1() {
        // Feed the alpha proof (a static manifest, not a patched trace) as the
        // "trace": it has no live_dom observation events of the translation, so
        // the command must exit non-zero and NOT prove the patched E1.
        let root = fixture_root();
        let output = temp_output("rejected");
        let args = vec![
            "--patched-runtime-trace".to_string(),
            root.join("mvmz_patched_runtime_proof/alpha-proof.json")
                .display()
                .to_string(),
            "--patched-fixture-dir".to_string(),
            root.join("mvmz_patched_observation").display().to_string(),
            "--patch-result".to_string(),
            root.join("mvmz_patched_runtime_proof/patch-result.json")
                .display()
                .to_string(),
            "--alpha-proof".to_string(),
            root.join("mvmz_patched_runtime_proof/alpha-proof.json")
                .display()
                .to_string(),
            "--output".to_string(),
            output.display().to_string(),
        ];

        let error = run_mvmz_patched_runtime_proof_command(&args)
            .expect_err("a non-trace static manifest must not satisfy the patched E1");
        assert!(
            error.to_string().contains("not_proven"),
            "unexpected error: {error}"
        );
        let proof: Value =
            serde_json::from_str(&std::fs::read_to_string(&output).unwrap()).unwrap();
        assert_eq!(proof["patchedRuntimeObservationProven"], false);
        assert_eq!(proof["provenEvidenceTier"], "none");
        let _ = std::fs::remove_file(output);
    }

    #[test]
    fn command_rejects_unknown_flags() {
        let error =
            run_mvmz_patched_runtime_proof_command(&["--bogus".to_string(), "x".to_string()])
                .expect_err("unknown flag must be rejected");
        assert!(error.to_string().contains("unexpected argument"));
    }
}
