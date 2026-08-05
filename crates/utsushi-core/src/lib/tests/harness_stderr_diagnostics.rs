use super::*;

const STDERR_CONTENT_SENTINEL: &str = "runtime-diagnostic-content-sentinel";
const STDERR_SECRET_SENTINEL: &str = "runtime-diagnostic-secret-sentinel";
const STDOUT_CONTENT_SENTINEL: &str = "runtime-diagnostic-stdout-sentinel";

pub(super) fn nonzero_exit_summarizes_stderr_without_exposing_contents() {
    let script = format!(
        "printf '%s\\n' 'stdout={STDOUT_CONTENT_SENTINEL}'\ni=0\nwhile [ \"$i\" -lt 4096 ]; do\n  printf '%s\\n' 'content={STDERR_CONTENT_SENTINEL} api_key={STDERR_SECRET_SENTINEL}' >&2\n  i=$((i + 1))\ndone\nexit 47"
    );
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        RuntimeLaunchCommand::new("sh").arg("-c").arg(script),
    )
    .with_timeout(Duration::from_secs(5))
    .with_shutdown_grace(Duration::from_secs(1))
    .with_poll_interval(Duration::from_millis(5));
    let harness = RuntimeLaunchCaptureHarness::new();
    let mut hooks = RuntimeCaptureHooks::new();

    let error = harness.run(&plan, &mut hooks).unwrap_err();

    assert_eq!(error.kind, RuntimeHarnessErrorKind::ProcessFailed);
    assert_eq!(detail(&error, "exitCode"), Some("47"));
    assert_eq!(
        detail(&error, "stderrDisposition"),
        Some("content_redacted")
    );
    assert_eq!(detail(&error, "stderrReadStatus"), Some("complete"));
    let stderr_bytes = detail(&error, "stderrBytes")
        .and_then(|value| value.parse::<u64>().ok())
        .expect("stderr byte count must be numeric");
    assert!(
        stderr_bytes > 64 * 1024,
        "the stream must be drained past a typical pipe capacity"
    );
    let stderr_sha256 = detail(&error, "stderrSha256").expect("stderr digest must be present");
    assert_eq!(stderr_sha256.len(), 64);
    assert!(
        stderr_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase()),
        "stderr digest must be lowercase hexadecimal"
    );

    for diagnostic in [error.to_string(), error.to_json().to_string()] {
        assert!(
            !diagnostic.contains(STDERR_CONTENT_SENTINEL),
            "raw runtime content must never escape the stderr summary: {diagnostic}"
        );
        assert!(
            !diagnostic.contains(STDERR_SECRET_SENTINEL),
            "raw runtime secrets must never escape the stderr summary: {diagnostic}"
        );
        assert!(
            !diagnostic.contains(STDOUT_CONTENT_SENTINEL),
            "raw runtime stdout must remain contained: {diagnostic}"
        );
    }
}

fn detail<'a>(error: &'a RuntimeHarnessError, key: &str) -> Option<&'a str> {
    error
        .details
        .iter()
        .find_map(|(candidate, value)| (candidate == key).then_some(value.as_str()))
}
