import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

import { MissingRequiredInputError, ProviderUnavailableError } from "@itotori/db";
import { renderAssetDecisionsFailure } from "../../../apps/itotori/src/asset-decisions/route.js";
import { resolveTargetPolicyForAdapter } from "../../../apps/itotori/src/gates/policy/registry.js";
import {
  PatchRuntimeLaunchError,
  RuntimeLauncherRegistry,
  type PatchRuntimeLaunchReceipt,
} from "../../../apps/itotori/src/play/runtime-launcher-registry.js";
import {
  errorName,
  isRecord,
  projectFailureWithEffects as project,
  sourceErrorCode,
  type CandidateRequest,
  type CandidateResult,
  type Probe,
} from "./explicit-failure-candidate-support.js";
import {
  budgetRefusal,
  cancelled,
  deadline,
  decryptionFailure,
  internalFailure,
  misleadingMessage,
  missingAsset,
  permissionDenial,
  preparationFailure,
  privacyDenial,
} from "./explicit-failure-candidate-secondary.js";
import {
  changedSourceRevision,
  malformedOwnedInput,
} from "./explicit-failure-candidate-command.js";
import { OperationEffectBoundary } from "./explicit-failure-effects.js";

const PRIVATE_COMMANDS: readonly (readonly [string, string])[] = [
  ["suite/scripts/kaifuu-private-local-triage/run.mjs", "kaifuu:private-local-triage"],
  [
    "suite/scripts/siglus-private-local-validation-renderer/run.mjs",
    "siglus:private-local-validation-render",
  ],
  ["suite/scripts/kaifuu-key-hunt/run.mjs", "kaifuu:key-hunt"],
  ["suite/scripts/kaifuu-encrypted-readiness-integration/run.mjs", "kaifuu:encrypted-readiness"],
];

const PROBES: ReadonlySet<string> = new Set([
  "missing-input",
  "provider-unavailable",
  "unsupported-profile",
  "malformed-input",
  "unsupported-operation",
  "stale-source",
  "privacy-denial",
  "permission-denial",
  "deadline",
  "cancelled",
  "budget-refusal",
  "internal-failure",
  "missing-asset",
  "decryption-failure",
  "preparation-failure",
  "misleading-message",
]);

function isProbe(value: unknown): value is Probe {
  return typeof value === "string" && PROBES.has(value);
}

function parseRequest(value: string | undefined): CandidateRequest {
  if (value === undefined) throw new Error("candidate-request-missing");
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("candidate-request-invalid");
  if (
    !isProbe(parsed.probe) ||
    typeof parsed.repositoryRoot !== "string" ||
    typeof parsed.scratchRoot !== "string" ||
    typeof parsed.operationOutputRoot !== "string" ||
    typeof parsed.httpBoundary !== "boolean" ||
    resolve(parsed.scratchRoot) === resolve(parsed.operationOutputRoot)
  ) {
    throw new Error("candidate-request-invalid");
  }
  return {
    probe: parsed.probe,
    repositoryRoot: parsed.repositoryRoot,
    scratchRoot: parsed.scratchRoot,
    operationOutputRoot: parsed.operationOutputRoot,
    httpBoundary: parsed.httpBoundary,
  };
}

async function missingInput(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(
    input.operationOutputRoot,
    "missing-input-output.json",
  );
  const commands = PRIVATE_COMMANDS.map(([script, task]) => {
    const result = spawnSync(
      process.execPath,
      [script, "--no-corpus", "--out", effects.outputPath],
      {
        cwd: input.repositoryRoot,
        encoding: "utf8",
        env: {},
        timeout: 10_000,
      },
    );
    let diagnostic: unknown = null;
    try {
      diagnostic = JSON.parse(result.stderr);
    } catch (error) {
      diagnostic = error;
    }
    return {
      task,
      status: result.status,
      stdoutBytes: Buffer.byteLength(result.stdout),
      safeDiagnostic:
        isRecord(diagnostic) &&
        diagnostic.status === "failed" &&
        diagnostic.failureClass === "missing-input" &&
        diagnostic.effectOutcome === "no-effects",
      outputWritten: existsSync(effects.outputPath),
    };
  });
  return await project(
    new MissingRequiredInputError("private-corpus"),
    { commands },
    false,
    effects,
  );
}

async function providerUnavailable(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(
    input.operationOutputRoot,
    "provider-localization.json",
  );
  let requests = 0;
  const provider = createServer((_request, response) => {
    requests += 1;
    response.writeHead(503, { "content-length": "0" });
    response.end();
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const address = provider.address();
  if (address === null || typeof address === "string") throw new Error("provider-bind");
  let providerStatus = 0;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/localize`, {
      method: "POST",
    });
    providerStatus = response.status;
    if (response.ok) effects.commit(new Uint8Array(await response.arrayBuffer()));
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
  }
  writeFileSync(
    resolve(input.scratchRoot, "provider-state.json"),
    JSON.stringify({ state: "paused", nextAction: "retry-provider-request" }),
  );
  return await project(
    new ProviderUnavailableError(providerStatus),
    { providerStatus, providerRequests: requests },
    true,
    effects,
  );
}

async function unsupportedProfile(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(input.operationOutputRoot, "profile-patch.html");
  let caught: unknown;
  try {
    const policy = resolveTargetPolicyForAdapter("behavior-unregistered-adapter");
    effects.commit(JSON.stringify(policy));
  } catch (error) {
    caught = error;
  }
  const result = await project(caught, { errorName: errorName(caught) }, false, effects);
  const rendered = { innerHTML: "" };
  renderAssetDecisionsFailure(
    rendered,
    {
      projectId: "project:failure-contract",
      localeBranchId: "patch-production",
      view: "policy",
    },
    caught,
  );
  writeFileSync(resolve(input.scratchRoot, "profile-refusal.html"), rendered.innerHTML);
  return result;
}

async function unsupportedOperation(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(input.operationOutputRoot, "playback-receipt.json");
  let handlerCalls = 0;
  const registry = new RuntimeLauncherRegistry([
    () => ({
      manifest: {
        adapterId: "behavior-runtime",
        summary: "behavior contract adapter",
        capabilities: ["validate"],
      },
      async launch() {
        handlerCalls += 1;
        const receipt: PatchRuntimeLaunchReceipt = {
          adapterId: "reallive",
          operation: "replay-validate",
          adapterReceipt: { replay: "observed", scene: 0, observedTextLineCount: 0 },
        };
        effects.commit(JSON.stringify(receipt));
        return receipt;
      },
      validateCli() {},
    }),
  ]);
  let caught: unknown;
  try {
    await registry.launch({
      patch: { patchVersionId: "patch", status: "playable", artifactHashes: {}, artifactRefs: {} },
      request: {
        adapterId: "behavior-runtime",
        operation: "replay-validate",
        launchDescriptor: {},
      },
    });
  } catch (error) {
    caught = error;
  }
  return await project(
    caught,
    { errorName: errorName(caught), errorCode: sourceErrorCode(caught), handlerCalls },
    false,
    effects,
  );
}

async function run(input: CandidateRequest): Promise<CandidateResult> {
  const outputStat = lstatSync(input.operationOutputRoot);
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) {
    throw new Error("candidate-operation-output-invalid");
  }
  mkdirSync(input.scratchRoot, { recursive: true });
  switch (input.probe) {
    case "missing-input":
      return await missingInput(input);
    case "provider-unavailable":
      return await providerUnavailable(input);
    case "unsupported-profile":
      return await unsupportedProfile(input);
    case "malformed-input":
      return await malformedOwnedInput(input);
    case "unsupported-operation":
      return await unsupportedOperation(input);
    case "stale-source":
      return await changedSourceRevision(input);
    case "privacy-denial":
      return await privacyDenial(input);
    case "permission-denial":
      return await permissionDenial(input);
    case "deadline":
      return await deadline(input);
    case "cancelled":
      return await cancelled(input);
    case "budget-refusal":
      return await budgetRefusal(input);
    case "internal-failure":
      return await internalFailure(input);
    case "missing-asset":
      return await missingAsset(input);
    case "decryption-failure":
      return await decryptionFailure(input);
    case "preparation-failure":
      return await preparationFailure(input);
    case "misleading-message":
      return await misleadingMessage(input);
  }
}

try {
  const result = await run(parseRequest(process.argv[2]));
  process.stdout.write(JSON.stringify(result));
  process.exitCode = 1;
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "candidate-failed");
  process.exitCode = 2;
}
