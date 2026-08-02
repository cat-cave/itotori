import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { observeInstalledClient } from "./installed-client.js";

export interface CleanHostObservation {
  readonly initialized: boolean;
  readonly upgraded: boolean;
  readonly missingFontBlocked: boolean;
  readonly rerunSingular: boolean;
  readonly glyphsReady: boolean;
  readonly commandsReady: boolean;
  readonly selectedOutputOnly: boolean;
  readonly noTestOnlyControl: boolean;
  readonly dataSurvives: boolean;
  readonly activePayloadTransitions: boolean;
  readonly rollbackRecoversRetainedPayload: boolean;
  readonly reproducibleProvenance: boolean;
  readonly invalidSignatureRefused: boolean;
  readonly observedFields: number;
}

interface Call {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface BoundaryInput {
  readonly operation: "initialize" | "update" | "status";
  readonly stateRoot: string;
  readonly releaseVersion?: string;
  readonly releasePayloadPath?: string;
  readonly updateDirectory?: string;
  readonly publicKeyPath?: string;
  readonly installedAt?: string;
  readonly modulePath?: string;
}

let normal: CleanHostObservation | undefined;
let mutated: CleanHostObservation | undefined;

function run(command: string, args: readonly string[], cwd: string): Call {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function boundaryPath(repositoryRoot: string): string {
  return resolve(
    repositoryRoot,
    ".tmp",
    "behavior-proof",
    "glue",
    "product",
    "suite",
    "behavior",
    "product",
    "clean-host-lifecycle-boundary.js",
  );
}

function mutatedModulePath(repositoryRoot: string): string {
  return resolve(
    repositoryRoot,
    ".tmp",
    "behavior-proof",
    "clean-host-lifecycle-fixed-success-mutation",
    "apps",
    "itotori",
    "src",
    "install-lifecycle.js",
  );
}

function invokeBoundary(repositoryRoot: string, input: BoundaryInput, fixedSuccess: boolean): Call {
  const request = fixedSuccess
    ? { ...input, modulePath: mutatedModulePath(repositoryRoot) }
    : input;
  return run(
    process.execPath,
    [boundaryPath(repositoryRoot), JSON.stringify(request)],
    repositoryRoot,
  );
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writePayload(root: string, contents: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "selected-output.txt"), contents, "utf8");
  return root;
}

function writeSignedUpdate(
  root: string,
  version: string,
  contents: string,
  privateKey: KeyObject,
): string {
  const payload = writePayload(join(root, "payload"), contents);
  const manifest = {
    schema: "itotori.signed-release.v1",
    version,
    issuedAt: "2026-08-02T00:00:00.000Z",
    files: [{ path: "selected-output.txt", sha256: sha256(join(payload, "selected-output.txt")) }],
  };
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  writeFileSync(
    join(root, "signature.sig"),
    `${sign(null, Buffer.from(JSON.stringify(manifest)), privateKey).toString("base64")}\n`,
    "utf8",
  );
  return root;
}

function activeVersion(call: Call): string | undefined {
  if (call.status !== 0 || call.signal !== null || call.stderr.length > 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(call.stdout);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("state" in parsed) ||
      typeof parsed.state !== "object" ||
      parsed.state === null ||
      Array.isArray(parsed.state) ||
      !("active" in parsed.state) ||
      typeof parsed.state.active !== "object" ||
      parsed.state.active === null ||
      Array.isArray(parsed.state.active) ||
      !("version" in parsed.state.active) ||
      typeof parsed.state.active.version !== "string"
    ) {
      return undefined;
    }
    return parsed.state.active.version;
  } catch {
    return undefined;
  }
}

function signatureControl(
  repositoryRoot: string,
  workRoot: string,
  fixedSuccess: boolean,
): boolean {
  const root = mkdtempSync(join(workRoot, "clean-host-signature-control-"));
  try {
    const stateRoot = join(root, "host");
    const first = writePayload(join(root, "release-one"), "release one\n");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPath = join(root, "public-key.pem");
    writeFileSync(publicKeyPath, publicKey.export({ format: "pem", type: "spki" }), "utf8");
    const initialized = invokeBoundary(
      repositoryRoot,
      {
        operation: "initialize",
        stateRoot,
        releaseVersion: "version-one",
        releasePayloadPath: first,
        installedAt: "2026-08-02T00:00:00.000Z",
      },
      fixedSuccess,
    );
    if (initialized.status !== 0 || initialized.signal !== null) return false;
    const valid = writeSignedUpdate(
      join(root, "valid"),
      "version-two",
      "release two\n",
      privateKey,
    );
    const upgraded = invokeBoundary(
      repositoryRoot,
      { operation: "update", stateRoot, updateDirectory: valid, publicKeyPath },
      fixedSuccess,
    );
    if (upgraded.status !== 0 || activeVersion(upgraded) !== "version-two") return false;
    const wrongKeys = generateKeyPairSync("ed25519");
    const invalid = writeSignedUpdate(
      join(root, "invalid"),
      "version-three",
      "release three\n",
      wrongKeys.privateKey,
    );
    const refused = invokeBoundary(
      repositoryRoot,
      { operation: "update", stateRoot, updateDirectory: invalid, publicKeyPath },
      fixedSuccess,
    );
    const after = invokeBoundary(repositoryRoot, { operation: "status", stateRoot }, fixedSuccess);
    return (
      refused.status !== 0 &&
      refused.signal === null &&
      refused.stderr.includes("release signature is invalid") &&
      activeVersion(after) === "version-two"
    );
  } catch {
    return false;
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function collect(
  repositoryRoot: string,
  workRoot: string,
  fixedSuccess: boolean,
): CleanHostObservation {
  const client = observeInstalledClient(repositoryRoot, workRoot);
  const invalidSignatureRefused = signatureControl(repositoryRoot, workRoot, fixedSuccess);
  const values = { ...client, invalidSignatureRefused };
  return {
    ...values,
    observedFields: Object.values(values).filter((value) => typeof value === "boolean").length,
  };
}

/** Caches only observations, never lifecycle state; every host is real and transient. */
export function observeCleanHostLifecycle(
  repositoryRoot: string,
  workRoot: string,
  fixedSuccess: boolean,
): CleanHostObservation {
  if (fixedSuccess) {
    mutated ??= collect(repositoryRoot, workRoot, true);
    return mutated;
  }
  normal ??= collect(repositoryRoot, workRoot, false);
  return normal;
}
