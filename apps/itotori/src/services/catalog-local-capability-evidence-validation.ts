import { CatalogLocalCapabilityEvidenceError } from "./catalog-local-capability-evidence-contract.js";

const forbiddenEvidenceKeys = new Set([
  "filename",
  "fileName",
  "path",
  "pathHash",
  "localId",
  "localScanEntryId",
  "rawText",
  "rawSignal",
  "screenshot",
  "secretKey",
  "keyMaterial",
]);
const forbiddenEvidenceValuePatterns = [
  /(^|[\s"'])\/home\//u,
  /(^|[\s"'])\/scratch\//u,
  /(^|[\s"'])\/mnt\//u,
  /(^|[\s"'])\/Users\//u,
  /(^|[\s"'])\/Volumes\//u,
  /(^|[\s"'])\/private\//u,
  /(^|[\s"'])\/tmp\//u,
  /(^|[\s"'])\/var\//u,
  /(^|[\s"'])~\//u,
  /(^|[\s"'])[A-Za-z]:[\\/]/u,
  /file:/iu,
  /\b[A-Za-z0-9 ._-]+\.(?:json|txt|rpgmvp|rpgmvm|rpgmvo|zip|rar|7z|png|jpe?g|webp)\b/iu,
  /\.rpgmvp\b/iu,
  /\bsecret[_ -]?key\b/iu,
  /\bkeyMaterial\b/u,
  /screenshot/iu,
  /\bsha256:[a-f0-9]{16,}\b/iu,
  /\b[a-f0-9]{64}\b/iu,
  /pathHash/u,
  /localScanEntryId/u,
  /\blocal[-_ ]?scan[-_ ]?(entry[-_ ]?)?id\b/iu,
  /\bscan[-_ ]?id\b/iu,
  /raw\s*text|rawText/iu,
];

export function assertNoForbiddenLocalEvidenceLeakage(
  value: unknown,
  path = "localEngineEvidence",
): void {
  assertNoForbiddenEvidenceLeakage(value, path, "private evidence", "is not aggregate-safe");
}

export function assertNoForbiddenPublicFixtureEvidenceLeakage(
  value: unknown,
  path = "publicFixture",
): void {
  assertNoForbiddenEvidenceLeakage(
    value,
    path,
    "public evidence",
    "is not allowed in public fixture evidence",
  );
}

function assertNoForbiddenEvidenceLeakage(
  value: unknown,
  path: string,
  forbiddenValueDescription: string,
  forbiddenKeyDescription: string,
): void {
  if (typeof value === "string") {
    for (const pattern of forbiddenEvidenceValuePatterns) {
      if (pattern.test(value)) {
        throw new CatalogLocalCapabilityEvidenceError(
          `${path} contains forbidden ${forbiddenValueDescription}`,
        );
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoForbiddenEvidenceLeakage(
        entry,
        `${path}.${index}`,
        forbiddenValueDescription,
        forbiddenKeyDescription,
      ),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (forbiddenEvidenceKeys.has(key)) {
        throw new CatalogLocalCapabilityEvidenceError(`${path}.${key} ${forbiddenKeyDescription}`);
      }
      assertNoForbiddenEvidenceLeakage(
        entry,
        `${path}.${key}`,
        forbiddenValueDescription,
        forbiddenKeyDescription,
      );
    }
  }
}

export function assertPublicStringArray(
  values: unknown,
  field: string,
): asserts values is string[] {
  if (!Array.isArray(values)) {
    throw new CatalogLocalCapabilityEvidenceError(`${field} must be an array`);
  }
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new CatalogLocalCapabilityEvidenceError(`${field}.${index} must be a non-empty string`);
    }
  }
}

export function assertPublicNonEmptyStringArray(
  values: unknown,
  field: string,
): asserts values is string[] {
  assertPublicStringArray(values, field);
  if (values.length === 0) {
    throw new CatalogLocalCapabilityEvidenceError(`${field} must be a non-empty string array`);
  }
}

export function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}
