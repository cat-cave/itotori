export const immutableArtifactFormatVersion: "itotori.immutable-artifact.v1" =
  "itotori.immutable-artifact.v1";

const artifactFormatMigrationPath =
  "Recreate the artifact with a compatible itotori writer, then retry the read.";

export class ArtifactIncompatibleVersionError extends Error {
  readonly supportedVersions: readonly string[];

  constructor(
    public readonly observedVersion: string,
    supportedVersions: readonly string[],
    public readonly migrationPath: string,
    label: string,
  ) {
    const copiedSupportedVersions = Object.freeze([...supportedVersions]);
    super(
      `${label} '${observedVersion}' is incompatible. ` +
        `Supported versions: ${copiedSupportedVersions.join(", ")}. ` +
        `Migration path: ${migrationPath}`,
    );
    this.name = "ArtifactIncompatibleVersionError";
    this.supportedVersions = copiedSupportedVersions;
  }
}

export function assertArtifactVersion(
  observed: unknown,
  supportedVersions: readonly string[],
  migrationPath: string,
  label: string,
): void {
  const observedVersion =
    typeof observed === "string" && observed.length > 0 ? observed : "<absent>";
  if (supportedVersions.includes(observedVersion)) return;
  throw new ArtifactIncompatibleVersionError(
    observedVersion,
    supportedVersions,
    migrationPath,
    label,
  );
}

export function assertImmutableArtifactFormatVersion(observed: unknown): void {
  assertArtifactVersion(
    observed,
    [immutableArtifactFormatVersion],
    artifactFormatMigrationPath,
    "immutable artifact format version",
  );
}
