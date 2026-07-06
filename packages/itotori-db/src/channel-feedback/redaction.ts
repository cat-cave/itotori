// ITOTORI-037 — PII redaction for community-channel feedback imports.
//
// External community channels (GitHub issues, forms, chat exports) carry
// free-text authored by the public. That text can contain privacy-sensitive
// values (email addresses, phone numbers) that the manual-feedback path would
// never persist raw. Every channel importer runs its inbound content through
// this redactor BEFORE mapping it into a `ManualFeedbackImportInput`, so raw
// PII never reaches the feedback model.
//
// The redactor is deterministic and content-only: the same input always yields
// the same output, it records WHICH kinds were redacted and HOW MANY (never the
// raw values), and it reports whether any redaction occurred so the importer can
// stamp the report's `redactionState`.

/** PII kinds this redactor recognizes in free-text channel content. */
export const CHANNEL_PII_KINDS = ["email", "phone"] as const;
export type ChannelPiiKind = (typeof CHANNEL_PII_KINDS)[number];

/** A single redaction class applied to a piece of content. */
export type ChannelRedaction = {
  kind: ChannelPiiKind;
  /** Number of occurrences replaced. */
  count: number;
  /** The placeholder token substituted for each occurrence. */
  placeholder: string;
};

export type ChannelRedactionResult = {
  /** The content with every recognized PII occurrence replaced. */
  text: string;
  /** Per-kind redaction records (only kinds with count > 0 are present). */
  redactions: ChannelRedaction[];
  /** True when any PII was redacted. */
  redacted: boolean;
};

const EMAIL_PLACEHOLDER = "[redacted-email]";
const PHONE_PLACEHOLDER = "[redacted-phone]";

// Emails: a conservative RFC-ish local@domain.tld shape.
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Phone numbers: intentionally conservative — an international number with a
// leading `+` country code and at least seven digits' worth of grouped digits.
// Requiring the `+` prefix avoids matching dates, issue numbers, and ordinary
// integers that are not phone numbers.
const PHONE_PATTERN = /\+\d[\d\s().-]{6,}\d/g;

/** Count non-overlapping matches of `pattern` (which MUST be a global regex). */
function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches === null ? 0 : matches.length;
}

/**
 * Redact recognized PII from free-text channel content. Emails are redacted
 * first so an email's local part is never mistaken for a phone number, then
 * phone numbers are redacted from the already-email-safe text.
 */
export function redactChannelPii(rawText: string): ChannelRedactionResult {
  const redactions: ChannelRedaction[] = [];

  const emailCount = countMatches(rawText, EMAIL_PATTERN);
  let text = rawText.replace(EMAIL_PATTERN, EMAIL_PLACEHOLDER);
  if (emailCount > 0) {
    redactions.push({ kind: "email", count: emailCount, placeholder: EMAIL_PLACEHOLDER });
  }

  const phoneCount = countMatches(text, PHONE_PATTERN);
  text = text.replace(PHONE_PATTERN, PHONE_PLACEHOLDER);
  if (phoneCount > 0) {
    redactions.push({ kind: "phone", count: phoneCount, placeholder: PHONE_PLACEHOLDER });
  }

  return {
    text,
    redactions,
    redacted: redactions.length > 0,
  };
}

/** True when a string looks like a bare PII value (used to reject raw contact fields). */
export function isLikelyPiiValue(value: string): boolean {
  return (
    new RegExp(EMAIL_PATTERN.source).test(value) || new RegExp(PHONE_PATTERN.source).test(value)
  );
}
