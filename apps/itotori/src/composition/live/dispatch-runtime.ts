// The live ZDR dispatch runtime — the shared substrate object every model-calling
// role binds to reach the SOLE dispatch boundary (`../../llm/dispatch.ts`).
//
// A role (P1/P2/P3/Q6) owns its own `CallSpec` + plaintext payloads and supplies
// its own `readPayload`; this runtime carries the SHARED live substrate the
// boundary needs and nothing role-specific: the durable physical-step memo
// (single-flight + attempt ledger over Postgres via `LlmCallMemoStore`), the
// permission-gated content-read authorizer, the measured model profile, the spend
// admission, and the run's snapshot revision hashes. It NEVER names a provider —
// the provider policy travels on the certified role `CallSpec`, and the served
// (model, provider) pair is recorded post-request from OpenRouter's generation
// lookup as output telemetry on the `CallResult`.
//
// `LocalizerRuntimeBase`, `EditorRuntimeBase`, and `RepairRuntimeBase` are each
// `Omit<DispatchRuntime, "readPayload">`, so this ONE object satisfies all three
// role runtime bases (it backs `DraftDeps.runtime`, `RepairDeps.editRuntime`, and
// `RepairDeps.repairRuntime`). `createCertifiedDispatch` closes it over a payload
// resolver to form the `Q6Dispatch` seam the adjudication port dispatches through.

import type { LlmCallMemoStore, LlmContentReadAuthorizer } from "@itotori/db";
import type { CallResult, CallSpec, EncryptedPayloadRef } from "../../contracts/index.js";
import { dispatch, type DispatchRuntime, type DispatchTool } from "../../llm/dispatch.js";
import {
  createOpenRouterGenerationLookup,
  type GenerationLookup,
} from "../../llm/generation-metadata.js";
import type { MeasuredModelProfile, RetryRuntime } from "../../llm/physical-attempt-policy.js";
import type { PhysicalStepMemoRuntime } from "../../llm/physical-step-memo.js";
import type { ReasoningDetailsContinuityEvidence } from "../../llm/reasoning-details-continuity.js";

/** The dispatch runtime minus the role-owned `readPayload` — structurally exactly
 * `LocalizerRuntimeBase` / `EditorRuntimeBase` / `RepairRuntimeBase`. */
export type DispatchRuntimeBase = Omit<DispatchRuntime, "readPayload">;

/** The run's snapshot revision hashes the durable memo keys every physical step
 * to (decode / glossary / style + the accepted-output head). */
export type RunSnapshotRevisions = PhysicalStepMemoRuntime["snapshots"];

/** The live substrate a dispatch runtime carries. All fields are already-built
 * pieces; the runtime just assembles them into the boundary's shape. */
export interface LiveDispatchRuntimeConfig {
  /** The durable single-flight + physical-attempt ledger (Postgres-backed). */
  readonly memoStore: LlmCallMemoStore;
  /** The permission-gated content-read authorizer the boundary calls per payload. */
  readonly contentAccess: LlmContentReadAuthorizer;
  /** The measured model profile (deadlines + per-attempt exposure ceiling). */
  readonly profile: MeasuredModelProfile;
  /** The confirmed spend admission this run's calls draw against. */
  readonly admission: { readonly scope: string; readonly confirmedCostCapUsd: string };
  /** The run snapshot revision hashes the memo keys bind to. */
  readonly snapshots: RunSnapshotRevisions;
  /** The tools the role may fan out to; drafting/editing use none. */
  readonly tools?: readonly DispatchTool[];
  /** Transport injection — production omits it (real `fetch`); a proof records. */
  readonly fetcher?: DispatchRuntime["fetcher"];
  /** Optional test/integration seam for post-request served-pair reconciliation. */
  readonly generationLookup?: GenerationLookup;
  /** Environment for the ZDR startup policy + API key; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Run-scoped cancellation. */
  readonly signal?: AbortSignal;
  /** Deterministic retry seam (jitter/sleep) for the physical-attempt policy. */
  readonly retry?: Partial<RetryRuntime>;
  /** Reasoning-details continuity evidence sink (audit-only). */
  readonly onReasoningDetailsContinuity?: (evidence: ReasoningDetailsContinuityEvidence) => void;
}

/** Assemble the live dispatch runtime base. The returned object is passed to a
 * role's `dispatch*Call(call, runtime)` in EVERY run mode (including test-dev);
 * the role adds its own `readPayload` and the boundary certifies the route. */
export function createDispatchRuntime(config: LiveDispatchRuntimeConfig): DispatchRuntimeBase {
  const memo: PhysicalStepMemoRuntime = {
    store: config.memoStore,
    profile: config.profile,
    admission: config.admission,
    snapshots: config.snapshots,
    ...(config.signal ? { signal: config.signal } : {}),
    ...(config.retry ? { retry: config.retry } : {}),
  };
  const env = config.env ?? process.env;
  const apiKey = env.OPENROUTER_API_KEY;
  const generationLookup =
    config.generationLookup ??
    (apiKey === undefined || apiKey.length === 0
      ? undefined
      : createOpenRouterGenerationLookup({
          apiKey,
          ...(config.fetcher ? { fetcher: config.fetcher } : {}),
        }));
  return {
    tools: config.tools ?? [],
    contentAccess: config.contentAccess,
    memo,
    ...(config.fetcher ? { fetcher: config.fetcher } : {}),
    ...(config.env ? { env: config.env } : {}),
    ...(generationLookup ? { generationLookup } : {}),
    ...(config.onReasoningDetailsContinuity
      ? { onReasoningDetailsContinuity: config.onReasoningDetailsContinuity }
      : {}),
  };
}

/** Resolve a role's own plaintext payloads, keyed by their sealed storage ref. */
export type PayloadResolver = (reference: EncryptedPayloadRef) => Promise<string>;

/** The certified provider-free dispatch seam — a `CallSpec` → `CallResult`
 * function that routes through the sole ZDR boundary. Backs the `Q6Dispatch`
 * adjudication seam (whose specs seal their own payloads via `sealPayload`, so the
 * caller supplies the matching `readPayload` resolver). */
export type CertifiedDispatch = (spec: CallSpec) => Promise<CallResult>;

/** Close the base runtime over a payload resolver to form the certified dispatch
 * seam. No provider is named here; the certified route lives on the spec. */
export function createCertifiedDispatch(
  base: DispatchRuntimeBase,
  readPayload: PayloadResolver,
): CertifiedDispatch {
  return (spec) => dispatch(spec, { ...base, readPayload });
}
