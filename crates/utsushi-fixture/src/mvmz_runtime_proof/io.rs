use super::*;

/// Read every regular file the fixture directory ships and concatenate their
/// bytes (lossy UTF-8). This is the STATIC source the crux check confirms the
/// observed plaintext is absent from.
pub fn read_static_fixture_source(fixture_dir: &Path) -> UtsushiResult<String> {
    let mut names: Vec<_> = fs::read_dir(fixture_dir)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.path())
        .collect();
    // Deterministic order so the concatenation is stable.
    names.sort();
    let mut combined = String::new();
    for path in names {
        let bytes = fs::read(&path)?;
        combined.push_str(&String::from_utf8_lossy(&bytes));
        combined.push('\n');
    }
    Ok(combined)
}

/// Read the proof inputs from files and build the manifest.
///
/// The IO shell the CLI uses: it reads the runtime trace, the static
/// fixture source, and the optional screenshot evidence, then
/// delegates to the pure [`build_mvmz_runtime_observation_proof`].
pub fn mvmz_runtime_observation_proof_from_paths(
    runtime_trace_path: &Path,
    fixture_dir: &Path,
    screenshot_evidence_path: Option<&Path>,
) -> UtsushiResult<Value> {
    let runtime_trace: Value = serde_json::from_str(&fs::read_to_string(runtime_trace_path)?)?;
    let static_fixture_source = read_static_fixture_source(fixture_dir)?;
    let screenshot_evidence: Option<Value> = match screenshot_evidence_path {
        Some(path) => Some(serde_json::from_str(&fs::read_to_string(path)?)?),
        None => None,
    };

    build_mvmz_runtime_observation_proof(&RuntimeObservationProofInputs {
        runtime_trace: &runtime_trace,
        static_fixture_source: &static_fixture_source,
        screenshot_evidence: screenshot_evidence.as_ref(),
    })
}
