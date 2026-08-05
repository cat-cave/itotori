// Display-safe native-tool diagnostics.
//
// Native stdout/stderr remain raw at process boundaries because some callers
// parse them as a protocol. This module is only for operator-facing errors:
// retain actionable diagnostics while removing labelled content and secrets.

import { createHash } from "node:crypto";

import { LIVE_PROVIDER_SECRET_VARS } from "../env/live-provider-secret-vars.js";

export const NATIVE_CONTENT_REDACTED = "[REDACTED_CONTENT";
export const NATIVE_SECRET_REDACTED = "[REDACTED_SECRET]";

type NativeDiagnosticResult = {
  error?: Error | undefined;
  stdout: string;
  stderr: string;
};

const CONTENT_FIELD_NAMES = new Set(
  [
    "body bytes content data decodedtext detail dialogue dialoguetext excerpt message output payload",
    "plaintext raw rawbytes rawtext reason script source sourcetext stderr stdout snippet targettext text value",
  ]
    .join(" ")
    .split(" "),
);

const SAFE_METADATA_FIELD_NAMES = new Set(
  [
    "actual bytelen bytes code column end expected flag index kind len length line offset",
    "path scene sourceunitkey start status unit",
  ]
    .join(" ")
    .split(" "),
);

const ASSIGNMENT =
  /(?<![A-Za-z0-9_-])(?:"([A-Za-z][A-Za-z0-9_-]*)"|([A-Za-z][A-Za-z0-9_-]*))\s*([=:])/gu;
const BEARER_TOKEN = /\b(Bearer\s+)([^\s,;]+)/giu;
const COMMON_SECRET_TOKEN =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16})\b/gu;
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/gu;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu;
const SENSITIVE_FLAG_VALUE =
  /(--(?:access[-_]?key|api[-_]?key|auth(?:orization)?|connection[-_]?string|credential|database[-_]?url|dsn|password|private[-_]?key|proxy[-_]?authorization|secret|token|x[-_]?auth)(?:\s+|=))(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/giu;
const URI_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@/\s]+)(@)/giu;

/**
 * Return diagnostic text fit for an operator terminal. Safe labels, paths,
 * offsets, statuses, and flags remain readable. Content-bearing labelled spans
 * become a one-way size/hash summary; secret values are never summarized.
 */
export function redactNativeDiagnostic(
  diagnostic: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return redactContentSpans(redactSecrets(diagnostic, env));
}

/**
 * Choose the native failure detail without hiding an entire output channel.
 * Every failure channel is diagnostic text by default; content and secrets are
 * reduced only when the span itself identifies them. Mixed output identifies
 * each retained channel for the operator.
 */
export function nativeFailureDiagnostic(
  result: NativeDiagnosticResult,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const spawnError = result.error?.message.trim() ?? "";
  const channels: Array<{ label: string; value: string }> = [];
  if (stderr.length > 0) channels.push({ label: "stderr", value: stderr });
  if (stdout.length > 0) channels.push({ label: "stdout", value: stdout });
  if (spawnError.length > 0) channels.push({ label: "spawn", value: spawnError });

  if (channels.length === 0) return "native tool produced no diagnostic output";
  if (channels.length === 1) {
    const channel = channels[0]!;
    return redactNativeDiagnostic(channel.value, env);
  }
  return channels
    .map(({ label, value }) => `${label}: ${redactNativeDiagnostic(value, env)}`)
    .join("\n");
}

/** Convert a caught native failure into display-safe text without retaining a raw cause. */
export function redactNativeError(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactNativeDiagnostic(message, env);
}

function redactSecrets(diagnostic: string, env: NodeJS.ProcessEnv): string {
  let redacted = diagnostic.replace(PRIVATE_KEY_BLOCK, NATIVE_SECRET_REDACTED);
  for (const variable of LIVE_PROVIDER_SECRET_VARS) {
    const value = env[variable];
    if (value !== undefined && value.length > 0) {
      redacted = redacted.split(value).join(NATIVE_SECRET_REDACTED);
    }
  }
  redacted = redacted.replace(URI_PASSWORD, `$1${NATIVE_SECRET_REDACTED}$3`);
  redacted = redactSecretAssignments(redacted).replace(
    SENSITIVE_FLAG_VALUE,
    `$1${NATIVE_SECRET_REDACTED}`,
  );
  return redactRawKeyTokens(
    redacted
      .replace(BEARER_TOKEN, `$1${NATIVE_SECRET_REDACTED}`)
      .replace(COMMON_SECRET_TOKEN, NATIVE_SECRET_REDACTED)
      .replace(JWT_TOKEN, NATIVE_SECRET_REDACTED),
  );
}

function redactSecretAssignments(diagnostic: string): string {
  let output = "";
  let cursor = 0;
  for (const match of diagnostic.matchAll(ASSIGNMENT)) {
    const field = match[1] ?? match[2]!;
    if (!isSecretField(field)) continue;
    const assignmentEnd = match.index! + match[0].length;
    const value = diagnosticValue(diagnostic, assignmentEnd);
    output += diagnostic.slice(cursor, assignmentEnd + value.leadingWhitespace);
    output += NATIVE_SECRET_REDACTED;
    cursor = value.end;
  }
  return output.length === 0 ? diagnostic : output + diagnostic.slice(cursor);
}

function redactRawKeyTokens(diagnostic: string): string {
  let previousToken = "";
  return diagnostic
    .split(/([\s,;]+)/u)
    .map((token) => {
      if (/^\s*$/u.test(token)) return token;
      const redacted = previousToken === "sha256" ? token : redactRawKeyToken(token);
      previousToken = trimTokenPunctuation(token).toLowerCase();
      return redacted;
    })
    .join("");
}

function redactRawKeyToken(token: string): string {
  const candidate = trimTokenPunctuation(token);
  if (looksLikeRawKeyMaterial(candidate)) return token.replace(candidate, NATIVE_SECRET_REDACTED);
  const separator = token.search(/[=:]/u);
  if (separator < 0) return token;
  if (trimTokenPunctuation(token.slice(0, separator)).toLowerCase() === "sha256") return token;
  const value = trimTokenPunctuation(token.slice(separator + 1));
  return looksLikeRawKeyMaterial(value) ? token.replace(value, NATIVE_SECRET_REDACTED) : token;
}

function trimTokenPunctuation(token: string): string {
  return token.replace(/^["'`,;:.!?()\[\]{}]+|["'`,;:.!?()\[\]{}]+$/gu, "");
}

function looksLikeRawKeyMaterial(value: string): boolean {
  if (isSha256Reference(value) || isUuidLike(value)) return false;
  const hex = value.replaceAll(/[\s:-]/gu, "");
  if (hex.length >= 32 && hex.length % 2 === 0 && /^[A-Fa-f0-9]+$/u.test(hex)) return true;

  const encoded = value.replaceAll(/\s/gu, "");
  return looksLikeEncodedKey(encoded) && tokenEntropy(encoded) >= 4;
}

function isSha256Reference(value: string): boolean {
  return /^sha256:[A-Fa-f0-9]{64}$/u.test(value);
}

function isUuidLike(value: string): boolean {
  return /^[A-Fa-f0-9]{8}-(?:[A-Fa-f0-9]{4}-){3}[A-Fa-f0-9]{12}$/u.test(value);
}

function looksLikeEncodedKey(value: string): boolean {
  return (
    value.length >= 22 &&
    ((/^[A-Za-z0-9+/]+={0,2}$/u.test(value) && /[+/=]/u.test(value) && value.length % 4 === 0) ||
      (/^[A-Za-z0-9_-]+$/u.test(value) && /[_-]/u.test(value)))
  );
}

function tokenEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function redactContentSpans(diagnostic: string): string {
  let output = "";
  let cursor = 0;
  for (const match of diagnostic.matchAll(ASSIGNMENT)) {
    const field = match[1] ?? match[2]!;
    const normalized = normalizeFieldName(field);
    if (!CONTENT_FIELD_NAMES.has(normalized)) continue;
    const assignmentEnd = match.index! + match[0].length;
    const value = diagnosticValue(diagnostic, assignmentEnd);
    if (
      value.text.length === 0 ||
      (normalized === "source" && looksLikePath(value.text)) ||
      (normalized === "bytes" && isByteCount(value.text)) ||
      isContentSummary(value.text)
    ) {
      continue;
    }
    output += diagnostic.slice(cursor, assignmentEnd + value.leadingWhitespace);
    output += contentSummary(field, value.text);
    cursor = value.end;
  }
  return output.length === 0 ? diagnostic : output + diagnostic.slice(cursor);
}

function diagnosticValue(
  diagnostic: string,
  start: number,
): { end: number; leadingWhitespace: number; text: string } {
  const rest = diagnostic.slice(start);
  const leadingWhitespace = rest.match(/^\s*/u)?.[0].length ?? 0;
  const valueStart = start + leadingWhitespace;
  if (diagnostic.startsWith(NATIVE_CONTENT_REDACTED, valueStart)) {
    const markerEnd = diagnostic.indexOf("]", valueStart);
    if (markerEnd >= 0) {
      return {
        end: markerEnd + 1,
        leadingWhitespace,
        text: diagnostic.slice(valueStart, markerEnd + 1),
      };
    }
  }
  const quote = diagnostic[valueStart];
  if (quote === '"' || quote === "'") {
    const quotedEnd = quotedValueEnd(diagnostic, valueStart, quote);
    if (quotedEnd === undefined) {
      return {
        end: diagnostic.length,
        leadingWhitespace,
        text: diagnostic.slice(valueStart + 1),
      };
    }
    const end = unquotedValueEnd(diagnostic, quotedEnd);
    return {
      end,
      leadingWhitespace,
      text: diagnostic.slice(valueStart + 1, end === quotedEnd ? quotedEnd - 1 : end),
    };
  }

  const end = unquotedValueEnd(diagnostic, valueStart);
  const valueEnd = diagnostic.slice(valueStart, end).trimEnd().length + valueStart;
  return { end: valueEnd, leadingWhitespace, text: diagnostic.slice(valueStart, valueEnd) };
}

function unquotedValueEnd(diagnostic: string, valueStart: number): number {
  let end = valueStart;
  while (end < diagnostic.length) {
    if (diagnostic[end] === ";" && boundaryFollows(diagnostic, end + 1)) {
      break;
    }
    if (
      (diagnostic[end] === "\n" || diagnostic[end] === "\r") &&
      boundaryFollows(diagnostic, end + 1)
    ) {
      break;
    }
    if (diagnostic[end] === "," && metadataFollows(diagnostic, end + 1)) break;
    if (/\s/u.test(diagnostic[end]!) && metadataFollows(diagnostic, end)) break;
    end += 1;
  }
  return end;
}

function quotedValueEnd(diagnostic: string, start: number, quote: string): number | undefined {
  let escaped = false;
  for (let index = start + 1; index < diagnostic.length; index += 1) {
    const character = diagnostic[index]!;
    if (!escaped && character === quote) return index + 1;
    escaped = !escaped && character === "\\";
    if (character !== "\\") escaped = false;
  }
  return undefined;
}

function metadataFollows(diagnostic: string, start: number): boolean {
  const match = /^\s*(?:"([A-Za-z][A-Za-z0-9_-]*)"|([A-Za-z][A-Za-z0-9_-]*))\s*[=:]/u.exec(
    diagnostic.slice(start),
  );
  if (match === null) return false;
  const field = match[1] ?? match[2]!;
  const normalized = normalizeFieldName(field);
  return (
    SAFE_METADATA_FIELD_NAMES.has(normalized) ||
    CONTENT_FIELD_NAMES.has(normalized) ||
    isSecretField(field)
  );
}

const boundaryFollows = (diagnostic: string, start: number): boolean =>
  metadataFollows(diagnostic, start) ||
  /^\s*(?:pass|use|provide|supply|set|include)\s+--[A-Za-z][A-Za-z0-9-]*/iu.test(
    diagnostic.slice(start),
  );

function looksLikePath(value: string): boolean {
  return /^(?:\/(?:[^/\\\s]+\/){1,}[^/\\\s]+|[A-Za-z]:[\\/](?:[^\\/\s]+[\\/]){1,}[^\\/\s]+|(?:\.{1,2}|~|\$[A-Za-z_][A-Za-z0-9_]*)[\\/](?:[^\\/\s]+[\\/]){1,}[^\\/\s]+)$/u.test(
    value,
  );
}

function contentSummary(kind: string, text: string): string {
  const byteLength = Buffer.byteLength(text, "utf8");
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  return `${NATIVE_CONTENT_REDACTED} kind=${normalizeFieldName(kind)} ${byteLength} bytes (sha256 ${sha256})]`;
}

function isContentSummary(text: string): boolean {
  return text.startsWith(NATIVE_CONTENT_REDACTED) && text.endsWith("]");
}

function isByteCount(text: string): boolean {
  return /^\d+$/u.test(text);
}

function isSecretField(field: string): boolean {
  const normalized = normalizeFieldName(field);
  return (
    normalized === "auth" ||
    normalized === "xauth" ||
    normalized === "authorization" ||
    normalized === "connectionstring" ||
    normalized === "cookie" ||
    normalized === "databaseurl" ||
    normalized === "dsn" ||
    normalized === "key" ||
    normalized === "password" ||
    normalized === "secret" ||
    normalized === "token" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("auth") ||
    normalized.endsWith("authorization") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials") ||
    normalized.endsWith("cookie") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token") ||
    [
      "accesskey",
      "authkey",
      "clientkey",
      "decryptionkey",
      "encryptionkey",
      "privatekey",
      "providerkey",
      "secretkey",
      "signingkey",
    ].some((suffix) => normalized.endsWith(suffix))
  );
}

function normalizeFieldName(field: string): string {
  return field.replaceAll(/[_-]/gu, "").toLowerCase();
}
