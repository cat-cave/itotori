/** Real local-host release initialization, signed promotion, and rollback. */
import { verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOST_LIFECYCLE_SCHEMA,
  HostLifecycleError,
  SIGNED_RELEASE_SCHEMA,
  type ActiveRelease,
  type FontProbe,
  type HostInitializationInput,
  type HostLifecycleState,
  type InstalledReleaseProvenance,
  type LifecycleResult,
  type RollbackInput,
  type SignedReleaseManifest,
  type SignedReleaseProvenance,
  type SignedUpdateInput,
} from "./install-lifecycle-contract.js";
import {
  activateReleasePayload,
  activeReleasePayloadPath,
  assertFontsAndGlyphs,
  assertManifestMatchesPayload,
  canonicalManifestBytes,
  canonicalReleaseManifest,
  checkedDirectory,
  checkedFile,
  checkedGlyphs,
  checkedRoot,
  checkedTimestamp,
  checkedVersion,
  collectPayloadFiles,
  glyphsSupported,
  inspectRequiredFonts,
  materializeRelease,
  parseState,
  payloadSha256,
  prepareRoot,
  readJson,
  readManifest,
  readReleaseReceipt,
  readSignature,
  releasePath,
  removeCurrentReleasePayload,
  removeIfPresent,
  sameStrings,
  sha256,
  writeAtomicJson,
} from "./install-lifecycle-support.js";

export { HOST_LIFECYCLE_SCHEMA, HostLifecycleError, SIGNED_RELEASE_SCHEMA };
export type {
  ActiveRelease,
  FontProbe,
  HostInitializationInput,
  HostLifecycleState,
  InstalledReleaseProvenance,
  LifecycleResult,
  ReleaseFile,
  ReleaseProvenance,
  RollbackInput,
  SignedReleaseManifest,
  SignedReleaseProvenance,
  SignedUpdateInput,
} from "./install-lifecycle-contract.js";
export { canonicalReleaseManifest, inspectRequiredFonts } from "./install-lifecycle-support.js";

const STATE_FILE = "lifecycle-state.json";

/** Build the deterministic manifest that a release producer signs with Ed25519. */
export function buildSignedReleaseManifest(input: {
  readonly version: string;
  readonly payloadPath: string;
  readonly issuedAt?: string;
}): SignedReleaseManifest {
  const files = collectPayloadFiles(input.payloadPath).map(({ path, sha256 }) => ({
    path,
    sha256,
  }));
  return {
    schema: SIGNED_RELEASE_SCHEMA,
    version: checkedVersion(input.version),
    issuedAt: checkedTimestamp(input.issuedAt ?? new Date().toISOString()),
    files,
  };
}

export function readHostLifecycleState(stateRoot: string): HostLifecycleState {
  const root = checkedRoot(stateRoot);
  return parseState(readJson(join(root, STATE_FILE), "host lifecycle state"));
}

/** Return the stable `current` path after proving it selects the stated release. */
export function activeHostLifecyclePayloadPath(stateRoot: string): string {
  const root = checkedRoot(stateRoot);
  const state = readHostLifecycleState(root);
  return activeReleasePayloadPath(root, state.active.version);
}

/** Run the no-write host checks used by guided initialization. */
export function verifyHostLifecycleReadiness(input: {
  readonly requiredFonts?: readonly string[];
  readonly requiredGlyphs?: readonly string[];
}): { readonly fonts: readonly FontProbe[]; readonly glyphsSupported: boolean } {
  const fonts = inspectRequiredFonts(input.requiredFonts ?? []);
  const glyphs = checkedGlyphs(input.requiredGlyphs ?? []);
  assertFontsAndGlyphs(fonts, glyphs);
  return { fonts, glyphsSupported: glyphsSupported(fonts, glyphs) };
}

/**
 * Check all requirements before writing readiness state, then atomically install
 * the current package payload under a host-owned root.
 */
export function initializeHostLifecycle(input: HostInitializationInput): LifecycleResult {
  const root = checkedRoot(input.stateRoot);
  const readiness = verifyHostLifecycleReadiness(input);
  const { fonts } = readiness;
  const glyphs = checkedGlyphs(input.requiredGlyphs ?? []);
  const files = collectPayloadFiles(input.releasePayloadPath);
  const manifest: SignedReleaseManifest = {
    schema: SIGNED_RELEASE_SCHEMA,
    version: checkedVersion(input.releaseVersion),
    issuedAt: checkedTimestamp(input.installedAt ?? new Date().toISOString()),
    files: files.map(({ path, sha256 }) => ({ path, sha256 })),
  };
  const provenance: InstalledReleaseProvenance = {
    kind: "installed-package",
    manifestSha256: sha256(canonicalReleaseManifest(manifest)),
    payloadSha256: payloadSha256(manifest.files),
  };
  if (existsSync(join(root, STATE_FILE))) {
    const state = readHostLifecycleState(root);
    if (
      state.active.version === manifest.version &&
      state.active.provenance.payloadSha256 === provenance.payloadSha256 &&
      sameStrings(
        state.requiredFonts,
        fonts.map(({ requirement }) => requirement),
      ) &&
      sameStrings(state.requiredGlyphs, glyphs)
    ) {
      // Repair a lost `current` link from the already-complete retained release
      // instead of treating a partial host state as silently ready.
      activateReleasePayload(root, state.active.version);
      return result("unchanged", root, state, fonts, glyphs);
    }
    throw new HostLifecycleError(
      `host lifecycle is already initialized at ${root}; use itotori update for a new release`,
    );
  }
  prepareRoot(root);
  const active: ActiveRelease = {
    version: manifest.version,
    installedAt: manifest.issuedAt,
    fileCount: manifest.files.length,
    provenance,
  };
  try {
    materializeRelease(root, active.version, files, active);
    const state: HostLifecycleState = {
      schema: HOST_LIFECYCLE_SCHEMA,
      active,
      requiredFonts: fonts.map(({ requirement }) => requirement),
      requiredGlyphs: glyphs,
    };
    publishActiveState(root, state);
    return result("initialized", root, state, fonts, glyphs);
  } catch (error) {
    removeIfPresent(releasePath(root, active.version));
    throw error;
  }
}

/** Apply a complete signed update without replacing active state early. */
export function applySignedHostUpdate(input: SignedUpdateInput): LifecycleResult {
  const root = checkedRoot(input.stateRoot);
  const before = readHostLifecycleState(root);
  const updateRoot = checkedDirectory(input.updateDirectory, "update directory");
  const publicKeyPem = readFileSync(checkedFile(input.publicKeyPath, "update public key"), "utf8");
  const manifest = readManifest(join(updateRoot, "manifest.json"));
  const signature = readSignature(join(updateRoot, "signature.sig"));

  // MUTATION_TARGET: strict Ed25519 authorization gate. Keep this before staging
  // and state publication: a refusal retains the current runnable release.
  const signatureValid = verify(null, canonicalManifestBytes(manifest), publicKeyPem, signature);
  if (!signatureValid) {
    throw new HostLifecycleError(
      "host lifecycle update refused before replacement: release signature is invalid",
    );
  }

  const payloadRoot = checkedDirectory(join(updateRoot, "payload"), "update payload");
  const files = collectPayloadFiles(payloadRoot);
  assertManifestMatchesPayload(manifest, files);
  const provenance: SignedReleaseProvenance = {
    kind: "signed-update",
    manifestSha256: sha256(canonicalReleaseManifest(manifest)),
    payloadSha256: payloadSha256(manifest.files),
    publicKeySha256: sha256(publicKeyPem),
    signatureSha256: sha256(signature),
  };
  const fonts = inspectRequiredFonts(before.requiredFonts);
  assertFontsAndGlyphs(fonts, before.requiredGlyphs);
  if (before.active.version === manifest.version) {
    if (before.active.provenance.payloadSha256 !== provenance.payloadSha256) {
      throw new HostLifecycleError(
        `host lifecycle update refused: version ${manifest.version} already names a different release`,
      );
    }
    activateReleasePayload(root, before.active.version);
    return result("unchanged", root, before, fonts, before.requiredGlyphs);
  }
  const active: ActiveRelease = {
    version: manifest.version,
    installedAt: checkedTimestamp(input.installedAt ?? new Date().toISOString()),
    fileCount: manifest.files.length,
    provenance,
  };
  if (existsSync(releasePath(root, active.version))) {
    throw new HostLifecycleError(
      `host lifecycle update refused: release ${active.version} is already present`,
    );
  }
  try {
    materializeRelease(root, active.version, files, active);
    const state: HostLifecycleState = { ...before, active };
    publishActiveState(root, state, before.active.version);
    return result("updated", root, state, fonts, before.requiredGlyphs);
  } catch (error) {
    removeIfPresent(releasePath(root, active.version));
    throw error;
  }
}

/** Repoint a host at an already complete release while retaining data/. */
export function rollbackHostLifecycle(input: RollbackInput): LifecycleResult {
  const root = checkedRoot(input.stateRoot);
  const before = readHostLifecycleState(root);
  const active = readReleaseReceipt(releasePath(root, checkedVersion(input.version)));
  const fonts = inspectRequiredFonts(before.requiredFonts);
  assertFontsAndGlyphs(fonts, before.requiredGlyphs);
  const state: HostLifecycleState = {
    ...before,
    active: {
      ...active,
      installedAt: checkedTimestamp(input.installedAt ?? new Date().toISOString()),
    },
  };
  publishActiveState(root, state, before.active.version);
  return result("rolled-back", root, state, fonts, before.requiredGlyphs);
}

/**
 * Keep state and the runnable host-facing link in lockstep. Link replacement
 * itself is atomic; if state publication fails, the prior retained release is
 * atomically restored (or the first-install link is removed).
 */
function publishActiveState(
  root: string,
  state: HostLifecycleState,
  previousActiveVersion?: string,
): void {
  let linkChanged = false;
  try {
    activateReleasePayload(root, state.active.version);
    linkChanged = true;
    writeAtomicJson(join(root, STATE_FILE), state);
  } catch (error) {
    if (linkChanged) {
      try {
        if (previousActiveVersion === undefined) removeCurrentReleasePayload(root);
        else activateReleasePayload(root, previousActiveVersion);
      } catch {
        throw new HostLifecycleError(
          "host lifecycle could not restore the previous active release after state publication failed",
        );
      }
    }
    throw error;
  }
}

function result(
  outcome: LifecycleResult["outcome"],
  root: string,
  state: HostLifecycleState,
  fonts: readonly FontProbe[],
  glyphs: readonly string[],
): LifecycleResult {
  return {
    outcome,
    state,
    activePayloadPath: activeReleasePayloadPath(root, state.active.version),
    fonts,
    glyphsSupported: glyphsSupported(fonts, glyphs),
  };
}
