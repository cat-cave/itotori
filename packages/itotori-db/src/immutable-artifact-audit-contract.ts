import {
  ArtifactStoreIntegrityError,
  assertArtifactHash,
  canonicalArtifactTimestamp,
  equalArtifactValues,
  hashArtifactJson,
  nonBlankArtifactValue,
  type ArtifactAuditAction,
  type ArtifactAuditEvent,
  type ArtifactReference,
  type ArtifactRetentionBasis,
  type ArtifactRetentionPolicy,
} from "./immutable-artifact-snapshot.js";

export function validateArtifactAuditEventContract(event: ArtifactAuditEvent): void {
  if (event.outcome === "denied") {
    validateDenied(event);
    return;
  }
  switch (event.action) {
    case "put":
      assertArtifactHash(event.target, "put audit target");
      validatePut(event);
      return;
    case "reference-add":
      validateReferenceAdd(event);
      return;
    case "reference-remove":
      validateReferenceRemove(event);
      return;
    case "retain":
      assertArtifactHash(event.target, "retention audit target");
      validateRetain(event);
      return;
    case "prune":
      if (event.outcome !== "pruned" && event.outcome !== "no-op") invalidPair(event);
      exactDetails(event, ["decisions", "requestedArtifactIds"]);
      return;
    case "read":
      assertArtifactHash(event.target, "read audit target");
      if (event.outcome === "served") {
        exactDetails(event, ["byteLength"]);
        detailInteger(event, "byteLength");
      } else if (event.outcome === "missing") exactDetails(event, []);
      else invalidPair(event);
      return;
    case "reference-resolve":
      validateReferenceResolve(event);
      return;
    case "export":
      if (event.target !== "artifact-snapshot" || event.outcome !== "exported") invalidPair(event);
      exactDetails(event, []);
      return;
    case "audit":
      if (event.target !== "audit-trail" || event.outcome !== "reviewed") invalidPair(event);
      exactDetails(event, []);
  }
}

function validatePut(event: ArtifactAuditEvent): void {
  if (event.outcome === "created") {
    exactDetails(event, ["basis", "classification", "expiresAt", "parents"]);
    detailRetentionBasis(event, "basis");
    detailClassification(event, "classification");
    canonicalArtifactTimestamp(detailString(event, "expiresAt"), "created retention deadline");
    detailHashes(event, "parents");
    return;
  }
  if (event.outcome === "already-present") {
    exactDetails(event, []);
    return;
  }
  if (event.outcome !== "rejected") invalidPair(event);
  const reason = detailString(event, "reason");
  if (reason === "content-hash-mismatch") {
    exactDetails(event, ["actualArtifactId", "reason"]);
    assertArtifactHash(detailString(event, "actualArtifactId"), "actual artifact identity");
  } else if (
    reason === "identity-collision" ||
    reason === "missing-or-self-parent" ||
    reason === "immutable-metadata-conflict"
  ) {
    exactDetails(event, ["reason"]);
  } else fail("put rejection reason is invalid");
}

function validateReferenceAdd(event: ArtifactAuditEvent): void {
  nonBlankArtifactValue(event.target, "reference audit target");
  if (event.outcome === "added" || event.outcome === "already-present") {
    exactDetails(event, ["artifactId", "purpose"]);
    assertArtifactHash(detailString(event, "artifactId"), "referenced artifact identity");
    detailReferencePurpose(event, "purpose");
    return;
  }
  if (event.outcome !== "rejected") invalidPair(event);
  exactDetails(event, ["reason"]);
  const reason = detailString(event, "reason");
  if (!new Set(["missing-artifact", "invalid-release-policy", "reference-conflict"]).has(reason)) {
    fail("reference-add rejection reason is invalid");
  }
}

function validateReferenceRemove(event: ArtifactAuditEvent): void {
  nonBlankArtifactValue(event.target, "reference audit target");
  if (event.outcome === "removed") {
    exactDetails(event, ["artifactId"]);
    assertArtifactHash(detailString(event, "artifactId"), "removed reference artifact identity");
    return;
  }
  if (event.outcome !== "rejected") invalidPair(event);
  exactDetails(event, ["reason"]);
  if (detailString(event, "reason") !== "missing-reference") {
    fail("reference-remove rejection reason is invalid");
  }
}

function validateRetain(event: ArtifactAuditEvent): void {
  if (event.outcome === "retained") {
    exactDetails(event, ["expiresAt", "previousExpiresAt"]);
    canonicalArtifactTimestamp(detailString(event, "expiresAt"), "retained deadline");
    canonicalArtifactTimestamp(detailString(event, "previousExpiresAt"), "previous deadline");
    return;
  }
  if (event.outcome !== "rejected") invalidPair(event);
  exactDetails(event, ["reason"]);
  if (detailString(event, "reason") !== "invalid-extension") {
    fail("retention rejection reason is invalid");
  }
}

function validateReferenceResolve(event: ArtifactAuditEvent): void {
  nonBlankArtifactValue(event.target, "resolved reference audit target");
  if (event.outcome === "missing") {
    exactDetails(event, []);
    return;
  }
  if (event.outcome !== "resolved") invalidPair(event);
  exactDetails(event, ["artifactId", "createdAt", "createdBy", "purpose"]);
  assertArtifactHash(detailString(event, "artifactId"), "resolved artifact identity");
  canonicalArtifactTimestamp(detailString(event, "createdAt"), "resolved reference timestamp");
  nonBlankArtifactValue(detailString(event, "createdBy"), "resolved reference creator");
  detailReferencePurpose(event, "purpose");
}

function validateDenied(event: ArtifactAuditEvent): void {
  const capability: Record<ArtifactAuditAction, string> = {
    put: "artifact:write",
    "reference-add": "artifact:reference",
    "reference-remove": "artifact:reference",
    retain: "artifact:retain",
    prune: "artifact:prune",
    read: "artifact:read",
    "reference-resolve": "artifact:read",
    export: "artifact:export",
    audit: "artifact:audit",
  };
  if (event.action === "prune") {
    exactDetails(event, ["requestedArtifactIds", "requiredCapability"]);
    const requested = detailHashes(event, "requestedArtifactIds");
    if (event.target !== `prune-scope:${hashArtifactJson(requested)}`)
      fail("denied prune target invalid");
  } else if (event.action === "read" && event.details.metadataOnly === true) {
    exactDetails(event, ["metadataOnly", "requiredCapability"]);
    assertArtifactHash(event.target, "denied read target");
  } else {
    exactDetails(event, ["requiredCapability"]);
    validateDeniedTarget(event);
  }
  if (detailString(event, "requiredCapability") !== capability[event.action]) {
    fail("denied audit capability is invalid");
  }
}

function validateDeniedTarget(event: ArtifactAuditEvent): void {
  if (event.action === "put" || event.action === "retain" || event.action === "read") {
    assertArtifactHash(event.target, "denied artifact target");
  } else if (event.action === "export" && event.target !== "artifact-snapshot") {
    fail("denied export target is invalid");
  } else if (event.action === "audit" && event.target !== "audit-trail") {
    fail("denied audit target is invalid");
  } else if (event.action === "prune") {
    fail("denied prune target lacks scope");
  } else {
    nonBlankArtifactValue(event.target, "denied reference target");
  }
}

function exactDetails(event: ArtifactAuditEvent, keys: readonly string[]): void {
  if (!equalArtifactValues(Object.keys(event.details).sort(), [...keys].sort())) {
    fail(`audit event ${event.ordinal} detail fields are invalid`);
  }
}

function detailString(event: ArtifactAuditEvent, key: string): string {
  const value = event.details[key];
  if (typeof value !== "string") fail(`audit event ${event.ordinal} lacks ${key}`);
  return value;
}

function detailInteger(event: ArtifactAuditEvent, key: string): number {
  const value = event.details[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`audit event ${event.ordinal} has invalid ${key}`);
  }
  return value;
}

function detailStrings(event: ArtifactAuditEvent, key: string): string[] {
  const value = event.details[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`audit event ${event.ordinal} has invalid ${key}`);
  }
  return value.map(String);
}

function detailHashes(event: ArtifactAuditEvent, key: string): string[] {
  const values = detailStrings(event, key);
  for (const value of values) assertArtifactHash(value, `audit ${key} identity`);
  if (!equalArtifactValues(values, [...values].sort()) || new Set(values).size !== values.length) {
    fail(`audit event ${event.ordinal} has unsorted or duplicate ${key}`);
  }
  return values;
}

function detailClassification(
  event: ArtifactAuditEvent,
  key: string,
): ArtifactRetentionPolicy["classification"] {
  const value = detailString(event, key);
  if (value !== "public" && value !== "restricted") fail(`invalid ${key}`);
  return value;
}

function detailRetentionBasis(event: ArtifactAuditEvent, key: string): ArtifactRetentionBasis {
  const value = detailString(event, key);
  if (!isRetentionBasis(value)) fail(`invalid ${key}`);
  return value;
}

function detailReferencePurpose(
  event: ArtifactAuditEvent,
  key: string,
): ArtifactReference["purpose"] {
  const value = detailString(event, key);
  if (value !== "lineage" && value !== "release") fail(`invalid ${key}`);
  return value;
}

function invalidPair(event: ArtifactAuditEvent): never {
  fail(`audit action ${event.action} cannot have outcome ${event.outcome}`);
}

function isRetentionBasis(value: unknown): value is ArtifactRetentionBasis {
  return (
    value === "lineage" ||
    value === "expiry" ||
    value === "release" ||
    value === "append-only" ||
    value === "declared-scope"
  );
}

function fail(message: string): never {
  throw new ArtifactStoreIntegrityError(message);
}
