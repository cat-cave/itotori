import {
  RebuildCallWirePolicySchema,
  RoleIdSchema,
  assertRebuildLlmStartupPolicy,
} from "../contracts/index.js";
import { WEB_SEARCH_EGRESS_ROLE, webEgressAllowed } from "../egress/index.js";
import { canonicalJson } from "../llm/canonical-json.js";
import { deepSeekV4FlashProfile, resolveRoleModelProfile } from "../llm/role-model-profiles.js";
import { assertOpenRouterZdrAccount } from "../providers/account-zdr.js";
import {
  LIVE_CONFORMANCE_MAX_AGE_MS,
  QUALIFYING_ADMISSION_ATTESTATIONS,
  QualifyingAdmissionError,
  type ContentFreeTelemetryCapture,
  type QualifyingAdmission,
  type QualifyingAdmissionAttestation,
  type QualifyingAdmissionRequest,
  type QualifyingRouteCapture,
} from "./types.js";

/**
 * Attest the complete qualifying-run privacy posture before any run work begins.
 * Every input is captured explicitly: a missing or malformed capture blocks the
 * run rather than inheriting a process default or a previous result.
 */
export function admitQualifyingRun(request: QualifyingAdmissionRequest): QualifyingAdmission {
  const admittedAt = admittedAtFrom(request.now);
  assertAccountZdr(request);
  assertCertifiedRoutes(request);
  assertPrivateWire(request);
  assertContentFreeTelemetry(request);
  assertWebEgressClosed(request);

  return {
    admittedAt,
    routeCount: request.routes.length,
    attestations: Object.fromEntries(
      QUALIFYING_ADMISSION_ATTESTATIONS.map((attestation) => [attestation, "passed"]),
    ) as Readonly<Record<QualifyingAdmissionAttestation, "passed">>,
  };
}

/**
 * Execute a qualifying run only after admission. A rejected admission throws
 * before `run` is invoked, making the blocking guarantee directly usable by a
 * future lane integration.
 */
export async function runAfterQualifyingAdmission<T>(
  request: QualifyingAdmissionRequest,
  run: (admission: QualifyingAdmission) => Promise<T> | T,
): Promise<T> {
  return await run(admitQualifyingRun(request));
}

function admittedAtFrom(now: Date): string {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) {
    reject("live-conformance", "admission clock is not a valid timestamp");
  }
  return now.toISOString();
}

function assertAccountZdr(request: QualifyingAdmissionRequest): void {
  try {
    // Keep the account assertion distinct from the complete startup assertion:
    // the former names the account proof and the latter covers the guardrail.
    assertOpenRouterZdrAccount(request.env);
    assertRebuildLlmStartupPolicy(request.env);
  } catch (error) {
    reject("account-zdr", errorMessage(error));
  }
}

function assertCertifiedRoutes(request: QualifyingAdmissionRequest): void {
  if (request.routes.length === 0) {
    reject("certified-route", "planned route capture is missing");
  }
  for (const route of request.routes) {
    assertCertifiedRoute(route, request.certificates, request.now);
  }
}

function assertCertifiedRoute(
  route: QualifyingRouteCapture,
  certificates: readonly unknown[],
  now: Date,
): void {
  const roleId = RoleIdSchema.safeParse(route.roleId);
  if (!roleId.success) {
    reject("certified-route", "route capture has an invalid role");
  }

  let resolved: ReturnType<typeof resolveRoleModelProfile>;
  try {
    resolved = resolveRoleModelProfile(roleId.data, { certificates });
  } catch (error) {
    reject("live-conformance", errorMessage(error));
  }

  assertCurrentLiveCertificate(resolved.certificate.probedAt, now);

  const captured = {
    modelProfile: route.modelProfile,
    modelProfileVersion: route.modelProfileVersion,
    requestedModel: route.requestedModel,
    providerPolicy: route.providerPolicy,
  };
  const approved = {
    modelProfile: resolved.modelProfile,
    modelProfileVersion: resolved.version,
    requestedModel: resolved.model,
    providerPolicy: resolved.providerPolicy,
  };
  if (canonicalJson(captured) !== canonicalJson(approved)) {
    reject("certified-route", "route capture does not exactly match its certified profile");
  }
  if (resolved.model !== deepSeekV4FlashProfile.model) {
    reject("certified-route", "certified profile is not the approved qualifying model route");
  }
}

function assertCurrentLiveCertificate(probedAt: string, now: Date): void {
  const probedAtMs = Date.parse(probedAt);
  const ageMs = now.getTime() - probedAtMs;
  if (!Number.isFinite(probedAtMs) || ageMs < 0 || ageMs > LIVE_CONFORMANCE_MAX_AGE_MS) {
    reject("live-conformance", "live conformance capture is expired, future-dated, or invalid");
  }
}

function assertPrivateWire(request: QualifyingAdmissionRequest): void {
  if (request.wireCapture === null || request.wireCapture === undefined) {
    reject("private-wire", "outbound wire capture is missing");
  }

  const parsed = RebuildCallWirePolicySchema.safeParse(request.wireCapture);
  if (!parsed.success) {
    reject("private-wire", "wire capture does not enforce metadata, cache-off, and no-plugins");
  }
  if (
    parsed.data.model !== deepSeekV4FlashProfile.model ||
    canonicalJson(parsed.data.provider) !== canonicalJson(deepSeekV4FlashProfile.providerPolicy)
  ) {
    reject("private-wire", "wire capture does not match the approved qualifying route");
  }
}

function assertContentFreeTelemetry(request: QualifyingAdmissionRequest): void {
  const capture = request.telemetryCapture;
  if (!isContentFreeTelemetryCapture(capture)) {
    reject("content-free-telemetry", "content-free telemetry lineage capture is missing or unsafe");
  }
}

function isContentFreeTelemetryCapture(value: unknown): value is ContentFreeTelemetryCapture {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "captureKind",
    "contentFree",
    "promptTextPathEnabled",
    "sourceTextPathEnabled",
    "targetTextPathEnabled",
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }
  return (
    record.captureKind === "qualifying-content-free" &&
    record.contentFree === true &&
    record.promptTextPathEnabled === false &&
    record.sourceTextPathEnabled === false &&
    record.targetTextPathEnabled === false
  );
}

function assertWebEgressClosed(request: QualifyingAdmissionRequest): void {
  if (
    request.egressPolicy.qualifyingRun !== true ||
    request.egressPolicy.operatorEnabled !== false ||
    webEgressAllowed(WEB_SEARCH_EGRESS_ROLE, request.egressPolicy)
  ) {
    reject("web-egress-closed", "web egress must be disabled for the qualifying run");
  }
}

function reject(attestation: QualifyingAdmissionAttestation, detail: string): never {
  throw new QualifyingAdmissionError(attestation, detail);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "an unknown assertion failed";
}
