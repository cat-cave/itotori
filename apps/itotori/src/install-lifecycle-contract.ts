export const HOST_LIFECYCLE_SCHEMA = "itotori.host-lifecycle.v1";
export const SIGNED_RELEASE_SCHEMA = "itotori.signed-release.v1";

export class HostLifecycleError extends Error {
  override name = "HostLifecycleError";
}

export interface ReleaseFile {
  readonly path: string;
  readonly sha256: string;
}
export interface SignedReleaseManifest {
  readonly schema: typeof SIGNED_RELEASE_SCHEMA;
  readonly version: string;
  readonly issuedAt: string;
  readonly files: readonly ReleaseFile[];
}
export interface InstalledReleaseProvenance {
  readonly kind: "installed-package";
  readonly manifestSha256: string;
  readonly payloadSha256: string;
}
export interface SignedReleaseProvenance {
  readonly kind: "signed-update";
  readonly manifestSha256: string;
  readonly payloadSha256: string;
  readonly publicKeySha256: string;
  readonly signatureSha256: string;
}
export type ReleaseProvenance = InstalledReleaseProvenance | SignedReleaseProvenance;
export interface ActiveRelease {
  readonly version: string;
  readonly installedAt: string;
  readonly fileCount: number;
  readonly provenance: ReleaseProvenance;
}
export interface HostLifecycleState {
  readonly schema: typeof HOST_LIFECYCLE_SCHEMA;
  readonly active: ActiveRelease;
  readonly requiredFonts: readonly string[];
  readonly requiredGlyphs: readonly string[];
}
export interface FontProbe {
  readonly requirement: string;
  readonly available: boolean;
  readonly matchedFamily: string | undefined;
}
export interface HostInitializationInput {
  readonly stateRoot: string;
  readonly releaseVersion: string;
  readonly releasePayloadPath: string;
  readonly requiredFonts?: readonly string[];
  readonly requiredGlyphs?: readonly string[];
  readonly installedAt?: string;
}
export interface SignedUpdateInput {
  readonly stateRoot: string;
  readonly updateDirectory: string;
  readonly publicKeyPath: string;
  readonly installedAt?: string;
}
export interface RollbackInput {
  readonly stateRoot: string;
  readonly version: string;
  readonly installedAt?: string;
}
export interface LifecycleResult {
  readonly outcome: "initialized" | "unchanged" | "updated" | "rolled-back";
  readonly state: HostLifecycleState;
  /** Stable host-facing symlink selecting the active retained payload. */
  readonly activePayloadPath: string;
  readonly fonts: readonly FontProbe[];
  readonly glyphsSupported: boolean;
}
