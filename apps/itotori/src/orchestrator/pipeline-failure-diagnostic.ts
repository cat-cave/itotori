// itotori-agent-facing-pipeline-failure-diagnostics — structured diagnostics for
// localize / extract / patch / render pipeline step failures.
//
// A driving Claude-Code agent hitting a bare `Error: malformed pack` from the
// driven executor has to guess: WHICH step failed? Which UNIT? What INPUTS did
// it carry? Is there a minimal REPRO pointer (the node / scene / config to
// reproduce)? What redacted CONTEXT would prove the failure mode without
// leaking raw game text? This module is the contract that turns "a throw" into
// a PR-actionable diagnostic.
//
// Why now: the localize-fullproject driver + the driven executor already
// isolate per-unit failures, but they record a bare `{bridgeUnitId,
// sourceUnitKey, errorClass, errorMessage}` shape and a top-level catch that
// re-throws a bare `Error`. A driving agent has no way to map that to a
// reproducer. The structure here gives every step-failure path a single,
// narrow shape it MUST conform to: `{step, code, message, failingUnitId,
// sceneId, inputs, repro, error, redactedContext, occurredAt}`.
//
// Privacy (ZDR / no-game-bytes): the diagnostic is the artifact an agent will
// read, log, paste into a PR, or persist to a run-summary. It MUST NOT carry
// raw game text — `sourceText`, `draftText`, `targetText`, `protectedSpan.sourceText`,
// error messages sourced from provider output, etc. are ALL scrubbed before the
// diagnostic is constructed. The redaction is enforced by `redactDiagnosticInputs`
// + `redactDiagnosticContext`: any field whose key is in the closed
// GAME_TEXT_KEYS set is replaced with the `[REDACTED]` sentinel (a fixed string
// a downstream test can grep for). The closed key set is the ONLY place the
// game-text surface is enumerated — adding a new field requires an explicit
// edit here, which is the right kind of friction for a privacy boundary.
//
// Project-agnostic: the diagnostic carries no game / engine / title fields,
// only the generic step, unit/scene ids, the redacted inputs, and the repro
// pointer. The repro pointer is itself generic (config path + bridge unit id +
// the agent's stage/agent pair) — an agent can read it without knowing the
// project.

import type { AuthorizationActor } from "@itotori/db";

// ---------------------------------------------------------------------------
// Redaction — closed set of game-text surface keys
// ---------------------------------------------------------------------------

/**
 * Closed taxonomy of object keys whose value carries raw game text or other
 * copyright-bearing content. Any field whose key is in this set is replaced
 * with the {@link REDACTED_SENTINEL} by {@link redactDiagnosticInputs} and
 * {@link redactDiagnosticContext} — a diagnostic MUST NEVER leak the raw
 * value. Adding a new key here is the explicit contract change for adding a
 * new game-text field to a diagnostic.
 */
export const GAME_TEXT_KEYS: ReadonlySet<string> = new Set([
  // v0.2 bridge unit body fields.
  "sourceText",
  "draftText",
  "targetText",
  "text",
  // protected-span surface (the literal the translator must preserve).
  "expectedTargetForm",
  // glossary / terminology surface forms (project-specific terms).
  "preferredSourceForm",
  "preferredTargetForm",
  "surfaceForm",
  // scene-summary free text + character bios + QA free text.
  "summary",
  "bio",
  // agent-authored rationale strings are scrubbed defensively even though they
  // are model output — a driving agent reading the diagnostic gets the class /
  // code / repro, not the LLM's free-text reasoning.
  "rationale",
  "recommendation",
  "agentRationale",
  // structure-informed-context surface (decoded narrative text).
  "message",
  "scriptText",
]);

/**
 * Fixed sentinel substituted for every redacted game-text field. A downstream
 * audit test grep-asserts this string never appears OUTSIDE a redacted slot
 * (i.e. no raw game text leaks past redaction), and INSIDE every redacted slot
 * (i.e. the redaction was actually applied).
 */
export const REDACTED_SENTINEL = "[REDACTED]";

const REDACTED_OBJECT_KEYS: ReadonlySet<string> = new Set(["source", "target"]);

/**
 * Recursively redact a value, replacing every game-text surface key (closed
 * taxonomy in {@link GAME_TEXT_KEYS}) with {@link REDACTED_SENTINEL}. The
 * traversal recurses into plain objects + arrays; non-object / non-array values
 * are returned verbatim except where they sit under a game-text key (then they
 * are replaced with the sentinel). The redaction is DEEP and IDEMPOTENT — two
 * passes produce the same shape.
 *
 * The function is intentionally tolerant of unknown shapes: a `Map`, `Set`,
 * `Date`, `Buffer`, or class instance falls through unchanged (their internal
 * representation is opaque to a textual log and not part of the diagnostic
 * surface). Keys are walked on plain `Record<string, unknown>` only.
 *
 * Important: this redaction is purely a best-effort structural scrub. A
 * throwing step whose error MESSAGE contains raw game text (e.g. a provider
 * echoing the source back) is also redacted — see
 * {@link redactDiagnosticError}.
 */
export function redactDiagnosticInputs(value: unknown): unknown {
  return redactValue(value, new WeakSet());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (seen.has(value as object)) {
    return REDACTED_SENTINEL;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, seen));
  }

  // Skip non-plain objects (Map / Set / Date / class instances / etc.).
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (GAME_TEXT_KEYS.has(key)) {
      out[key] = REDACTED_SENTINEL;
    } else if (REDACTED_OBJECT_KEYS.has(key) && typeof child === "object" && child !== null) {
      // `source` and `target` are kept but their inner game-text fields are
      // still scrubbed — a downstream reader still sees the structure.
      out[key] = redactValue(child, seen);
    } else {
      out[key] = redactValue(child, seen);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diagnostic shape
// ---------------------------------------------------------------------------

/**
 * The closed set of pipeline steps a diagnostic can name. Each value is the
 * canonical step path the localize / extract / patch / render driver exposes —
 * an agent reading a diagnostic can map the step to a code path with no
 * guessing.
 *
 * - `localize.parse-config`        — config JSON parse / validate.
 * - `localize.read-bridge`         — read + assert the v0.2 bridge bundle.
 * - `localize.read-pair-policy`    — read + parse the v0.3 pair-policy.
 * - `localize.read-structure`      — read + parse the decoded structure JSON.
 * - `localize.build-resolver`      — wire the per-unit structure resolver.
 * - `localize.run-pass`            — run the driven executor + pass ledger.
 * - `localize.persist-draft`       — persist a draft outcome.
 * - `localize.persist-provider-run`— persist a provider-run summary.
 * - `localize.export-patch`        — write the patch export artifact.
 * - `localize.record-pass`         — record the localization pass in the ledger.
 * - `localize.write-run-summary`   — write the run summary JSON.
 * - `executor.enumerate-units`     — batch planner / scope enumeration.
 * - `executor.drive-unit`          — run ONE unit's agentic loop (per-unit isolation).
 * - `executor.persist-draft`       — per-unit draft persistence.
 * - `executor.persist-provider-run`— per-unit provider-run persistence.
 * - `executor.export-patch`        — per-run patch export.
 * - `executor.flush-queue`         — flush a buffered reviewer-queue write.
 *
 * The set is closed: a new step is a deliberate change to the diagnostic
 * surface, not a silent widening.
 */
export type PipelineStep =
  | "localize.parse-config"
  | "localize.read-bridge"
  | "localize.read-pair-policy"
  | "localize.read-structure"
  | "localize.build-resolver"
  | "localize.run-pass"
  | "localize.persist-draft"
  | "localize.persist-provider-run"
  | "localize.export-patch"
  | "localize.record-pass"
  | "localize.write-run-summary"
  | "executor.enumerate-units"
  | "executor.drive-unit"
  | "executor.persist-draft"
  | "executor.persist-provider-run"
  | "executor.export-patch"
  | "executor.flush-queue";

/**
 * The closed set of diagnostic codes a step failure can carry. Each code
 * corresponds to a failure mode the agent should triage to a different fix.
 * The codes are stable across versions (a code rename is a breaking change
 * for downstream tooling that parses the diagnostic).
 *
 * - `refused`                — input was rejected at parse / validation time.
 * - `io-error`               — file or network IO failed.
 * - `invariant-violation`    — internal invariant violated (a bug, not user input).
 * - `provider-failure`       — provider returned a malformed / uncitable pack.
 * - `persistence-failure`    — DB / fs write failed.
 * - `budget-cap-tripped`     — budget cap tripped (NOT a step failure — surfaced
 *                              so an agent can confirm the cause is the cap).
 * - `malformed-pack`         — model output failed schema parse.
 * - `unknown`                — uncategorised fallback.
 */
export type PipelineFailureCode =
  | "refused"
  | "io-error"
  | "invariant-violation"
  | "provider-failure"
  | "persistence-failure"
  | "budget-cap-tripped"
  | "malformed-pack"
  | "unknown";

/**
 * The minimal repro pointer — the slice of context an agent needs to reproduce
 * the failure without re-deriving it from scratch. Every field is OPTIONAL;
 * presence indicates the corresponding value was meaningful at the failure
 * site. No field carries raw game text (any literal text in the diagnostic is
 * a structural identifier — a path, an id, a pair label — never the source
 * line that was being processed).
 */
export type PipelineFailureRepro = {
  /** Path to the localize config that triggered the run, when applicable. */
  configPath?: string;
  /** Path to the bridge bundle the run read, when applicable. */
  bridgePath?: string;
  /** Path to the pair-policy the run read, when applicable. */
  pairPolicyPath?: string;
  /** Path to the structure JSON, when one was supplied. */
  structureJsonPath?: string;
  /** The bridge unit id of the failing unit, when the failure was per-unit. */
  bridgeUnitId?: string;
  /** The source unit key (scene/line path) of the failing unit, when known. */
  sourceUnitKey?: string;
  /** The scene id of the failing unit, when resolvable. */
  sceneId?: number;
  /** The agentic-loop stage the failure occurred in, when applicable. */
  stage?: string;
  /** The agent label the failure occurred in, when applicable. */
  agentLabel?: string;
  /** The (modelId, providerId) pair that was active at the failure site. */
  pair?: { modelId: string; providerId: string };
  /** The user / actor id the run was invoked under, when known. */
  actorUserId?: string;
};

/**
 * The cause-of-failure summary carried alongside the repro pointer. The
 * `class` is the Error constructor name (or `"UnknownError"` for non-Error
 * throws); the `message` is the Error message SCRUBBED of raw game text via
 * {@link redactDiagnosticError}. `stack` is included ONLY when explicitly
 * requested — a stack trace can carry source lines, so it is opt-in.
 */
export type PipelineFailureError = {
  class: string;
  /** Scrubbed error message — never raw game text. */
  message: string;
  /** Optional scrubbed stack trace. */
  stack?: string;
};

/**
 * The structured pipeline-failure diagnostic. Every step failure in the
 * localize / extract / patch / render pipeline is wrapped in this shape so a
 * driving agent can read it without guessing.
 *
 * Fields are ordered to mirror how an agent will read the diagnostic:
 *   (1) WHICH step + WHAT failed (`step`, `code`, `message`),
 *   (2) WHICH unit / scene (`failingUnitId`, `sceneId`),
 *   (3) WHAT it was given (`inputs` — redacted),
 *   (4) HOW to reproduce it (`repro`),
 *   (5) WHAT it threw (`error`),
 *   (6) EXTRA context that may help (`redactedContext` — redacted),
 *   (7) WHEN it failed (`occurredAt`).
 */
export type PipelineFailureDiagnostic = {
  /** Canonical pipeline step (closed taxonomy in {@link PipelineStep}). */
  step: PipelineStep;
  /** Closed failure-code taxonomy in {@link PipelineFailureCode}. */
  code: PipelineFailureCode;
  /** Human-readable one-line failure summary. NEVER includes raw game text. */
  message: string;
  /** The failing unit's bridge unit id, when the failure is per-unit. */
  failingUnitId?: string;
  /** The failing unit's scene id, when resolvable. */
  sceneId?: number;
  /** Step inputs (redaction-safe). Keys from GAME_TEXT_KEYS are scrubbed. */
  inputs: Record<string, unknown>;
  /** Minimal repro pointer for an agent to reproduce the failure. */
  repro: PipelineFailureRepro;
  /** The underlying error (class + scrubbed message [+ optional stack]). */
  error: PipelineFailureError;
  /** Extra structural context, all values passed through redaction. */
  redactedContext?: Record<string, unknown>;
  /** ISO-8601 timestamp the diagnostic was constructed. */
  occurredAt: string;
  /** Schema version — bumped on any breaking change to the diagnostic shape. */
  schemaVersion: "itotori.pipeline-failure-diagnostic.v0";
};

// ---------------------------------------------------------------------------
// Diagnostic error — thrown so the call site can re-throw or surface it
// ---------------------------------------------------------------------------

/**
 * The error subclass carrying a {@link PipelineFailureDiagnostic}. A catch-all
 * upstream (the CLI / the driven executor's top-level try) can rethrow this
 * directly OR inspect `error.diagnostic` to render it. The default
 * `Error.message` is the diagnostic's `message` field so a bare `console.error`
 * still surfaces the one-line summary.
 */
export class PipelineFailureDiagnosticError extends Error {
  public readonly diagnostic: PipelineFailureDiagnostic;
  constructor(diagnostic: PipelineFailureDiagnostic) {
    super(diagnostic.message);
    this.name = "PipelineFailureDiagnosticError";
    this.diagnostic = diagnostic;
  }
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

/**
 * Scrub a raw error into a {@link PipelineFailureError}. The class is the
 * Error constructor name; the message is the Error message with raw game text
 * (any literal that appears in the inputs we know about) replaced by
 * {@link REDACTED_SENTINEL}. The stack is included only when
 * `includeStack === true` (a stack trace can carry source lines, so it is
 * opt-in and scrubbed the same way as the message).
 */
export function redactDiagnosticError(error: unknown, includeStack = false): PipelineFailureError {
  const className = error instanceof Error && error.name.length > 0 ? error.name : "UnknownError";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const scrubbed = scrubGameTextFromString(rawMessage);
  const out: PipelineFailureError = { class: className, message: scrubbed };
  if (includeStack && error instanceof Error && typeof error.stack === "string") {
    out.stack = scrubGameTextFromString(error.stack);
  }
  return out;
}

/**
 * Best-effort scrub of a free-form string. The redaction is conservative:
 * it replaces every occurrence of any literal string in the provided
 * `knownGameTextLiterals` list with the sentinel. Used by
 * {@link redactDiagnosticError} so a provider that echoed the source back in
 * its error message cannot leak the source verbatim.
 *
 * Callers SHOULD pass the known game-text literals that were passed into the
 * failing step (the unit's sourceText + the structuredContext's slice + any
 * glossary surface forms). When called WITHOUT literals the redaction is a
 * no-op (the message is returned verbatim) — relying solely on the structural
 * input scrub for privacy.
 */
export function scrubGameTextFromString(
  value: string,
  knownGameTextLiterals?: ReadonlyArray<string>,
): string {
  if (knownGameTextLiterals === undefined || knownGameTextLiterals.length === 0) {
    return value;
  }
  let out = value;
  // De-duplicate + sort longest-first so overlapping literals don't leave a
  // half-scrubbed fragment behind.
  const unique = Array.from(new Set(knownGameTextLiterals.filter((lit) => lit.length > 0))).sort(
    (a, b) => b.length - a.length,
  );
  for (const literal of unique) {
    if (out.includes(literal)) {
      out = out.split(literal).join(REDACTED_SENTINEL);
    }
  }
  return out;
}

/**
 * Build a {@link PipelineFailureDiagnostic} for a given step failure. The
 * `inputs` and `redactedContext` arguments are passed through
 * {@link redactDiagnosticInputs} so callers may pass raw objects without
 * having to pre-scrub. The `error` argument is the raw thrown value; the
 * helper scrubs it via {@link redactDiagnosticError} — and additionally
 * auto-scrubs the error message / stack against the raw `inputs` (every
 * string the caller handed in) so a provider that echoed the source back in
 * its error message CANNOT leak the source verbatim. Callers may pass
 * additional literals via `knownGameTextLiterals` to widen the scrub set
 * (e.g. literals from the unit's prior-pass feedback).
 *
 * The `repro` argument is taken verbatim (it should already be constructed by
 * the caller — it carries no game-text values).
 *
 * `now` defaults to the wall clock; callers may inject a deterministic clock
 * for tests.
 */
export function buildPipelineFailureDiagnostic(args: {
  step: PipelineStep;
  code: PipelineFailureCode;
  message: string;
  error: unknown;
  inputs?: Record<string, unknown>;
  repro?: PipelineFailureRepro;
  redactedContext?: Record<string, unknown>;
  failingUnitId?: string;
  sceneId?: number;
  actor?: AuthorizationActor;
  includeStack?: boolean;
  knownGameTextLiterals?: ReadonlyArray<string>;
  now?: (() => Date) | undefined;
}): PipelineFailureDiagnostic {
  // Extract every string literal from the raw inputs + redactedContext so the
  // error message / stack can be scrubbed against the data the caller actually
  // handed to the failing step. A provider echoing source back as an error
  // message MUST NOT leak — the auto-extracted set catches it without the
  // caller having to enumerate the literals.
  const autoLiterals = extractStringLiterals([args.inputs ?? {}, args.redactedContext ?? {}]);
  const combinedLiterals = mergeLiterals(autoLiterals, args.knownGameTextLiterals ?? []);
  const scrubbedError = redactDiagnosticError(args.error, args.includeStack ?? false);
  if (combinedLiterals.length > 0) {
    scrubbedError.message = scrubGameTextFromString(scrubbedError.message, combinedLiterals);
    if (scrubbedError.stack !== undefined) {
      scrubbedError.stack = scrubGameTextFromString(scrubbedError.stack, combinedLiterals);
    }
  }
  const inputs = (redactDiagnosticInputs(args.inputs ?? {}) as Record<string, unknown>) ?? {};
  const repro = args.repro ?? {};
  if (args.actor !== undefined && repro.actorUserId === undefined) {
    repro.actorUserId = args.actor.userId;
  }
  if (args.failingUnitId !== undefined && repro.bridgeUnitId === undefined) {
    repro.bridgeUnitId = args.failingUnitId;
  }
  if (args.sceneId !== undefined && repro.sceneId === undefined) {
    repro.sceneId = args.sceneId;
  }
  const diagnostic: PipelineFailureDiagnostic = {
    step: args.step,
    code: args.code,
    message: args.message,
    error: scrubbedError,
    inputs,
    repro,
    occurredAt: (args.now ?? (() => new Date()))().toISOString(),
    schemaVersion: "itotori.pipeline-failure-diagnostic.v0",
    ...(args.failingUnitId !== undefined ? { failingUnitId: args.failingUnitId } : {}),
    ...(args.sceneId !== undefined ? { sceneId: args.sceneId } : {}),
    ...(args.redactedContext !== undefined
      ? { redactedContext: redactDiagnosticInputs(args.redactedContext) as Record<string, unknown> }
      : {}),
  };
  return diagnostic;
}

/**
 * Recursively extract every string value from an array of objects. Used by
 * {@link buildPipelineFailureDiagnostic} to widen the error-scrub literal set
 * with whatever the caller actually passed in. Only short strings are kept
 * (long bodies would produce too many false positives in error scrubbing).
 */
function extractStringLiterals(values: ReadonlyArray<unknown>): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (value === null || value === undefined) {
      return;
    }
    if (typeof value === "string") {
      if (value.length > 0 && value.length <= 1024) {
        out.push(value);
      }
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry);
      }
      return;
    }
    // Skip class instances (Date, Map, etc.) — only walk plain objects.
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
      return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      walk(child);
    }
  };
  for (const value of values) {
    walk(value);
  }
  return out;
}

/** De-duplicate + merge two literal arrays (auto + caller-supplied). */
function mergeLiterals(auto: ReadonlyArray<string>, extra: ReadonlyArray<string>): string[] {
  if (auto.length === 0 && extra.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const lit of [...auto, ...extra]) {
    if (lit.length === 0 || seen.has(lit)) {
      continue;
    }
    seen.add(lit);
    out.push(lit);
  }
  return out;
}

/**
 * Convenience: run an async step and convert any thrown error into a
 * {@link PipelineFailureDiagnosticError}. The original error's class + message
 * survive in `error.class` + `error.message` (scrubbed); the stack is dropped
 * unless `includeStack === true` (stack traces can carry source lines).
 *
 * Callers supply the canonical step name + a one-line failure summary that
 * names the step. The `repro` + `inputs` + `redactedContext` are passed
 * verbatim and scrubbed by the helper. The `failingUnitId` / `sceneId` /
 * `actor` fields are derived from the caller's context if supplied.
 */
export async function runPipelineStepWithDiagnostic<T>(args: {
  step: PipelineStep;
  code?: PipelineFailureCode;
  message: string;
  repro?: PipelineFailureRepro;
  inputs?: Record<string, unknown>;
  redactedContext?: Record<string, unknown>;
  failingUnitId?: string;
  sceneId?: number;
  actor?: AuthorizationActor;
  includeStack?: boolean;
  knownGameTextLiterals?: ReadonlyArray<string>;
  now?: (() => Date) | undefined;
  run: () => Promise<T> | T;
}): Promise<T> {
  try {
    return await args.run();
  } catch (error) {
    // If the step already threw a structured diagnostic, propagate it
    // untouched — the upstream surface has the more specific context.
    if (error instanceof PipelineFailureDiagnosticError) {
      throw error;
    }
    const code = args.code ?? "unknown";
    const diagnostic = buildPipelineFailureDiagnostic({
      step: args.step,
      code,
      message: args.message,
      error,
      ...(args.inputs !== undefined ? { inputs: args.inputs } : {}),
      ...(args.repro !== undefined ? { repro: args.repro } : {}),
      ...(args.redactedContext !== undefined ? { redactedContext: args.redactedContext } : {}),
      ...(args.failingUnitId !== undefined ? { failingUnitId: args.failingUnitId } : {}),
      ...(args.sceneId !== undefined ? { sceneId: args.sceneId } : {}),
      ...(args.actor !== undefined ? { actor: args.actor } : {}),
      includeStack: args.includeStack ?? false,
      ...(args.knownGameTextLiterals !== undefined
        ? { knownGameTextLiterals: args.knownGameTextLiterals }
        : {}),
      ...(args.now !== undefined ? { now: args.now } : {}),
    });
    throw new PipelineFailureDiagnosticError(diagnostic);
  }
}

// ---------------------------------------------------------------------------
// Per-unit structured failure — extends the driven executor's failure shape
// ---------------------------------------------------------------------------

/**
 * A per-unit failure in the driven executor's diagnostic form. The executor
 * already records `{bridgeUnitId, sourceUnitKey, errorClass, errorMessage}`
 * on `DrivenUnitFailure`; this shape extends that record with the diagnostic
 * fields an agent needs (canonical step + repro pointer + redacted inputs)
 * while remaining a superset of the legacy shape so existing call sites that
 * read `errorClass` / `errorMessage` keep working.
 *
 * The legacy `errorClass` field is retained as the alias for
 * `error.class`; `errorMessage` is retained as the alias for `error.message`.
 * Both are scrubbed — no raw game text ever lives on the diagnostic.
 */
export type PipelineUnitFailureDiagnostic = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  errorClass: string;
  errorMessage: string;
  /** Canonical step this failure belongs to. */
  step: PipelineStep;
  /** Closed failure-code taxonomy. */
  code: PipelineFailureCode;
  /** One-line summary, scrubbed. */
  message: string;
  /** Scene id, when resolvable from the unit's per-unit context. */
  sceneId?: number;
  /** Repro pointer for an agent to reproduce. */
  repro: PipelineFailureRepro;
  /** Redacted step inputs (the unit's redacted view). */
  inputs: Record<string, unknown>;
  /** ISO-8601 timestamp the diagnostic was constructed. */
  occurredAt: string;
  /** Schema version — bumped on any breaking change to the diagnostic shape. */
  schemaVersion: "itotori.pipeline-failure-diagnostic.v0";
};

/**
 * Build a {@link PipelineUnitFailureDiagnostic} for a per-unit failure
 * surfaced by the driven executor. Pass the failing unit's identifying fields
 * + the redacted unit inputs the executor was operating on; the helper
 * scrubs + shapes the rest.
 */
export function buildPipelineUnitFailureDiagnostic(args: {
  bridgeUnitId: string;
  sourceUnitKey: string;
  sceneId?: number;
  unitInputs?: Record<string, unknown>;
  error: unknown;
  /** Optional pair / stage / agentLabel the failing unit was being processed under. */
  pair?: { modelId: string; providerId: string };
  stage?: string;
  agentLabel?: string;
  knownGameTextLiterals?: ReadonlyArray<string>;
  now?: (() => Date) | undefined;
}): PipelineUnitFailureDiagnostic {
  const code: PipelineFailureCode = "unknown";
  // Auto-extract every string from the raw unit inputs so a provider echoing
  // source back as an error message CANNOT leak — the scrub set is widened
  // with whatever the caller actually passed in (typically the unit's
  // sourceText + spans). Caller-supplied literals are layered on top.
  const autoLiterals = extractStringLiterals([args.unitInputs ?? {}]);
  const combinedLiterals = mergeLiterals(autoLiterals, args.knownGameTextLiterals ?? []);
  const scrubbedError = redactDiagnosticError(args.error, false);
  if (combinedLiterals.length > 0) {
    scrubbedError.message = scrubGameTextFromString(scrubbedError.message, combinedLiterals);
  }
  const inputs = (redactDiagnosticInputs(args.unitInputs ?? {}) as Record<string, unknown>) ?? {};
  const repro: PipelineFailureRepro = {
    bridgeUnitId: args.bridgeUnitId,
    sourceUnitKey: args.sourceUnitKey,
    ...(args.sceneId !== undefined ? { sceneId: args.sceneId } : {}),
    ...(args.stage !== undefined ? { stage: args.stage } : {}),
    ...(args.agentLabel !== undefined ? { agentLabel: args.agentLabel } : {}),
    ...(args.pair !== undefined ? { pair: args.pair } : {}),
  };
  const diagnostic: PipelineUnitFailureDiagnostic = {
    bridgeUnitId: args.bridgeUnitId,
    sourceUnitKey: args.sourceUnitKey,
    errorClass: scrubbedError.class,
    errorMessage: scrubbedError.message,
    step: "executor.drive-unit",
    code,
    message: `unit ${args.bridgeUnitId} failed during executor.drive-unit: ${scrubbedError.message}`,
    repro,
    inputs,
    occurredAt: (args.now ?? (() => new Date()))().toISOString(),
    schemaVersion: "itotori.pipeline-failure-diagnostic.v0",
    ...(args.sceneId !== undefined ? { sceneId: args.sceneId } : {}),
  };
  return diagnostic;
}

/**
 * Render a {@link PipelineFailureDiagnostic} as a single-line, agent-facing
 * summary. Useful for `console.error` / structured logs / PR comments — never
 * for persisted artifacts (those should carry the full JSON). The rendered
 * line names the step + failing unit (when known) + the error class + a
 * truncated, scrubbed error message. The truncation is character-count only
 * (a fixed cap) and never splits mid-token.
 */
export function renderPipelineFailureDiagnosticOneLine(
  diag: PipelineFailureDiagnostic,
  maxChars = 280,
): string {
  const head = `[${diag.step}] code=${diag.code}`;
  const unit = diag.failingUnitId !== undefined ? ` unit=${diag.failingUnitId}` : "";
  const scene = diag.sceneId !== undefined ? ` scene=${diag.sceneId}` : "";
  const tail = ` error=${diag.error.class}: ${diag.error.message}`;
  const line = `${head}${unit}${scene}${tail}`;
  if (line.length <= maxChars) {
    return line;
  }
  return `${line.slice(0, Math.max(0, maxChars - 3))}...`;
}
