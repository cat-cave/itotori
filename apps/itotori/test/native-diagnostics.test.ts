import { describe, expect, it } from "vitest";

import {
  NATIVE_CONTENT_REDACTED,
  NATIVE_SECRET_REDACTED,
  nativeFailureDiagnostic,
  redactNativeDiagnostic,
  redactNativeError,
} from "../src/native-bin/native-diagnostics.js";

describe("native operator diagnostics", () => {
  it("redacts JSON content and secret fields while retaining safe context", () => {
    const content = "PRIVATE-CONTENT-SENTINEL";
    const secret = "operator-api-key-sentinel-4e0d4cb3";
    const diagnostic = JSON.stringify({
      code: "kaifuu.decode.failed",
      path: "/synthetic/source",
      offset: 42,
      sourceText: content,
      api_key: secret,
      aws_secret_access_key: "aws-secret-sentinel-4e0d4cb3",
    });

    const redacted = redactNativeDiagnostic(diagnostic, { OPENROUTER_API_KEY: secret });

    expect(redacted).toContain("kaifuu.decode.failed");
    expect(redacted).toContain("/synthetic/source");
    expect(redacted).toContain("42");
    expect(redacted).toContain(NATIVE_CONTENT_REDACTED);
    expect(redacted).toContain(NATIVE_SECRET_REDACTED);
    expect(redacted).not.toContain(content);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain("aws-secret-sentinel-4e0d4cb3");
  });

  it("keeps byte counts and identities while masking a short configured secret", () => {
    const content = "PRIVATE-CONTENT-SENTINEL";
    const diagnostic =
      `kaifuu.decode.failed: source=${content} scene=7 offset=42; ` +
      "bytes=1234; sourceUnitKey=fixture-unit; monkey=banana; detail=z --api-key=flag-secret";

    const redacted = redactNativeDiagnostic(diagnostic, { OPENROUTER_API_KEY: "z" });

    expect(redacted).toContain(NATIVE_CONTENT_REDACTED);
    expect(redacted).toContain("scene=7");
    expect(redacted).toContain("offset=42");
    expect(redacted).toContain("bytes=1234");
    expect(redacted).toContain("sourceUnitKey=fixture-unit");
    expect(redacted).toContain("monkey=banana");
    expect(redacted).not.toContain(content);
    expect(redacted).not.toContain("detail=z");
    expect(redacted).not.toContain("flag-secret");
  });

  it("masks raw key material while retaining a surrounding failure", () => {
    const rawKey = "00112233445566778899aabbccddeeff00112233";
    const diagnostic = `kaifuu.decode.failed: raw key rejected ${rawKey}. offset=42`;

    const redacted = redactNativeDiagnostic(diagnostic);

    expect(redacted).toContain("kaifuu.decode.failed");
    expect(redacted).toContain("offset=42");
    expect(redacted).toContain(NATIVE_SECRET_REDACTED);
    expect(redacted).not.toContain(rawKey);
  });

  it("redacts an unterminated content quote and preserves an existing content summary", () => {
    const unclosedContent = "PRIVATE-UNCLOSED-CONTENT";
    const nativeSummary =
      "[REDACTED_CONTENT kind=sourceText byte_len=17 sha256=00000000000000000000000000000000]";

    const unclosed = redactNativeDiagnostic(
      `kaifuu.decode.failed: sourceText=\"${unclosedContent}`,
    );
    const relayed = redactNativeDiagnostic(
      `kaifuu.decode.failed: sourceText=${nativeSummary}; status=1`,
    );

    expect(unclosed).toContain(NATIVE_CONTENT_REDACTED);
    expect(unclosed).not.toContain(unclosedContent);
    expect(relayed).toContain(nativeSummary);
    expect(relayed).toContain("status=1");
  });

  it("passes unlabelled failing output channels through by default", () => {
    const payload = "unlabelled native decoder failure";
    const stdoutDiagnostic = nativeFailureDiagnostic({
      error: undefined,
      stderr: "",
      stdout: payload,
    });
    const stderrDiagnostic = nativeFailureDiagnostic({
      error: undefined,
      stderr: payload,
      stdout: "",
    });

    expect(stdoutDiagnostic).toBe(payload);
    expect(stderrDiagnostic).toBe(payload);
  });

  it("passes the native missing-archive diagnostic through to the operator", () => {
    const missingArchive =
      "REALLIVEDATA/Seen.txt not found under /synthetic/owned-source-root-00; " +
      "pass --game-root pointing at a RealLive game root";

    const diagnostic = nativeFailureDiagnostic({
      error: undefined,
      stderr: missingArchive,
      stdout: "",
    });

    expect(diagnostic).toBe(missingArchive);
  });

  it("passes the native missing-bridge diagnostic through to the operator", () => {
    const diagnostic = nativeFailureDiagnostic({
      error: undefined,
      stderr: "missing --bridge",
      stdout: "",
    });

    expect(diagnostic).toBe("missing --bridge");
  });

  it("summarizes content spans across delimiters while retaining nearby metadata", () => {
    const firstContent = "PRIVATE-FIRST-CONTENT-SENTINEL";
    const secondContent = "PRIVATE-SECOND-CONTENT-SENTINEL";
    const diagnostic = nativeFailureDiagnostic({
      error: undefined,
      stderr:
        `kaifuu.decode.failed: bytes=88 source=${firstContent}; ${secondContent}; ` +
        "path=/synthetic/source offset=42",
      stdout: "",
    });

    expect(diagnostic).toContain("kaifuu.decode.failed");
    expect(diagnostic).toContain("bytes=88");
    expect(diagnostic).toContain("path=/synthetic/source");
    expect(diagnostic).toContain("offset=42");
    expect(diagnostic).toContain(NATIVE_CONTENT_REDACTED);
    expect(diagnostic).not.toContain(firstContent);
    expect(diagnostic).not.toContain(secondContent);
  });

  it("keeps a diagnostic around a labelled script span", () => {
    const script = "*entry\n@wait 10\nmessage synthetic-script-text";
    const diagnostic = nativeFailureDiagnostic({
      error: undefined,
      stderr: `native parser failed: script=${JSON.stringify(script)}; line=2 offset=17`,
      stdout: "",
    });

    expect(diagnostic).toContain("native parser failed");
    expect(diagnostic).toContain("line=2");
    expect(diagnostic).toContain("offset=17");
    expect(diagnostic).toContain(NATIVE_CONTENT_REDACTED);
    expect(diagnostic).not.toContain(script);
  });

  it("does not mistake a one-component source value for a filesystem path", () => {
    const source = "/PRIVATE-PATH-SHAPED-CONTENT-SENTINEL";
    const diagnostic = redactNativeDiagnostic(`kaifuu.decode.failed: source=${source} offset=42`);

    expect(diagnostic).toContain("offset=42");
    expect(diagnostic).toContain(NATIVE_CONTENT_REDACTED);
    expect(diagnostic).not.toContain(source);
  });

  it("redacts secrets in flags, headers, URLs, tokens, and key material", () => {
    const privateKey = "private-key-sentinel";
    const headerCredential = "header-credential-sentinel";
    const xAuth = "x-auth-sentinel";
    const urlPassword = "url-password-sentinel";
    const bearer = "bearer-token-sentinel";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.signature-sentinel";
    const pem = [
      "-----BEGIN",
      " PRIVATE KEY-----\nPRIVATE-PEM-SENTINEL\n-----END",
      " PRIVATE KEY-----",
    ].join("");
    const rawKey = "00112233445566778899aabbccddeeff00112233";
    const diagnostic = nativeFailureDiagnostic({
      error: undefined,
      stderr:
        `kaifuu.auth.failed: --private-key ${privateKey}; ` +
        `Proxy-Authorization: Basic ${headerCredential}; X-Auth=${xAuth}; ` +
        `endpoint=https://operator:${urlPassword}@example.invalid/run; Bearer ${bearer}; ` +
        `${jwt}; ${pem}; ${rawKey}, status=1`,
      stdout: "",
    });

    expect(diagnostic).toContain("kaifuu.auth.failed");
    expect(diagnostic).toContain("status=1");
    expect(diagnostic).toContain(NATIVE_SECRET_REDACTED);
    for (const secret of [
      privateKey,
      headerCredential,
      xAuth,
      urlPassword,
      bearer,
      jwt,
      pem,
      rawKey,
    ]) {
      expect(diagnostic).not.toContain(secret);
    }
  });

  it("passes unlabelled caught errors through by default", () => {
    const content = "unlabelled native process error";
    const diagnostic = redactNativeError(new Error(content));

    expect(diagnostic).toBe(content);
  });

  it("keeps a safe diagnostic already wrapped by the extraction seam", () => {
    const content = "PRIVATE-WRAPPED-ERROR-CONTENT-SENTINEL";
    const diagnostic = redactNativeError(
      new Error(
        "kaifuu extract (reallive) failed with status 4: " +
          `kaifuu.reallive.decode_failed: scene=7 offset=42 source=${content}`,
      ),
    );

    expect(diagnostic).toContain("kaifuu extract (reallive) failed with status 4");
    expect(diagnostic).toContain("kaifuu.reallive.decode_failed");
    expect(diagnostic).toContain("scene=7");
    expect(diagnostic).toContain("offset=42");
    expect(diagnostic).toContain(NATIVE_CONTENT_REDACTED);
    expect(diagnostic).not.toContain(content);
  });

  it("keeps a safe structure diagnostic already wrapped by its native seam", () => {
    const content = "PRIVATE-STRUCTURE-WRAPPED-CONTENT-SENTINEL";
    const diagnostic = redactNativeError(
      new Error(
        "utsushi structure failed with status 9: " +
          `utsushi.structure.decode_failed: scene=7 offset=42 source=${content}`,
      ),
    );

    expect(diagnostic).toContain("utsushi structure failed with status 9");
    expect(diagnostic).toContain("utsushi.structure.decode_failed");
    expect(diagnostic).toContain("scene=7");
    expect(diagnostic).toContain("offset=42");
    expect(diagnostic).toContain(NATIVE_CONTENT_REDACTED);
    expect(diagnostic).not.toContain(content);
  });

  it("keeps a known Node spawn error inside a native seam wrapper", () => {
    const diagnostic = redactNativeError(
      new Error(
        "kaifuu extract (reallive) could not be spawned (/operator/bin): " +
          "spawnSync /operator/bin ENOENT",
      ),
    );

    expect(diagnostic).toContain("could not be spawned");
    expect(diagnostic).toContain("spawnSync /operator/bin ENOENT");
  });

  it("keeps compiler diagnostics that identify a concrete native build failure", () => {
    const diagnostic = nativeFailureDiagnostic({
      error: undefined,
      stderr: "error[E0433]: failed to resolve: use of unresolved module",
      stdout: "",
    });

    expect(diagnostic).toContain("error[E0433]");
    expect(diagnostic).toContain("unresolved module");
  });

  it("keeps a bare native semantic error code", () => {
    const code = "kaifuu.reallive.patchback_target_nonempty";
    const diagnostic = nativeFailureDiagnostic({ error: undefined, stderr: code, stdout: "" });

    expect(diagnostic).toBe(code);
  });
});
