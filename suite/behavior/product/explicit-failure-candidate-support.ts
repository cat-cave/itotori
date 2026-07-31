import { createServer } from "node:http";

import type { ExplicitFailureClassification } from "@itotori/db";
import { errorResponse } from "../../../apps/itotori/src/api-handler-responses.js";
import { applicationFailureResponse } from "../../../apps/itotori/src/explicit-failure/response.js";
import type { OperationEffectBoundary } from "./explicit-failure-effects.js";

export type Probe =
  | "missing-input"
  | "provider-unavailable"
  | "unsupported-profile"
  | "malformed-input"
  | "unsupported-operation"
  | "stale-source"
  | "privacy-denial"
  | "permission-denial"
  | "deadline"
  | "cancelled"
  | "budget-refusal"
  | "internal-failure"
  | "missing-asset"
  | "decryption-failure"
  | "preparation-failure"
  | "misleading-message";

export interface CandidateRequest {
  readonly probe: Probe;
  readonly repositoryRoot: string;
  readonly scratchRoot: string;
  readonly operationOutputRoot: string;
  readonly httpBoundary: boolean;
}

export interface CandidateResult {
  readonly disposition: "failed" | "paused";
  readonly failureClass: string;
  readonly diagnostic: string;
  readonly sourceCode: string;
  readonly nextAction: string;
  readonly httpStatus: number;
  readonly apiCode: string;
  readonly facts: Record<string, unknown>;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

export function sourceErrorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "";
}

export async function projectFailure(
  error: unknown,
  facts: Record<string, unknown>,
  httpBoundary: boolean,
): Promise<CandidateResult> {
  const response = applicationFailureResponse(error);
  const wire = httpBoundary ? await httpRoundTrip(error) : null;
  const classification: ExplicitFailureClassification = response.classification;
  return {
    disposition: classification.disposition,
    failureClass: classification.failureClass,
    diagnostic: classification.diagnosticOutcome,
    sourceCode: classification.code,
    nextAction: classification.nextAction,
    httpStatus: response.statusCode,
    apiCode: response.apiCode,
    facts: {
      ...facts,
      ...(response.remainingAllowanceMicrosUsd === undefined
        ? {}
        : { remainingAllowanceMicrosUsd: response.remainingAllowanceMicrosUsd }),
      ...(response.incidentReference === undefined
        ? {}
        : { incidentReference: response.incidentReference }),
      ...(wire === null ? {} : { wire }),
    },
  };
}

export async function projectFailureWithEffects(
  error: unknown,
  facts: Record<string, unknown>,
  httpBoundary: boolean,
  effects: OperationEffectBoundary,
): Promise<CandidateResult> {
  const result = await projectFailure(error, facts, httpBoundary);
  return {
    ...result,
    facts: { ...result.facts, operationEffects: effects.observe() },
  };
}

async function httpRoundTrip(error: unknown): Promise<Record<string, unknown>> {
  const server = createServer((_request, outgoing) => {
    const response = errorResponse(error);
    const body = JSON.stringify(response.body);
    outgoing.writeHead(response.statusCode, {
      "content-length": Buffer.byteLength(body),
      "content-type": "application/json",
    });
    outgoing.end(body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("candidate-http-bind");
  let response: Response;
  let bytes: string;
  try {
    response = await fetch(`http://127.0.0.1:${address.port}/failure`, { method: "POST" });
    bytes = await response.text();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error === undefined ? done() : reject(error))),
    );
  }
  const body: unknown = JSON.parse(bytes);
  if (!isRecord(body)) throw new Error("candidate-http-body");
  return { status: response.status, responseBytes: Buffer.byteLength(bytes), code: body.code };
}
