import { createHash } from "node:crypto";

const collisionVariantDomain = "itotori.immutable-artifact.collision.v1\u0000";

type CollisionAuditEvent = {
  action: string;
  outcome: string;
  target: string;
  details: { actualArtifactId?: unknown; reason?: unknown };
};

/** Derives a domain-separated address after two byte strings share a primary SHA-256 identity. */
export function artifactCollisionVariantIdForBytes(
  primaryArtifactId: string,
  bytes: Uint8Array,
): string {
  return `sha256:${createHash("sha256")
    .update(collisionVariantDomain)
    .update(primaryArtifactId)
    .update("\u0000")
    .update(bytes)
    .digest("hex")}`;
}

/** Returns the durable primary-to-variant relation recorded by immutable audit events. */
export function artifactCollisionPrimaryByVariant(
  events: readonly CollisionAuditEvent[],
): Map<string, string> | undefined {
  const variants = new Map<string, string>();
  for (const event of events) {
    const variant = event.details.actualArtifactId;
    if (
      event.action !== "put" ||
      event.outcome !== "rejected" ||
      event.details.reason !== "identity-collision" ||
      typeof variant !== "string"
    ) {
      continue;
    }
    const previous = variants.get(variant);
    if (previous !== undefined && previous !== event.target) return undefined;
    variants.set(variant, event.target);
  }
  return variants;
}
