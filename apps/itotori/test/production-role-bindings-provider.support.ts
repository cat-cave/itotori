import { structuredProviderResponse } from "./llm-step-test-support.js";

type ReviewMode = "pass" | "cannot-assess";
type ProviderRole = "P1" | "Q1" | "Q2" | "Q3" | "Q4" | "Q5" | "Q6";
type ProviderCall = {
  readonly role: ProviderRole;
  readonly prompt: string;
  readonly response: unknown;
};

export function deterministicProvider(input: {
  readonly reviewMode: ReviewMode;
  readonly localizationSnapshotId?: string;
  readonly bibleRenderingId?: string;
  readonly voiceRenderingId?: string;
  /** Controlled P1 output only. Runtime evidence is always produced by native Utsushi. */
  readonly targetSkeleton?: string;
  /** Test-only transport hook. It observes a real provider request before this
   * deterministic HTTP seam returns its response; it never substitutes a role. */
  readonly beforeResponse?: (role: ProviderRole, request: Request) => void | Promise<void>;
}) {
  let localizationSnapshotId = input.localizationSnapshotId;
  let bibleRenderingId = input.bibleRenderingId;
  let voiceRenderingId = input.voiceRenderingId;
  const calls: ProviderCall[] = [];
  return {
    async fetcher(requestInput: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(requestInput, init);
      if (request.method === "GET") return new Response("{}", { status: 404 });
      const messages = requestMessages(await request.text());
      const role = providerRole(messages);
      const prompt = messages.join("\n");
      const response = providerResponse({
        role,
        messages,
        reviewMode: input.reviewMode,
        localizationSnapshotId,
        bibleRenderingId,
        voiceRenderingId,
        targetSkeleton: input.targetSkeleton,
      });
      if (role === "P1") {
        const seed = localizerSeed(messages);
        localizationSnapshotId = seed.localizationSnapshotId;
        bibleRenderingId ??= seed.bibleRenderingIds[0];
      }
      calls.push({ role, prompt, response });
      await input.beforeResponse?.(role, request);
      return structuredProviderResponse(response, 0.000001);
    },
    count(role: ProviderRole): number {
      return calls.filter((call) => call.role === role).length;
    },
    promptsFor(role: ProviderRole): readonly string[] {
      return calls.filter((call) => call.role === role).map((call) => call.prompt);
    },
    responsesFor(role: ProviderRole): readonly unknown[] {
      return calls.filter((call) => call.role === role).map((call) => call.response);
    },
    setLocalizationSnapshotId(value: string): void {
      localizationSnapshotId = value;
    },
    setBibleRenderingId(value: string): void {
      bibleRenderingId = value;
    },
    setVoiceRenderingId(value: string): void {
      voiceRenderingId = value;
    },
  };
}

function providerResponse(input: {
  readonly role: ProviderRole;
  readonly messages: readonly string[];
  readonly reviewMode: ReviewMode;
  readonly localizationSnapshotId: string | undefined;
  readonly bibleRenderingId: string | undefined;
  readonly voiceRenderingId: string | undefined;
  readonly targetSkeleton: string | undefined;
}): unknown {
  if (input.role === "P1") {
    return localizerOutput(localizerSeed(input.messages), input.reviewMode, input.targetSkeleton);
  }
  const snapshotId = requiredProviderValue(input.localizationSnapshotId, "localization snapshot");
  const bibleId = requiredProviderValue(input.bibleRenderingId, "Bible rendering");
  const unitId = promptUnitId(input.messages);
  if (input.role === "Q1" && input.reviewMode === "cannot-assess") {
    return cannotAssessVerdict("Q1", "meaning", unitId, snapshotId, bibleId);
  }
  if (input.role === "Q6") {
    return passVerdict("Q6", "adjudication", unitId, snapshotId, bibleId, [bibleId]);
  }
  if (input.role === "Q2") {
    const voiceId = requiredProviderValue(input.voiceRenderingId, "voice Bible rendering");
    return passVerdict("Q2", "voice", unitId, snapshotId, voiceId, [voiceId]);
  }
  if (input.role === "Q4") {
    return passVerdict("Q4", "continuity", unitId, snapshotId, bibleId, [unitId]);
  }
  if (input.role === "Q5") {
    return passVerdict(
      "Q5",
      "build-lqa",
      unitId,
      snapshotId,
      bibleId,
      q5EvidenceIds(input.messages),
    );
  }
  const evidenceId = input.role === "Q1" ? bibleId : unitId;
  const rubric = input.role === "Q1" ? "meaning" : "terminology";
  return passVerdict(input.role, rubric, unitId, snapshotId, bibleId, [evidenceId]);
}

function localizerOutput(
  seed: LocalizerSeed,
  reviewMode: ReviewMode,
  targetSkeleton: string | undefined,
): unknown {
  return {
    schemaVersion: "itotori.draft-batch.v1",
    localizationSnapshotId: seed.localizationSnapshotId,
    batchId: `batch:${seed.batchSuffix}`,
    scope: draftScope(seed.scope),
    drafts: seed.skeletons
      .filter((skeleton) => skeleton.role === "core")
      .map((skeleton) => ({
        unitId: skeleton.unitId,
        sourceHash: skeleton.sourceHash,
        targetSkeleton: targetSkeleton ?? "Proof.",
        evidenceIds: [skeleton.unitId],
        basis: { kind: seed.draftBasis, bibleRenderingIds: seed.bibleRenderingIds },
        uncertainty:
          reviewMode === "pass" && seed.draftBasis === "pure-mtl-ablation"
            ? ["none"]
            : ["referent"],
      })),
  };
}

function passVerdict(
  roleId: Exclude<ProviderRole, "P1">,
  rubric: "meaning" | "voice" | "terminology" | "continuity" | "build-lqa" | "adjudication",
  unitId: string,
  localizationSnapshotId: string,
  bibleId: string,
  evidenceIds: readonly string[],
): unknown {
  return {
    schemaVersion: "itotori.review-verdict.v1",
    reviewId: `review:${roleId}:${unitId}:provider-proof`,
    localizationSnapshotId,
    roleId,
    rubric,
    unitId,
    basis: { kind: "wiki-first", bibleRenderingIds: [bibleId] },
    verdict: "PASS",
    severity: "none",
    span: null,
    category: null,
    evidenceIds,
    repairConstraint: null,
  };
}

function cannotAssessVerdict(
  roleId: "Q1",
  rubric: "meaning",
  unitId: string,
  localizationSnapshotId: string,
  bibleId: string,
): unknown {
  return {
    schemaVersion: "itotori.review-verdict.v1",
    reviewId: `review:${roleId}:${unitId}:cannot-assess`,
    localizationSnapshotId,
    roleId,
    rubric,
    unitId,
    basis: { kind: "wiki-first", bibleRenderingIds: [bibleId] },
    verdict: "CANNOT_ASSESS",
    severity: "none",
    span: null,
    category: "insufficient-evidence",
    evidenceIds: [bibleId],
    repairConstraint: null,
    requestedEvidence: ["Need additional evidence."],
  };
}

type LocalizerSeed = {
  readonly localizationSnapshotId: string;
  readonly draftBasis: "wiki-first" | "pure-mtl-ablation";
  readonly bibleRenderingIds: readonly string[];
  readonly scope: unknown;
  readonly batchSuffix: string;
  readonly skeletons: readonly {
    readonly unitId: string;
    readonly role: "core" | "context";
    readonly sourceHash: string;
    readonly sourceSkeleton: string;
  }[];
};

function localizerSeed(messages: readonly string[]): LocalizerSeed {
  const encoded = messages.find((message) => message.includes('"kind":"localizer-seed"'));
  if (encoded === undefined) throw new Error("provider proof received no P1 seed");
  const value: unknown = JSON.parse(encoded);
  if (!isRecord(value)) throw new Error("provider proof P1 seed is not an object");
  const localizationSnapshotId = stringField(value, "localizationSnapshotId");
  const draftBasis = stringField(value, "draftBasis");
  if (draftBasis !== "wiki-first" && draftBasis !== "pure-mtl-ablation") {
    throw new Error("provider proof P1 seed has an unknown basis");
  }
  const scope = value.scope;
  const skeletonValues = arrayField(value, "skeletons");
  return {
    localizationSnapshotId,
    draftBasis,
    bibleRenderingIds: stringArrayField(value, "bibleRenderingIds"),
    scope,
    batchSuffix: scopeBatchSuffix(scope),
    skeletons: skeletonValues.map((candidate) => {
      if (!isRecord(candidate)) throw new Error("provider proof P1 skeleton is not an object");
      const role = stringField(candidate, "role");
      if (role !== "core" && role !== "context") throw new Error("provider proof P1 skeleton role");
      return {
        unitId: stringField(candidate, "unitId"),
        role,
        sourceHash: stringField(candidate, "sourceHash"),
        sourceSkeleton: stringField(candidate, "sourceSkeleton"),
      };
    }),
  };
}

function scopeBatchSuffix(scope: unknown): string {
  if (!isRecord(scope)) throw new Error("provider proof P1 scope is not an object");
  return stringField(scope, "sceneId").replace(/[^A-Za-z0-9._-]/gu, "-");
}

function draftScope(segment: unknown): unknown {
  if (!isRecord(segment)) throw new Error("provider proof P1 scope is not an object");
  const mode = stringField(segment, "mode");
  if (mode === "whole-scene") {
    return {
      kind: "whole-scene",
      sceneId: stringField(segment, "sceneId"),
      expectedUnitIds: stringArrayField(segment, "unitIds"),
    };
  }
  if (mode === "overlapping-chunk") {
    return {
      kind: "overlapping-chunk",
      sceneId: stringField(segment, "sceneId"),
      chunkIndex: numberField(segment, "chunkIndex"),
      chunkCount: numberField(segment, "chunkCount"),
      coreUnitIds: stringArrayField(segment, "coreUnitIds"),
      overlapUnitIds: stringArrayField(segment, "overlapUnitIds"),
    };
  }
  throw new Error("provider proof P1 scope has an unknown mode");
}

function requestMessages(body: string): readonly string[] {
  const value: unknown = JSON.parse(body);
  if (!isRecord(value)) throw new Error("provider proof request is not an object");
  return arrayField(value, "messages").flatMap((message) => {
    if (!isRecord(message) || typeof message.content !== "string") return [];
    return [message.content];
  });
}

function providerRole(messages: readonly string[]): ProviderRole {
  const prompt = messages.join("\n");
  if (prompt.includes('"kind":"localizer-seed"')) return "P1";
  if (prompt.includes("MEANING PRESERVATION")) return "Q1";
  if (prompt.includes("VOICE and REGISTER CONTINUITY")) return "Q2";
  if (prompt.includes("CONTEXTUAL SENSE and REGISTER")) return "Q3";
  if (prompt.includes("CONTINUITY only: callback")) return "Q4";
  if (prompt.includes("RESIDUAL TRANSLATION QUALITY AS IT APPEARS ON SCREEN")) return "Q5";
  if (prompt.includes("genuine subjective conflict")) return "Q6";
  throw new Error("provider proof received an unexpected role prompt");
}

function q5EvidenceIds(messages: readonly string[]): readonly string[] {
  const prompt = messages.join("\n");
  const frame = /^FRAME: ([^\s]+)/mu.exec(prompt)?.[1];
  const accepted = /^EXPECTED ACCEPTED TARGET \(([^)]+)\):$/mu.exec(prompt)?.[1];
  if (frame === undefined || accepted === undefined) {
    throw new Error("provider proof Q5 prompt has no frame/accepted evidence ids");
  }
  return [frame, accepted];
}

function promptUnitId(messages: readonly string[]): string {
  const match = /^(?:UNIT|UNIT UNDER REVIEW \(the USE site\)): ([^\n]+)$/mu.exec(
    messages.join("\n"),
  );
  if (match?.[1] === undefined) throw new Error("provider proof review prompt has no unit id");
  return match[1];
}

function requiredProviderValue(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) throw new Error(`provider proof has no ${label}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") throw new Error(`provider proof field ${field} is not text`);
  return candidate;
}

function numberField(value: Record<string, unknown>, field: string): number {
  const candidate = value[field];
  if (typeof candidate !== "number")
    throw new Error(`provider proof field ${field} is not numeric`);
  return candidate;
}

function arrayField(value: Record<string, unknown>, field: string): readonly unknown[] {
  const candidate = value[field];
  if (!Array.isArray(candidate)) throw new Error(`provider proof field ${field} is not an array`);
  return candidate;
}

function stringArrayField(value: Record<string, unknown>, field: string): readonly string[] {
  return arrayField(value, field).map((candidate) => {
    if (typeof candidate !== "string")
      throw new Error(`provider proof field ${field} has non-text`);
    return candidate;
  });
}
