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

// International phone: a leading `+` country code followed by grouped digits.
// The `+` prefix makes this unambiguous, so it can be matched directly.
const INTERNATIONAL_PHONE_PATTERN = /\+\d[\d\s().-]{6,}\d/g;

// Domestic phone (no country code): two or more digit groups joined by phone
// separators (space or dash) or a parenthesized area code, e.g. `090-1234-5678`,
// `(415) 555-0198`, `03-1234-5678`. A grouped-digit run without a `+` is
// ambiguous, so a raw regex match is only a CANDIDATE; `isDomesticPhone`
// validates it by total digit count and group structure before redaction. Dots
// are deliberately NOT separators here so IP addresses, version numbers, and
// dotted prices are never mistaken for phones.
const DOMESTIC_PHONE_CANDIDATE = /\(?\d{2,4}\)?[\s-]\d{2,4}(?:[\s-]\d{2,4})*/g;
// Real domestic phone numbers carry 9–11 significant digits (e.g. Japanese
// landline `03-1234-5678` = 9, US `(415) 555-0198` = 10, Japanese mobile
// `090-1234-5678` = 11). The floor rejects dates/short ids; the ceiling rejects
// long numeric hashes/account numbers.
const DOMESTIC_PHONE_MIN_DIGITS = 9;
const DOMESTIC_PHONE_MAX_DIGITS = 11;
const DOMESTIC_PHONE_SEPARATORS = /[\s()-]+/;

/** Count non-overlapping matches of `pattern` (which MUST be a global regex). */
function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches === null ? 0 : matches.length;
}

/**
 * True when a {@link DOMESTIC_PHONE_CANDIDATE} match is really a phone number
 * rather than a coincidental run of separated digits (an issue id, year, price,
 * version, date, or hash). A candidate qualifies only when it carries 9–11
 * total digits AND either three-plus digit groups or a parenthesized area code
 * — the shape of a real dialable number, which years (`2026`), issue ids
 * (`#12345`), versions (`1.2.3`), ISO dates (`2026-06-21` = 8 digits), and
 * prices never all satisfy at once.
 */
function isDomesticPhone(candidate: string): boolean {
  const digitCount = candidate.replace(/\D/g, "").length;
  if (digitCount < DOMESTIC_PHONE_MIN_DIGITS || digitCount > DOMESTIC_PHONE_MAX_DIGITS) {
    return false;
  }
  const groups = candidate.split(DOMESTIC_PHONE_SEPARATORS).filter((group) => group.length > 0);
  const hasParenthesizedGroup = candidate.includes("(");
  return groups.length >= 3 || hasParenthesizedGroup;
}

/**
 * Redact recognized PII from free-text channel content. Emails are redacted
 * first so an email's local part is never mistaken for a phone number, then
 * international (`+`-prefixed) and domestic phone numbers are redacted from the
 * already-email-safe text. Both phone forms record under the single `phone`
 * kind with a combined occurrence count.
 */
export function redactChannelPii(rawText: string): ChannelRedactionResult {
  const redactions: ChannelRedaction[] = [];

  const emailCount = countMatches(rawText, EMAIL_PATTERN);
  let text = rawText.replace(EMAIL_PATTERN, EMAIL_PLACEHOLDER);
  if (emailCount > 0) {
    redactions.push({ kind: "email", count: emailCount, placeholder: EMAIL_PLACEHOLDER });
  }

  let phoneCount = 0;
  text = text.replace(INTERNATIONAL_PHONE_PATTERN, () => {
    phoneCount += 1;
    return PHONE_PLACEHOLDER;
  });
  text = text.replace(DOMESTIC_PHONE_CANDIDATE, (match) => {
    if (!isDomesticPhone(match)) {
      return match;
    }
    phoneCount += 1;
    return PHONE_PLACEHOLDER;
  });
  if (phoneCount > 0) {
    redactions.push({ kind: "phone", count: phoneCount, placeholder: PHONE_PLACEHOLDER });
  }

  return {
    text,
    redactions,
    redacted: redactions.length > 0,
  };
}
