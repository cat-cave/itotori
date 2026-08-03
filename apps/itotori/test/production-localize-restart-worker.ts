import { assertBridgeBundleV02, type BridgeBundleV02 } from "@itotori/localization-bridge-schema";

import { runLocalizeCommand, type LocalizeCommandDeps } from "../src/cli/localize-command.js";
import { withDatabaseItotoriServices } from "../src/services/database-services.js";
import { deterministicProvider } from "./production-role-bindings-provider.support.js";
import { CLEAN_Q5_TARGET } from "./production-role-bindings-reallive-fixture.support.js";

const ROLE_IDS = ["P1", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6"] as const;
type ProviderRole = (typeof ROLE_IDS)[number];

type WorkerInput = {
  readonly phase: "interrupt" | "resume";
  readonly databaseUrl: string;
  readonly projectId: string;
  readonly runId: string;
  readonly localeBranchId: string;
  readonly sourceRoot: string;
  readonly buildRoot: string;
  readonly backgroundAsset: string;
  readonly structureJson: unknown;
  readonly bridge: BridgeBundleV02;
  readonly localizationSnapshotId: string;
  readonly bibleRenderingId: string;
  readonly voiceRenderingId: string;
};

type WorkerMessage =
  | { readonly kind: "ready-to-kill"; readonly calls: ProviderCallCounts }
  | { readonly kind: "completed"; readonly calls: ProviderCallCounts }
  | { readonly kind: "error"; readonly message: string };

export async function runProductionLocalizeRestartWorker(inputValue: unknown): Promise<void> {
  const input = parseWorkerInput(inputValue);
  let pauseReported = false;
  const transport = deterministicProvider({
    reviewMode: "pass",
    targetSkeleton: CLEAN_Q5_TARGET,
    beforeResponse: async (role) => {
      // Pause each concurrent Q1–Q4 request at the existing deterministic HTTP
      // transport seam. P1 is already durable; no review can finish before the
      // parent kills this production child.
      if (input.phase !== "interrupt" || !isInterruptReview(role)) return;
      if (!pauseReported) {
        pauseReported = true;
        send({ kind: "ready-to-kill", calls: providerCallCounts(transport) });
      }
      await new Promise<never>(() => undefined);
    },
  });
  transport.setLocalizationSnapshotId(input.localizationSnapshotId);
  transport.setBibleRenderingId(input.bibleRenderingId);
  transport.setVoiceRenderingId(input.voiceRenderingId);
  const outputs = new Map<string, unknown>();

  try {
    await withDatabaseItotoriServices(
      { databaseUrl: input.databaseUrl, providerFetcher: transport.fetcher },
      async (services) => {
        const deps: LocalizeCommandDeps = {
          io: {
            readJson(path: string): unknown {
              if (path === "restart-structure.json") return input.structureJson;
              if (path === "restart-bridge.json") return input.bridge;
              throw new Error(`restart worker received an unexpected input path ${path}`);
            },
            writeJson(path: string, value: unknown): void {
              outputs.set(path, value);
            },
          },
          projectWorkflow: services.projectWorkflow,
          resolvePortSource: async (request, perRun) =>
            await services.localizationSubstrate.resolvePortSource(request, perRun),
          localizeRunTrackerTiming: {
            // The interrupted owner must expire promptly; the replacement gets
            // a normal-lived test lease while it completes Q1–Q5 and patchback.
            leaseDurationSeconds: input.phase === "interrupt" ? 1 : 30,
            leaseRenewalIntervalMs: input.phase === "interrupt" ? 10_000 : 1_000,
          },
        };
        await runLocalizeCommand(commandArgs(input), deps);
      },
    );
    send({
      kind: "completed",
      calls: providerCallCounts(transport),
    });
  } catch (error: unknown) {
    send({ kind: "error", message: errorMessage(error) });
    throw error;
  }
}

function commandArgs(input: WorkerInput): readonly string[] {
  return [
    "localize",
    "--run-mode",
    "production",
    "--project-id",
    input.projectId,
    "--run-id",
    input.runId,
    "--locale-branch-id",
    input.localeBranchId,
    "--target-locale",
    "en-US",
    "--source-root",
    input.sourceRoot,
    "--build-root",
    input.buildRoot,
    "--runtime-background-asset",
    input.backgroundAsset,
    "--structure",
    "restart-structure.json",
    "--bridge",
    "restart-bridge.json",
    "--output",
    "restart-summary.json",
  ];
}

function providerCallCounts(
  transport: ReturnType<typeof deterministicProvider>,
): ProviderCallCounts {
  return {
    P1: transport.count("P1"),
    Q1: transport.count("Q1"),
    Q2: transport.count("Q2"),
    Q3: transport.count("Q3"),
    Q4: transport.count("Q4"),
    Q5: transport.count("Q5"),
    Q6: transport.count("Q6"),
  };
}

function isInterruptReview(role: ProviderRole): boolean {
  return role === "Q1" || role === "Q2" || role === "Q3" || role === "Q4";
}

type ProviderCallCounts = Record<ProviderRole, number>;

function send(message: WorkerMessage): void {
  if (process.send === undefined) throw new Error("restart worker has no IPC channel");
  process.send(message);
}

function parseWorkerInput(value: unknown): WorkerInput {
  if (!isRecord(value)) throw new Error("restart worker input must be an object");
  const phase = text(value, "phase");
  if (phase !== "interrupt" && phase !== "resume") {
    throw new Error("restart worker phase is invalid");
  }
  const bridge = value.bridge;
  assertBridgeBundleV02(bridge);
  return {
    phase,
    databaseUrl: text(value, "databaseUrl"),
    projectId: text(value, "projectId"),
    runId: text(value, "runId"),
    localeBranchId: text(value, "localeBranchId"),
    sourceRoot: text(value, "sourceRoot"),
    buildRoot: text(value, "buildRoot"),
    backgroundAsset: text(value, "backgroundAsset"),
    structureJson: value.structureJson,
    bridge,
    localizationSnapshotId: text(value, "localizationSnapshotId"),
    bibleRenderingId: text(value, "bibleRenderingId"),
    voiceRenderingId: text(value, "voiceRenderingId"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`restart worker ${field} must be non-empty text`);
  }
  return candidate;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
