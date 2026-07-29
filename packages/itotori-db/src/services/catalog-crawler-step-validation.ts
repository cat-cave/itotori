import {
  type CatalogCrawlerAdapterStep,
  type CatalogCrawlerRateLimitMetadata,
} from "./catalog-crawler-contract-types.js";

export function validateRecordedCatalogCrawlerStep<TFact>(
  step: CatalogCrawlerAdapterStep<TFact>,
  label: string,
): void {
  if (step === null || typeof step !== "object") {
    throw new Error(`${label} must be a JSON object`);
  }
  requiredFixtureString(step.stepKey, `${label}.stepKey`);
  requiredFixtureString(step.sourceId, `${label}.sourceId`);
  requiredFixtureString(step.requestIdentity, `${label}.requestIdentity`);
  const fetchedAt = step.fetchedAt instanceof Date ? step.fetchedAt : new Date(step.fetchedAt);
  if (Number.isNaN(fetchedAt.getTime())) {
    throw new Error(`${label}.fetchedAt must be a valid date`);
  }
  if (step.payload === null || typeof step.payload !== "object" || Array.isArray(step.payload)) {
    throw new Error(`${label}.payload must be a JSON object`);
  }
  if (!Array.isArray(step.facts)) {
    throw new Error(`${label}.facts must be an array`);
  }
  if (
    step.httpStatus !== undefined &&
    (!Number.isInteger(step.httpStatus) || step.httpStatus < 100 || step.httpStatus > 599)
  ) {
    throw new Error(`${label}.httpStatus must be a valid HTTP status code`);
  }
  if (step.payloadHash !== undefined && !step.payloadHash.startsWith("sha256:")) {
    throw new Error(`${label}.payloadHash must start with sha256:`);
  }
  if (step.rateLimit !== undefined) {
    validateRecordedRateLimit(step.rateLimit, `${label}.rateLimit`);
  }
}

export function validateRecordedRateLimit(
  rateLimit: CatalogCrawlerRateLimitMetadata,
  label: string,
): void {
  if (rateLimit === null || typeof rateLimit !== "object") {
    throw new Error(`${label} must be a JSON object`);
  }
  optionalNonnegativeFixtureInteger(rateLimit.remaining, `${label}.remaining`);
  optionalNonnegativeFixtureInteger(rateLimit.limit, `${label}.limit`);
  optionalNonnegativeFixtureInteger(rateLimit.retryAfterSeconds, `${label}.retryAfterSeconds`);
}

export function optionalNonnegativeFixtureInteger(input: number | undefined, label: string): void {
  if (input !== undefined && (!Number.isInteger(input) || input < 0)) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
}

export function requiredFixtureString(input: string | undefined, label: string): void {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`recorded crawler fixture ${label} is required`);
  }
}
