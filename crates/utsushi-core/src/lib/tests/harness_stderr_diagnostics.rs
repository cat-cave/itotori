use super::*;

const STDERR_CONTENT_SENTINEL: &str = "runtime-diagnostic-content-sentinel";
const STDERR_SECRET_SENTINEL: &str = "runtime-diagnostic-secret-sentinel";
const STDERR_URI_SECRET_SENTINEL: &str = "runtime-diagnostic-uri-secret-sentinel";
const STDERR_COMMON_SECRET_SENTINEL: &str = "sk-runtime-secret-token-sentinel";
const STDERR_RAW_SECRET_SENTINEL: &str = "00112233445566778899aabbccddeeff00112233";
const STDOUT_CONTENT_SENTINEL: &str = "runtime-diagnostic-stdout-sentinel";

pub(super) fn nonzero_exit_relays_bounded_span_redacted_stderr() {
    let script = format!(
        "printf '%s\\n' 'stdout={STDOUT_CONTENT_SENTINEL}'\nprintf '%s\\n' 'missing --bridge' >&2\nprintf '%s\\n' 'runtime decode failed: script={STDERR_CONTENT_SENTINEL}; offset=41 api_key={STDERR_SECRET_SENTINEL}; X-Auth={STDERR_SECRET_SENTINEL}; code={STDERR_COMMON_SECRET_SENTINEL}; error={STDERR_RAW_SECRET_SENTINEL}; endpoint=https://operator:{STDERR_URI_SECRET_SENTINEL}@example.invalid/run' >&2\ni=0\nwhile [ \"$i\" -lt 4096 ]; do\n  printf '%s\\n' 'content={STDERR_CONTENT_SENTINEL} api_key={STDERR_SECRET_SENTINEL}' >&2\n  i=$((i + 1))\ndone\nexit 47"
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
    assert_eq!(detail(&error, "stderrDisposition"), Some("span_redacted"));
    assert_eq!(detail(&error, "stderrReadStatus"), Some("complete"));
    let stderr_bytes = detail(&error, "stderrBytes")
        .and_then(|value| value.parse::<u64>().ok())
        .expect("stderr byte count must be numeric");
    assert!(
        stderr_bytes > 64 * 1024,
        "the stream must be drained past a typical pipe capacity"
    );
    let captured_bytes = detail(&error, "stderrCapturedBytes")
        .and_then(|value| value.parse::<usize>().ok())
        .expect("truncated stream must report captured bytes");
    assert!(captured_bytes < usize::try_from(stderr_bytes).unwrap());
    let stderr_sha256 = detail(&error, "stderrSha256").expect("truncated stream needs a digest");
    assert_eq!(stderr_sha256.len(), 64);
    assert!(
        stderr_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase()),
        "stderr digest must be lowercase hexadecimal"
    );

    for diagnostic in [error.to_string(), error.to_json().to_string()] {
        assert!(
            diagnostic.contains("missing --bridge"),
            "missing stderr: {diagnostic}"
        );
        assert!(
            diagnostic.contains("runtime decode failed"),
            "missing diagnostic context: {diagnostic}"
        );
        assert!(
            diagnostic.contains("offset=41"),
            "missing offset: {diagnostic}"
        );
        assert!(
            diagnostic.contains("[REDACTED_CONTENT kind=script"),
            "script span was not summarized: {diagnostic}"
        );
        assert!(diagnostic.contains("[REDACTED_SECRET]"));
        assert!(diagnostic.contains("stderr diagnostic truncated"));
        assert!(
            !diagnostic.contains(STDERR_CONTENT_SENTINEL),
            "raw runtime content leaked: {diagnostic}"
        );
        assert!(
            !diagnostic.contains(STDERR_SECRET_SENTINEL),
            "raw runtime secret leaked: {diagnostic}"
        );
        assert!(
            !diagnostic.contains(STDERR_URI_SECRET_SENTINEL),
            "URI password leaked: {diagnostic}"
        );
        assert!(
            !diagnostic.contains(STDERR_COMMON_SECRET_SENTINEL),
            "common secret token leaked: {diagnostic}"
        );
        assert!(
            !diagnostic.contains(STDERR_RAW_SECRET_SENTINEL),
            "raw key material leaked: {diagnostic}"
        );
        assert!(
            !diagnostic.contains(STDOUT_CONTENT_SENTINEL),
            "raw runtime stdout must remain contained: {diagnostic}"
        );
    }
}

pub(super) fn timeout_relays_bounded_span_redacted_stderr() {
    let content = "timeout-diagnostic-content-sentinel";
    let secret = "timeout-diagnostic-secret-sentinel";
    let plan = RuntimeLaunchCapturePlan::new(
        HARNESS_RUN_ID,
        RuntimeOperation::Capture,
        RuntimeLaunchCommand::new("sh").arg("-c").arg(format!(
            "printf '%s\\n' 'missing --bridge' >&2\nprintf '%s\\n' 'parser stalled: script={content}; offset=52 api_key={secret}' >&2\nsleep 5"
        )),
    )
    .with_timeout(Duration::from_millis(50))
    .with_shutdown_grace(Duration::from_secs(1))
    .with_poll_interval(Duration::from_millis(5));
    let harness = RuntimeLaunchCaptureHarness::new();
    let mut hooks = RuntimeCaptureHooks::new();

    let error = harness.run(&plan, &mut hooks).unwrap_err();
    let diagnostic = error.to_json().to_string();

    assert_eq!(error.kind, RuntimeHarnessErrorKind::Timeout);
    assert_eq!(detail(&error, "stderrDisposition"), Some("span_redacted"));
    assert_eq!(detail(&error, "stderrReadStatus"), Some("complete"));
    assert!(diagnostic.contains("missing --bridge"));
    assert!(diagnostic.contains("parser stalled"));
    assert!(diagnostic.contains("offset=52"));
    assert!(diagnostic.contains("[REDACTED_CONTENT kind=script"));
    assert!(diagnostic.contains("[REDACTED_SECRET]"));
    assert!(!diagnostic.contains(content));
    assert!(!diagnostic.contains(secret));
}

fn detail<'a>(error: &'a RuntimeHarnessError, key: &str) -> Option<&'a str> {
    error
        .details
        .iter()
        .find_map(|(candidate, value)| (candidate == key).then_some(value.as_str()))
}
