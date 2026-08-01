import {
  ArtifactStoreIntegrityError,
  type ArtifactAuditEvent,
  type ArtifactReference,
} from "./immutable-artifact-snapshot.js";
import type {
  ArtifactCapability,
  StoredArtifactRecord,
} from "./immutable-artifact-store-support.js";

export class ArtifactIdentityCollisionError extends ArtifactStoreIntegrityError {
  constructor(
    public readonly claimedArtifactId: string,
    public readonly variantArtifactId?: string,
  ) {
    super(
      variantArtifactId === undefined
        ? `artifact identity collision rejected for ${claimedArtifactId}`
        : `artifact identity collision rejected for ${claimedArtifactId}; preserved ${variantArtifactId}`,
    );
    this.name = "ArtifactIdentityCollisionError";
  }

  get claimed(): string {
    return this.claimedArtifactId;
  }

  get variant(): string | undefined {
    return this.variantArtifactId;
  }
}

export class ArtifactAuthorizationError extends Error {
  constructor(actor: string, capability: ArtifactCapability) {
    super(`actor ${actor} lacks ${capability}`);
    this.name = "ArtifactAuthorizationError";
  }
}

export function artifactIsReferenced(
  references: ReadonlyMap<string, ArtifactReference>,
  artifactId: string,
): boolean {
  return [...references.values()].some((reference) => reference.artifactId === artifactId);
}

export function artifactDependents(
  artifacts: ReadonlyMap<string, StoredArtifactRecord>,
  artifactId: string,
): string[] {
  return [...artifacts.values()]
    .filter((artifact) => artifact.parents.includes(artifactId))
    .map((artifact) => artifact.artifactId);
}

export function artifactIsEligibleForPrune(
  artifacts: ReadonlyMap<string, StoredArtifactRecord>,
  references: ReadonlyMap<string, ArtifactReference>,
  artifactId: string,
  at: string,
): boolean {
  const artifact = artifacts.get(artifactId);
  return (
    artifact !== undefined &&
    artifact.retention.expiresAt <= at &&
    !artifactIsReferenced(references, artifactId)
  );
}

export function assertArtifactAuditChronological(
  audit: readonly ArtifactAuditEvent[],
  at: string,
): void {
  const previous = audit.at(-1)?.occurredAt;
  if (previous !== undefined && at < previous) {
    throw new ArtifactStoreIntegrityError(`audit timestamp ${at} precedes ${previous}`);
  }
}
