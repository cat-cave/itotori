import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

import {
  AuthorizationError,
  HelperPreparationError,
  ItotoriProjectRunCostCapError,
  ProtectedAssetDecryptionError,
  permissionValues,
  type HelperPreparationFailureKind,
} from "@itotori/db";
import { apiMutationPermissionGates } from "../../../apps/itotori/src/api-handler-contracts.js";
import { requireApiPermission } from "../../../apps/itotori/src/api-handler-shared.js";
import {
  assertWebEgressAllowed,
  WEB_SEARCH_EGRESS_ROLE,
} from "../../../apps/itotori/src/egress/policy.js";
import { applicationFailureResponse } from "../../../apps/itotori/src/explicit-failure/response.js";
import { LlmPhysicalAttemptError } from "../../../apps/itotori/src/llm/physical-attempt-policy.js";
import { PatchRuntimeLaunchError } from "../../../apps/itotori/src/play/runtime-launcher-registry.js";
import {
  errorName,
  projectFailureWithEffects as project,
  sourceErrorCode,
  type CandidateRequest,
  type CandidateResult,
} from "./explicit-failure-candidate-support.js";
import { OperationEffectBoundary } from "./explicit-failure-effects.js";

function invokePersistedOperation(rawFailure: string): string {
  throw new Error(rawFailure);
}

function invokeLocalizationOutcome(): string {
  throw new PatchRuntimeLaunchError(
    "runtime_failed",
    "permission denial after provider timeout and missing input",
  );
}

export async function privacyDenial(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(input.operationOutputRoot, "published-evidence.json");
  let policyChecks = 0;
  let caught: unknown;
  try {
    policyChecks += 1;
    assertWebEgressAllowed(WEB_SEARCH_EGRESS_ROLE, {
      operatorEnabled: false,
      qualifyingRun: false,
    });
    effects.commit('{"published":true}');
  } catch (error) {
    caught = error;
  }
  return await project(
    caught,
    { errorName: errorName(caught), errorCode: sourceErrorCode(caught), policyChecks },
    true,
    effects,
  );
}

export async function permissionDenial(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(input.operationOutputRoot, "admin-action.json");
  const actor = { userId: "behavior-operator" };
  let permissionChecks = 0;
  let caught: unknown;
  try {
    await requireApiPermission(
      {
        authorization: {
          async requirePermission(permission) {
            permissionChecks += 1;
            throw new AuthorizationError(actor, permission);
          },
        },
      },
      apiMutationPermissionGates.permissionSetsList,
    );
    effects.commit('{"administered":true}');
  } catch (error) {
    caught = error;
  }
  return await project(
    caught,
    {
      errorName: errorName(caught),
      permission: permissionValues.authPermissionsManage,
      permissionChecks,
    },
    true,
    effects,
  );
}

export async function deadline(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(input.operationOutputRoot, "deadline-response.bin");
  let providerRequests = 0;
  let requestObserved = (): void => {};
  const pendingRequest = new Promise<void>((done) => {
    requestObserved = done;
  });
  const provider = createServer(() => {
    providerRequests += 1;
    requestObserved();
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const address = provider.address();
  if (address === null || typeof address === "string") throw new Error("deadline-bind");
  let abortName = "";
  try {
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${address.port}/pending`, {
      signal: controller.signal,
    }).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    await pendingRequest;
    controller.abort(new DOMException("declared deadline reached", "TimeoutError"));
    const outcome = await pending;
    if ("error" in outcome) {
      abortName = errorName(outcome.error);
    } else {
      effects.commit(new Uint8Array(await outcome.response.arrayBuffer()));
    }
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
  }
  return await project(
    new LlmPhysicalAttemptError({
      classification: "transient",
      kind: "deadline",
      httpStatus: null,
      retryAfterMs: null,
    }),
    { providerRequests, pendingObserved: providerRequests === 1, abortName },
    true,
    effects,
  );
}

export async function cancelled(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(
    input.operationOutputRoot,
    "cancellation-result.json",
  );
  const controller = new AbortController();
  const worker = new Promise<string>((done) => {
    controller.signal.addEventListener("abort", () => done("cancelled"), { once: true });
  });
  controller.abort();
  const workerOutcome = await worker;
  writeFileSync(
    resolve(input.scratchRoot, "cancelled-state.json"),
    JSON.stringify({ state: "cancelled", transition: 1 }),
  );
  if (workerOutcome !== "cancelled") effects.commit('{"completed":true}');
  return await project(
    new LlmPhysicalAttemptError({
      classification: "cancelled",
      kind: "cancelled",
      httpStatus: null,
      retryAfterMs: null,
    }),
    { workerOutcome },
    true,
    effects,
  );
}

export async function budgetRefusal(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(
    input.operationOutputRoot,
    "budgeted-localization.json",
  );
  const cap = 100;
  const spent = 35;
  const reserved = 25;
  const requested = 41;
  const remaining = Math.max(0, cap - spent - reserved);
  let caught: unknown;
  if (requested > remaining) {
    caught = new ItotoriProjectRunCostCapError(cap, spent, reserved, requested);
  } else {
    effects.commit('{"localized":true}');
  }
  return await project(caught, { cap, spent, reserved, requested, remaining }, true, effects);
}

export async function internalFailure(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(
    input.operationOutputRoot,
    "persisted-operation.json",
  );
  const raw = "private /owned/source.dat token do-not-display";
  let caught: unknown;
  try {
    effects.commit(invokePersistedOperation(raw));
  } catch (error) {
    caught = error;
  }
  const result = await project(caught, {}, true, effects);
  return { ...result, facts: { ...result.facts, rawLeaked: JSON.stringify(result).includes(raw) } };
}

export async function missingAsset(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(
    input.operationOutputRoot,
    "restored-runtime-asset.bin",
  );
  let fileError: unknown;
  let bytesRead = 0;
  try {
    const bytes = readFileSync(resolve(input.scratchRoot, "absent-runtime-asset.bin"));
    bytesRead = bytes.length;
    effects.commit(bytes);
  } catch (error) {
    fileError = error;
  }
  const source = new PatchRuntimeLaunchError("runtime_assets_missing", "required asset absent");
  return await project(
    source,
    { fileErrorCode: sourceErrorCode(fileError), bytesRead },
    false,
    effects,
  );
}

export async function decryptionFailure(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(
    input.operationOutputRoot,
    "decrypted-runtime-asset.bin",
  );
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update("protected bytes", "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrongKey = Buffer.from(key);
  wrongKey[0] = (wrongKey[0] ?? 0) ^ 1;
  let authenticationFailed = false;
  try {
    const decipher = createDecipheriv("aes-256-gcm", wrongKey, iv);
    decipher.setAuthTag(tag);
    effects.commit(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    authenticationFailed = true;
  }
  return await project(
    new ProtectedAssetDecryptionError("protected-runtime-asset"),
    { algorithm: "aes-256-gcm", stagedBytes: ciphertext.length, authenticationFailed },
    false,
    effects,
  );
}

export async function preparationFailure(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(input.operationOutputRoot, "prepared-source.bin");
  const approved = Buffer.from("approved-helper", "utf8");
  const staged = Buffer.from("tampered-helper", "utf8");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const closed = new Promise<NodeJS.Signals | null>((done) =>
    child.once("close", (_code, signal) => done(signal)).once("error", () => done(null)),
  );
  child.kill("SIGTERM");
  const cancellationSignal = await closed;
  const timed = spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeout: 20,
  });
  const approvedRegistry = new Set<string>();
  let caught: unknown;
  try {
    if (!approved.equals(staged)) throw new HelperPreparationError("identity-mismatch");
    effects.commit(staged);
  } catch (error) {
    caught = error;
  }
  const kinds: readonly HelperPreparationFailureKind[] = [
    "identity-mismatch",
    "input-too-large",
    "deadline-reached",
    "cancelled",
    "not-approved",
  ];
  const classifications = kinds.map(
    (kind) => applicationFailureResponse(new HelperPreparationError(kind)).classification,
  );
  return await project(
    caught,
    {
      identityMismatch: !approved.equals(staged),
      oversized: Buffer.alloc(17).length > 16,
      deadlineSignal: timed.signal,
      cancellationSignal,
      approvedRegistryContainsHelper: approvedRegistry.has("behavior-helper"),
      helperSourceCodes: classifications.map((entry) => entry.code),
      helperNextActions: classifications.map((entry) => entry.nextAction),
    },
    false,
    effects,
  );
}

export async function misleadingMessage(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(input.operationOutputRoot, "localized-output.json");
  let caught: unknown;
  try {
    effects.commit(invokeLocalizationOutcome());
  } catch (error) {
    caught = error;
  }
  return await project(caught, { messageNamesOtherClasses: true }, true, effects);
}
