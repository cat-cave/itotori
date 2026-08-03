import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { activePayloadMatches } from "./active-payload.js";
import { patchBoundaryProof } from "./patch-boundary.js";

export interface InstalledClientProof {
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
}

interface Call {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface SignedState {
  readonly version: string;
  readonly signed: boolean;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined = undefined,
): Call {
  const result = spawnSync(command, args, {
    cwd,
    ...(env === undefined ? {} : { env }),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function resultText(result: Call): string {
  return `${result.stdout}${result.stderr}`;
}

function failed(result: Call, text: string): boolean {
  return result.status !== 0 && result.signal === null && resultText(result).includes(text);
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

function fontFamily(): string | undefined {
  const result = run("fc-match", ["--format=%{family}\\n", "sans-serif:charset=3042"], ".");
  if (result.status !== 0) return undefined;
  const family = result.stdout.trim().split(",")[0]?.trim();
  return family === undefined || family.length === 0 ? undefined : family;
}

function packageBinary(repositoryRoot: string, workRoot: string): string | undefined {
  const root = resolve(workRoot, "clean-host-installed-client");
  const installRoot = join(root, "install");
  const binary = join(installRoot, "node_modules", ".bin", "itotori");
  if (existsSync(binary)) return binary;
  rmSync(root, { force: true, recursive: true });
  mkdirSync(root, { recursive: true });
  const build = run(process.execPath, ["packages/itotori-cli/build.mjs"], repositoryRoot);
  if (build.status !== 0 || build.signal !== null) return undefined;
  const pack = run(
    "npm",
    [
      "pack",
      resolve(repositoryRoot, "packages", "itotori-cli"),
      "--pack-destination",
      root,
      "--json",
    ],
    repositoryRoot,
  );
  if (pack.status !== 0 || pack.signal !== null) return undefined;
  const tarball = readdirSync(root).find((entry) => entry.endsWith(".tgz"));
  if (tarball === undefined) return undefined;
  const installed = run(
    "npm",
    [
      "install",
      join(root, tarball),
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--prefix",
      installRoot,
    ],
    repositoryRoot,
  );
  return installed.status === 0 && installed.signal === null && existsSync(binary)
    ? binary
    : undefined;
}

function signedState(path: string): SignedState | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.active) || !isRecord(parsed.active.provenance)) {
      return undefined;
    }
    const version = parsed.active.version;
    const provenance = parsed.active.provenance;
    if (typeof version !== "string") return undefined;
    const digests = [
      provenance.manifestSha256,
      provenance.payloadSha256,
      provenance.publicKeySha256,
      provenance.signatureSha256,
    ];
    return {
      version,
      signed:
        provenance.kind === "signed-update" &&
        digests.every((digest) => typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest)),
    };
  } catch {
    return undefined;
  }
}

function packageFiles(root: string): readonly string[] {
  const visit = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? visit(path) : [relative(root, path)];
    });
  return visit(root).toSorted();
}

function packageManifest(path: string): {
  readonly dependencies: readonly string[];
  readonly publishable: boolean;
} {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return { dependencies: [], publishable: false };
    const dependencies = isRecord(parsed.dependencies)
      ? Object.keys(parsed.dependencies).toSorted()
      : [];
    return { dependencies, publishable: parsed.private === false };
  } catch {
    return { dependencies: [], publishable: false };
  }
}

function commandProof(binary: string, root: string): boolean {
  const help = run(process.execPath, [binary, "help"], root);
  const extract = run(process.execPath, [binary, "extract"], root);
  const cleanHostEnv = { ...process.env };
  delete cleanHostEnv.ITOTORI_FIELD_CIPHER_KEY;
  const localize = run(process.execPath, [binary, "localize"], root, cleanHostEnv);
  const patch = run(process.execPath, [binary, "patch"], root);
  const validate = run(process.execPath, [binary, "validate"], root);
  return (
    help.status === 0 &&
    help.signal === null &&
    resultText(help).includes("LOCALIZATION:") &&
    failed(extract, "extract refused: --engine <engine> is required") &&
    failed(localize, "ITOTORI_FIELD_CIPHER_KEY is required") &&
    failed(patch, "flag --source is missing its value") &&
    failed(validate, "flag --engine is missing its value")
  );
}

function emptyProof(): InstalledClientProof {
  return {
    initialized: false,
    upgraded: false,
    missingFontBlocked: false,
    rerunSingular: false,
    glyphsReady: false,
    commandsReady: false,
    selectedOutputOnly: false,
    noTestOnlyControl: false,
    dataSurvives: false,
    activePayloadTransitions: false,
    rollbackRecoversRetainedPayload: false,
    reproducibleProvenance: false,
  };
}

/** Exercises a packed-and-installed client on a real temporary host filesystem. */
export function observeInstalledClient(
  repositoryRoot: string,
  workRoot: string,
): InstalledClientProof {
  const binary = packageBinary(repositoryRoot, workRoot);
  if (binary === undefined) return emptyProof();
  const packageRoot = join(
    resolve(workRoot, "clean-host-installed-client"),
    "install",
    "node_modules",
    "itotori",
  );
  const root = join(resolve(workRoot, "clean-host-installed-client"), "host-proof");
  rmSync(root, { force: true, recursive: true });
  mkdirSync(root, { recursive: true });
  try {
    const font = fontFamily();
    const glyphs = ["A", "あ"];
    const blockedConfig = join(root, "blocked.env");
    const blockedHost = join(root, "blocked-host");
    const missing = run(
      process.execPath,
      [
        binary,
        "init",
        "--non-interactive",
        "--config",
        blockedConfig,
        "--state-root",
        blockedHost,
        "--required-font",
        "itotori-required-font-not-installed",
        "--required-glyph",
        "A",
      ],
      root,
    );
    const missingFontBlocked =
      failed(missing, "required font unavailable") &&
      !existsSync(blockedConfig) &&
      !existsSync(join(blockedHost, "lifecycle-state.json"));
    if (font === undefined) return { ...emptyProof(), missingFontBlocked };
    const stateRoot = join(root, "ready-host");
    const configPath = join(root, "ready.env");
    const firstPayload = writePayload(join(root, "release-one"), "release one\n");
    const initialized = run(
      process.execPath,
      [
        binary,
        "init",
        "--non-interactive",
        "--config",
        configPath,
        "--state-root",
        stateRoot,
        "--release-version",
        "version-one",
        "--release-payload",
        firstPayload,
        "--required-font",
        font,
        "--required-glyph",
        "A",
        "--required-glyph",
        "あ",
      ],
      root,
    );
    const initializedState = signedState(join(stateRoot, "lifecycle-state.json"));
    const initialPayloadActive = activePayloadMatches(stateRoot, "version-one", "release one\n");
    const data = join(stateRoot, "data", "operator-owned.txt");
    if (
      initialized.status !== 0 ||
      initialized.signal !== null ||
      initializedState?.version !== "version-one" ||
      !initialPayloadActive
    ) {
      return { ...emptyProof(), missingFontBlocked };
    }
    writeFileSync(data, "retained user data\n", "utf8");
    const dataBefore = sha256(data);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPath = join(root, "update-public-key.pem");
    writeFileSync(publicKeyPath, publicKey.export({ format: "pem", type: "spki" }), "utf8");
    const validUpdate = writeSignedUpdate(
      join(root, "valid-update"),
      "version-two",
      "release two\n",
      privateKey,
    );
    const updated = run(
      process.execPath,
      [
        binary,
        "update",
        "--state-root",
        stateRoot,
        "--release",
        validUpdate,
        "--public-key",
        publicKeyPath,
      ],
      root,
    );
    const updatedState = signedState(join(stateRoot, "lifecycle-state.json"));
    const updatedPayloadActive = activePayloadMatches(stateRoot, "version-two", "release two\n");
    const secondPayload = writePayload(join(root, "release-two"), "release two\n");
    const rerun = run(
      process.execPath,
      [
        binary,
        "init",
        "--non-interactive",
        "--config",
        configPath,
        "--state-root",
        stateRoot,
        "--release-version",
        "version-two",
        "--release-payload",
        secondPayload,
        "--required-font",
        font,
        "--required-glyph",
        "A",
        "--required-glyph",
        "あ",
      ],
      root,
    );
    const rerunPayloadActive = activePayloadMatches(stateRoot, "version-two", "release two\n");
    const wrongKeys = generateKeyPairSync("ed25519");
    const invalidUpdate = writeSignedUpdate(
      join(root, "invalid-update"),
      "version-three",
      "release three\n",
      wrongKeys.privateKey,
    );
    const rejected = run(
      process.execPath,
      [
        binary,
        "update",
        "--state-root",
        stateRoot,
        "--release",
        invalidUpdate,
        "--public-key",
        publicKeyPath,
      ],
      root,
    );
    const finalState = signedState(join(stateRoot, "lifecycle-state.json"));
    const rejectedPayloadRetained = activePayloadMatches(stateRoot, "version-two", "release two\n");
    const rollbackOne = run(
      process.execPath,
      [binary, "rollback", "--state-root", stateRoot, "--version", "version-one"],
      root,
    );
    const rollbackOneState = signedState(join(stateRoot, "lifecycle-state.json"));
    const rollbackOnePayloadActive = activePayloadMatches(
      stateRoot,
      "version-one",
      "release one\n",
    );
    const rollbackTwo = run(
      process.execPath,
      [binary, "rollback", "--state-root", stateRoot, "--version", "version-two"],
      root,
    );
    const rollbackTwoState = signedState(join(stateRoot, "lifecycle-state.json"));
    const rollbackTwoPayloadActive = activePayloadMatches(
      stateRoot,
      "version-two",
      "release two\n",
    );
    const activePayloadTransitions =
      initialPayloadActive && updatedPayloadActive && rerunPayloadActive && rejectedPayloadRetained;
    const rollbackRecoversRetainedPayload =
      rollbackOne.status === 0 &&
      rollbackOne.signal === null &&
      rollbackOneState?.version === "version-one" &&
      rollbackOnePayloadActive &&
      rollbackTwo.status === 0 &&
      rollbackTwo.signal === null &&
      rollbackTwoState?.version === "version-two" &&
      rollbackTwoPayloadActive;
    const files = packageFiles(packageRoot);
    const manifest = packageManifest(join(packageRoot, "package.json"));
    const tarball = readdirSync(resolve(workRoot, "clean-host-installed-client")).find((entry) =>
      entry.endsWith(".tgz"),
    );
    const packageTarball =
      tarball === undefined
        ? undefined
        : join(resolve(workRoot, "clean-host-installed-client"), tarball);
    const fixedSuccess = run(process.execPath, [binary, "fixed-success"], root);
    const selectedOutputOnly =
      existsSync(join(stateRoot, "releases", "version-two", "payload", "selected-output.txt")) &&
      !existsSync(join(stateRoot, "releases", "version-two", "payload", "unselected-output.txt")) &&
      patchBoundaryProof(binary, root, repositoryRoot);
    return {
      initialized: initializedState.version === "version-one" && initialPayloadActive,
      upgraded:
        updated.status === 0 &&
        updated.signal === null &&
        updatedState?.version === "version-two" &&
        updatedPayloadActive,
      missingFontBlocked,
      rerunSingular:
        rerun.status === 0 &&
        rerun.signal === null &&
        rerunPayloadActive &&
        finalState?.version === "version-two",
      glyphsReady:
        initialized.status === 0 &&
        resultText(initialized).includes("representative glyphs are available"),
      commandsReady: commandProof(binary, root),
      selectedOutputOnly,
      noTestOnlyControl:
        !files.some((path) => /(^|\/)(?:test|suite)(?:\/|$)/u.test(path)) &&
        failed(fixedSuccess, "unknown itotori command") &&
        !readFileSync(join(packageRoot, "dist", "cli.js"), "utf8").includes("fixed-success"),
      dataSurvives:
        failed(rejected, "release signature is invalid") &&
        finalState?.version === "version-two" &&
        activePayloadTransitions &&
        rollbackRecoversRetainedPayload &&
        sha256(data) === dataBefore,
      activePayloadTransitions,
      rollbackRecoversRetainedPayload,
      reproducibleProvenance:
        updatedState?.signed === true &&
        finalState?.signed === true &&
        manifest.publishable &&
        manifest.dependencies.length === 0 &&
        packageTarball !== undefined &&
        /^[a-f0-9]{64}$/u.test(sha256(packageTarball)),
    };
  } catch {
    return emptyProof();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
