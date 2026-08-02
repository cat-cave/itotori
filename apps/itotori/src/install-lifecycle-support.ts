import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  HOST_LIFECYCLE_SCHEMA,
  HostLifecycleError,
  SIGNED_RELEASE_SCHEMA,
  type ActiveRelease,
  type FontProbe,
  type HostLifecycleState,
  type ReleaseFile,
  type ReleaseProvenance,
  type SignedReleaseManifest,
} from "./install-lifecycle-contract.js";

export type PayloadFile = ReleaseFile & { readonly sourcePath: string };

export function canonicalReleaseManifest(manifest: SignedReleaseManifest): string {
  const checked = checkedManifest(manifest);
  return JSON.stringify({
    schema: checked.schema,
    version: checked.version,
    issuedAt: checked.issuedAt,
    files: checked.files,
  });
}

export function canonicalManifestBytes(manifest: SignedReleaseManifest): Buffer {
  return Buffer.from(canonicalReleaseManifest(manifest), "utf8");
}

export function readManifest(path: string): SignedReleaseManifest {
  return checkedManifest(readJson(path, "signed release manifest"));
}

export function checkedManifest(value: unknown): SignedReleaseManifest {
  if (!isRecord(value) || value.schema !== SIGNED_RELEASE_SCHEMA) {
    throw new HostLifecycleError("signed release manifest is invalid");
  }
  const version = checkedVersion(value.version);
  const issuedAt = checkedTimestamp(value.issuedAt);
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new HostLifecycleError("signed release manifest has no payload files");
  }
  const files = value.files.map((entry) => {
    if (!isRecord(entry)) throw new HostLifecycleError("signed release manifest file is invalid");
    return { path: checkedRelativePath(entry.path), sha256: checkedSha256(entry.sha256) };
  });
  if (
    !sameStrings(
      files.map(({ path }) => path),
      [...files].map(({ path }) => path).sort((left, right) => left.localeCompare(right)),
    )
  ) {
    throw new HostLifecycleError("signed release manifest files must be sorted by path");
  }
  if (new Set(files.map(({ path }) => path)).size !== files.length) {
    throw new HostLifecycleError("signed release manifest repeats a payload path");
  }
  return { schema: SIGNED_RELEASE_SCHEMA, version, issuedAt, files };
}

export function collectPayloadFiles(payloadPath: string): readonly PayloadFile[] {
  const root = checkedFileOrDirectory(payloadPath, "release payload");
  if (lstatSync(root).isFile()) return [payloadFile(root, basename(root))];
  const files: PayloadFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const candidate = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new HostLifecycleError(`release payload may not contain symlinks: ${candidate}`);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) files.push(payloadFile(candidate, relative(root, candidate)));
      else
        throw new HostLifecycleError(`release payload contains an unsupported entry: ${candidate}`);
    }
  };
  visit(root);
  if (files.length === 0) throw new HostLifecycleError("release payload has no files");
  return files;
}

export function assertManifestMatchesPayload(
  manifest: SignedReleaseManifest,
  files: readonly PayloadFile[],
): void {
  const observed = files.map(({ path, sha256 }) => ({ path, sha256 }));
  if (JSON.stringify(manifest.files) !== JSON.stringify(observed)) {
    throw new HostLifecycleError(
      "host lifecycle update refused before replacement: payload files do not match the signed manifest",
    );
  }
}

export function materializeRelease(
  root: string,
  version: string,
  files: readonly PayloadFile[],
  active: ActiveRelease,
): void {
  const destination = releasePath(root, version);
  const stage = join(root, `.release-stage-${randomUUID()}`);
  try {
    mkdirSync(join(stage, "payload"), { recursive: true, mode: 0o755 });
    for (const file of files) {
      const target = safeChild(join(stage, "payload"), file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      copyFileSync(file.sourcePath, target);
    }
    writeFileSync(join(stage, "provenance.json"), `${JSON.stringify(active)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(stage, destination);
  } catch (error) {
    removeIfPresent(stage);
    throw error;
  }
}

export function readReleaseReceipt(path: string): ActiveRelease {
  const releaseRoot = checkedDirectory(path, "stored release");
  const receipt = readJson(join(releaseRoot, "provenance.json"), "stored release provenance");
  if (!isRecord(receipt)) throw new HostLifecycleError("stored release provenance is invalid");
  const active = readActive(receipt);
  const files = collectPayloadFiles(join(releaseRoot, "payload"));
  if (
    files.length !== active.fileCount ||
    payloadSha256(files) !== active.provenance.payloadSha256
  ) {
    throw new HostLifecycleError("stored release payload is incomplete or has changed");
  }
  return active;
}

export function parseState(value: unknown): HostLifecycleState {
  if (!isRecord(value) || value.schema !== HOST_LIFECYCLE_SCHEMA || !isRecord(value.active)) {
    throw new HostLifecycleError("host lifecycle state is invalid");
  }
  return {
    schema: HOST_LIFECYCLE_SCHEMA,
    active: readActive(value.active),
    requiredFonts: uniqueStrings(value.requiredFonts, "stored required font"),
    requiredGlyphs: checkedGlyphs(value.requiredGlyphs),
  };
}

export function inspectRequiredFonts(requirements: readonly string[]): readonly FontProbe[] {
  return uniqueStrings(requirements, "required font").map((requirement) => {
    if (isAbsolute(requirement)) {
      const available = existsSync(requirement) && lstatSync(requirement).isFile();
      return {
        requirement,
        available,
        matchedFamily: available ? basename(requirement) : undefined,
      };
    }
    if (!/^[A-Za-z0-9 ._-]+$/u.test(requirement)) {
      throw new HostLifecycleError(`required font name is not a safe font family: ${requirement}`);
    }
    const probe = spawnSync("fc-match", ["--format=%{family}\\n", requirement], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const matchedFamily =
      probe.status === 0 ? probe.stdout.trim().split("\n")[0]?.trim() : undefined;
    const available =
      matchedFamily?.split(",").map(normalizedFont).includes(normalizedFont(requirement)) ?? false;
    return { requirement, available, matchedFamily };
  });
}

export function assertFontsAndGlyphs(fonts: readonly FontProbe[], glyphs: readonly string[]): void {
  const missing = fonts.filter(({ available }) => !available).map(({ requirement }) => requirement);
  if (missing.length > 0) {
    throw new HostLifecycleError(
      `host lifecycle initialization blocked before readiness: required font unavailable: ${missing.join(", ")}`,
    );
  }
  if (!glyphsSupported(fonts, glyphs)) {
    throw new HostLifecycleError(
      "host lifecycle initialization blocked before readiness: required font does not cover representative glyphs",
    );
  }
}

export function glyphsSupported(fonts: readonly FontProbe[], glyphs: readonly string[]): boolean {
  if (glyphs.length === 0 || fonts.length === 0) return true;
  return fonts.every(({ requirement, available }) => {
    if (!available || isAbsolute(requirement)) return available;
    return glyphs.every((glyph) => {
      const codePoint = glyph.codePointAt(0);
      const probe =
        codePoint === undefined
          ? undefined
          : spawnSync(
              "fc-match",
              ["--format=%{family}\\n", `${requirement}:charset=${codePoint.toString(16)}`],
              { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
            );
      const matched = probe?.status === 0 ? probe.stdout.trim().split("\n")[0] : undefined;
      return matched?.split(",").map(normalizedFont).includes(normalizedFont(requirement)) ?? false;
    });
  });
}

export function checkedRoot(path: string): string {
  if (typeof path !== "string" || path.length === 0)
    throw new HostLifecycleError("host state root is required");
  return resolve(path);
}

export function checkedDirectory(path: string, label: string): string {
  const resolved = checkedFileOrDirectory(path, label);
  if (!lstatSync(resolved).isDirectory())
    throw new HostLifecycleError(`${label} is not a directory: ${resolved}`);
  return resolved;
}

export function checkedFile(path: string, label: string): string {
  const resolved = checkedFileOrDirectory(path, label);
  if (!lstatSync(resolved).isFile())
    throw new HostLifecycleError(`${label} is not a file: ${resolved}`);
  return resolved;
}

export function checkedVersion(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new HostLifecycleError("release version is invalid");
  }
  return value;
}

export function checkedTimestamp(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new HostLifecycleError("release timestamp is invalid");
  }
  return value;
}

export function checkedGlyphs(value: unknown): readonly string[] {
  return uniqueStrings(value, "required glyph").map((glyph) => {
    if ([...glyph].length !== 1)
      throw new HostLifecycleError(`required glyph is not one code point: ${glyph}`);
    return glyph;
  });
}

export function releasePath(root: string, version: string): string {
  return safeChild(join(root, "releases"), version);
}

export function currentReleasePath(root: string): string {
  return safeChild(root, "current");
}

export function prepareRoot(root: string): void {
  mkdirSync(join(root, "releases"), { recursive: true, mode: 0o755 });
  mkdirSync(join(root, "data"), { recursive: true, mode: 0o700 });
}

/**
 * Atomically point the host-facing `current` link at one complete retained
 * payload. A regular file or directory at that path is never overwritten.
 */
export function activateReleasePayload(root: string, version: string): void {
  const checkedVersionValue = checkedVersion(version);
  const receipt = readReleaseReceipt(releasePath(root, checkedVersionValue));
  if (receipt.version !== checkedVersionValue) {
    throw new HostLifecycleError(
      "stored release provenance version does not match its retained path",
    );
  }
  const payload = checkedDirectory(
    join(releasePath(root, checkedVersionValue), "payload"),
    "stored release payload",
  );
  const current = currentReleasePath(root);
  assertCurrentLinkOrAbsent(current);
  const temporary = `${current}.next-${randomUUID()}`;
  try {
    symlinkSync(payload, temporary, "dir");
    renameSync(temporary, current);
  } finally {
    removeIfPresent(temporary);
  }
}

export function removeCurrentReleasePayload(root: string): void {
  const current = currentReleasePath(root);
  try {
    const stat = lstatSync(current);
    if (!stat.isSymbolicLink()) {
      throw new HostLifecycleError(`host lifecycle current release path is not a link: ${current}`);
    }
    unlinkSync(current);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
}

/** Verify the stable link still selects exactly the release named by state. */
export function activeReleasePayloadPath(root: string, version: string): string {
  const current = currentReleasePath(root);
  try {
    if (!lstatSync(current).isSymbolicLink()) {
      throw new HostLifecycleError(`host lifecycle current release path is not a link: ${current}`);
    }
    const expected = realpathSync(
      checkedDirectory(
        join(releasePath(root, checkedVersion(version)), "payload"),
        "stored active release payload",
      ),
    );
    if (realpathSync(current) !== expected) {
      throw new HostLifecycleError(
        "host lifecycle current release does not match state; run itotori rollback with a retained version",
      );
    }
    return current;
  } catch (error) {
    if (error instanceof HostLifecycleError) throw error;
    throw new HostLifecycleError(
      "host lifecycle current release is unavailable; run itotori rollback with a retained version",
    );
  }
}

export function writeAtomicJson(path: string, value: unknown): void {
  const temporary = `${path}.next-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temporary, path);
  } finally {
    removeIfPresent(temporary);
  }
}

export function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new HostLifecycleError(`${label} is invalid or unavailable`);
  }
}

export function readSignature(path: string): Buffer {
  const encoded = readFileSync(checkedFile(path, "release signature"), "utf8").trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new HostLifecycleError("release signature is not canonical base64");
  }
  return Buffer.from(encoded, "base64");
}

export function payloadSha256(files: readonly ReleaseFile[]): string {
  return sha256(files.map(({ path, sha256: digest }) => `${path}\0${digest}\n`).join(""));
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export function removeIfPresent(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function payloadFile(sourcePath: string, path: string): PayloadFile {
  return { path: checkedRelativePath(path), sha256: sha256(readFileSync(sourcePath)), sourcePath };
}

function readActive(value: Record<string, unknown>): ActiveRelease {
  const fileCount = value.fileCount;
  if (
    typeof fileCount !== "number" ||
    !Number.isInteger(fileCount) ||
    fileCount <= 0 ||
    !isRecord(value.provenance)
  ) {
    throw new HostLifecycleError("host lifecycle active release is invalid");
  }
  return {
    version: checkedVersion(value.version),
    installedAt: checkedTimestamp(value.installedAt),
    fileCount,
    provenance: checkedProvenance(value.provenance),
  };
}

function checkedProvenance(value: Record<string, unknown>): ReleaseProvenance {
  const manifestSha256 = checkedSha256(value.manifestSha256);
  const payloadSha256 = checkedSha256(value.payloadSha256);
  if (value.kind === "installed-package")
    return { kind: "installed-package", manifestSha256, payloadSha256 };
  if (value.kind === "signed-update") {
    return {
      kind: "signed-update",
      manifestSha256,
      payloadSha256,
      publicKeySha256: checkedSha256(value.publicKeySha256),
      signatureSha256: checkedSha256(value.signatureSha256),
    };
  }
  throw new HostLifecycleError("host lifecycle release provenance is invalid");
}

function checkedFileOrDirectory(path: string, label: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved) || lstatSync(resolved).isSymbolicLink()) {
    throw new HostLifecycleError(`${label} is unavailable: ${resolved}`);
  }
  const stat = lstatSync(resolved);
  if (!stat.isFile() && !stat.isDirectory())
    throw new HostLifecycleError(`${label} is not a file or directory`);
  return resolved;
}

function assertCurrentLinkOrAbsent(path: string): void {
  try {
    if (!lstatSync(path).isSymbolicLink()) {
      throw new HostLifecycleError(`host lifecycle current release path is not a link: ${path}`);
    }
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function checkedRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    throw new HostLifecycleError("release payload path is invalid");
  }
  const parts = value.split("/");
  if (
    isAbsolute(value) ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new HostLifecycleError("release payload path escapes its root");
  }
  return parts.join("/");
}

function checkedSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new HostLifecycleError("sha256 digest is invalid");
  }
  return value;
}

function uniqueStrings(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new HostLifecycleError(`${label} list is invalid`);
  }
  const result = [...new Set(value)];
  if (result.length !== value.length)
    throw new HostLifecycleError(`${label} list repeats an entry`);
  return result;
}

function safeChild(root: string, child: string): string {
  const target = resolve(root, child);
  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw new HostLifecycleError("host lifecycle path escapes its root");
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedFont(value: string): string {
  return value.trim().toLocaleLowerCase();
}
