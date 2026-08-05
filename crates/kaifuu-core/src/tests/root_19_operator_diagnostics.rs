#[test]
fn operator_diagnostic_redacts_content_span_but_keeps_triage_context() {
    let content = "operator-content-span-sentinel";
    let diagnostic = format!(
        "kaifuu.decode.failed: source: {content}; scene=42 offset=128 bytes=1234 kind=dialogue path=/operator/input"
    );

    let redacted = redact_diagnostic_for_operator(&diagnostic);

    assert!(!redacted.contains(content), "content leaked: {redacted}");
    for expected in [
        "kaifuu.decode.failed",
        "scene=42",
        "offset=128",
        "bytes=1234",
        "kind=dialogue",
        "path=/operator/input",
        "kind=source",
        "byte_len=30",
        "sha256=",
    ] {
        assert!(
            redacted.contains(expected),
            "missing {expected}: {redacted}"
        );
    }
}

#[test]
fn operator_diagnostic_redacts_nonnumeric_bytes_value() {
    let payload = "operator-byte-payload-sentinel";
    let diagnostic = format!("kaifuu.decode.failed: bytes={payload}; offset=128");

    let redacted = redact_diagnostic_for_operator(&diagnostic);

    assert!(!redacted.contains(payload), "payload leaked: {redacted}");
    for expected in ["kind=bytes", "byte_len=30", "offset=128"] {
        assert!(
            redacted.contains(expected),
            "missing {expected}: {redacted}"
        );
    }
}

#[test]
fn operator_diagnostic_redacts_extended_content_fields_and_continuations() {
    let detail = "detail-payload-sentinel";
    let detail_tail = "detail-tail-sentinel";
    let message = "message-payload-sentinel";
    let message_tail = "message-tail-sentinel";
    let reason = "reason-payload-sentinel";
    let reason_tail = "reason-tail-sentinel";
    let password = "password-payload-sentinel";
    let password_tail = "password-tail-sentinel";
    let diagnostic = format!(
        "kaifuu.decode.failed: detail={detail}; {detail_tail}; scene=42 message={message} -- {message_tail}; offset=128 reason={reason}\n{reason_tail}\nstatus=7 password={password}; {password_tail}; path=/operator/input"
    );

    let redacted = redact_diagnostic_for_operator(&diagnostic);

    for leaked in [
        detail,
        detail_tail,
        message,
        message_tail,
        reason,
        reason_tail,
        password,
        password_tail,
    ] {
        assert!(!redacted.contains(leaked), "payload leaked: {redacted}");
    }
    for expected in ["scene=42", "offset=128", "status=7", "path=/operator/input"] {
        assert!(
            redacted.contains(expected),
            "missing {expected}: {redacted}"
        );
    }
}

#[test]
fn operator_diagnostic_masks_common_secret_forms_without_hiding_context() {
    let raw_key = "00112233445566778899aabbccddeeff00112233";
    let second_raw_key = "aabbccddeeff00112233445566778899aabbccdd";
    let bearer = "bearer-payload-sentinel";
    let common_token = "sk-operator-common-token";
    let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.signature";
    let uri_password = "uri-password-sentinel";
    let private_key_body = "private-key-body-sentinel";
    let authorization = "authorization-payload-sentinel";
    let private_key =
        format!("-----BEGIN PRIVATE KEY-----\n{private_key_body}\n-----END PRIVATE KEY-----");
    let diagnostic = format!(
        "kaifuu.transport.failed: fingerprint={raw_key}, secondary={second_raw_key}; Bearer {bearer} common={common_token} jwt={jwt} uri=postgres://operator:{uri_password}@db.example.test/input {private_key} proxy_authorization={authorization}; status=1"
    );

    let redacted = redact_diagnostic_for_operator(&diagnostic);

    for leaked in [
        raw_key,
        second_raw_key,
        bearer,
        common_token,
        jwt,
        uri_password,
        private_key_body,
        authorization,
    ] {
        assert!(!redacted.contains(leaked), "secret leaked: {redacted}");
    }
    assert!(redacted.contains("status=1"), "missing context: {redacted}");
    assert!(redacted.contains(SEMANTIC_SECRET_REDACTED));
}

#[test]
fn operator_diagnostic_summarizes_unstructured_terminal_text() {
    let payload = "unstructured-terminal-payload-sentinel";
    let diagnostic = format!("kaifuu.decode.failed: {payload}");

    let redacted = redact_diagnostic_for_operator(&diagnostic);

    assert!(!redacted.contains(payload), "payload leaked: {redacted}");
    assert!(redacted.contains("kind=diagnostic"));
}

#[test]
fn operator_diagnostic_summarizes_unstructured_text_after_secret_masking() {
    let payload = "unstructured-terminal-payload-with-secret-sentinel";
    let secret = "secret-value-sentinel";
    let diagnostic = format!("kaifuu.decode.failed: {payload} api_key={secret}");

    let redacted = redact_diagnostic_for_operator(&diagnostic);

    assert!(!redacted.contains(payload), "payload leaked: {redacted}");
    assert!(!redacted.contains(secret), "secret leaked: {redacted}");
    assert!(redacted.contains("kind=diagnostic"));
}

#[test]
fn operator_diagnostic_keeps_path_shaped_source_value() {
    let diagnostic = "kaifuu.decode.failed: source=/operator/input; scene=42 offset=128";

    assert_eq!(redact_diagnostic_for_operator(diagnostic), diagnostic);
}

#[test]
fn operator_diagnostic_redacts_relative_source_text() {
    let payload = "/PRIVATE-PATH-SHAPED-CONTENT";
    let diagnostic = format!("kaifuu.decode.failed: source={payload}; scene=42 offset=128");

    let redacted = redact_diagnostic_for_operator(&diagnostic);

    assert!(!redacted.contains(payload), "payload leaked: {redacted}");
    assert!(redacted.contains("scene=42"));
    assert!(redacted.contains("offset=128"));
}

#[test]
fn operator_diagnostic_masks_secrets_without_hiding_path_or_flag() {
    let secret = "operator-secret-value";
    let flag_secret = "operator-flag-secret-value";
    let equals_secret = "operator-equals-secret-value";
    let raw_key = "00112233445566778899aabbccddeeff00112233";
    let database_url = "postgres://operator:secret-value@db.example.test/input";
    let diagnostic = format!(
        "kaifuu.transport.failed: api_key={secret}; --api-key {flag_secret} --api-key={equals_secret}; details={raw_key}. DATABASE_URL={database_url}; status=1 path=/operator/input --game-version"
    );

    let redacted = redact_diagnostic_for_operator(&diagnostic);

    for leaked in [secret, flag_secret, equals_secret, raw_key, database_url] {
        assert!(!redacted.contains(leaked), "secret leaked: {redacted}");
    }
    for expected in [
        "kaifuu.transport.failed",
        "status=1",
        "path=/operator/input",
        "--game-version",
        SEMANTIC_SECRET_REDACTED,
    ] {
        assert!(
            redacted.contains(expected),
            "missing {expected}: {redacted}"
        );
    }
}

#[test]
fn operator_diagnostic_preserves_missing_metadata_remediation() {
    let diagnostic = "missing bridge metadata flag --game-version; pass --game-id, --game-version, --source-profile-id, and --source-locale";

    assert_eq!(redact_diagnostic_for_operator(diagnostic), diagnostic);
}

#[test]
fn operator_diagnostic_preserves_safe_semantic_and_path_diagnostics() {
    for diagnostic in [
        "kaifuu.key_validation_failed",
        "output directory must not be a symlink: /operator/output",
        "contract scaffold drift: extract:kaifuu.unsupported_variant.encrypted",
        "kaifuu.delta.partial_source_refused: delta package fixture-id carries sourceProvenance.partial=true",
        "/operator/input",
    ] {
        assert_eq!(redact_diagnostic_for_operator(diagnostic), diagnostic);
    }
    let unsafe_path = "/operator/input?payload-sentinel";
    let redacted = redact_diagnostic_for_operator(unsafe_path);
    assert!(
        !redacted.contains("payload-sentinel"),
        "path leaked: {redacted}"
    );
}

#[test]
fn operator_terminal_redaction_does_not_relax_shared_report_redaction() {
    let diagnostic = "kaifuu.decode.failed: path=/operator/private-input";

    assert_eq!(redact_diagnostic_for_operator(diagnostic), diagnostic);
    assert_eq!(
        redact_for_log_or_report(diagnostic),
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")
    );
}
