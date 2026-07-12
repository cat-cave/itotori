import assert from "node:assert/strict";
import test from "node:test";
import {
  findViolations,
  isExemptPath,
  shouldScanPath,
} from "./audit-no-direct-provider-invoke.mjs";

const PRODUCTION_AGENT = "apps/itotori/src/agents/translation/agent.ts";

function receivers(path, source) {
  return findViolations(path, source).map((violation) => violation.receiver);
}

test("rejects direct provider calls independent of receiver spelling", () => {
  const source = [
    "await provider.invoke(request);",
    "await options.provider.invoke(request);",
    "await llm.invoke(request);",
    "await this.inner.invoke(request);",
    "await delegate.invoke(...requests);",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), [
    "provider",
    "options.provider",
    "llm",
    "this.inner",
    "delegate",
  ]);
});

test("rejects optional and literal-computed provider invoke calls", () => {
  const source = [
    "await provider?.invoke?.(request);",
    'await options.provider["invoke"](request);',
    "await (provider.invoke as (request: Request) => Promise<Result>)(request);",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), [
    "provider",
    "options.provider",
    "provider",
  ]);
});

test("rejects extracting or binding a provider invoke member", () => {
  const source = [
    "const dispatch = provider.invoke;",
    "const bound = this.inner.invoke.bind(this.inner);",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["provider", "this.inner"]);
});

test("allows higher-level two-argument agent invoke calls", () => {
  const source = [
    "await agent.invoke(actor, input);",
    "await set.styleAdherence.invoke(actor, withVersion(input));",
  ].join("\n");

  assert.deepEqual(findViolations("apps/itotori/src/qa/regrade-loop.ts", source), []);
});

test("limits the raw adapter-delegation helper to the two audited decorators", () => {
  const bypass =
    'import { dispatchProviderAdapter as bypass } from "../orchestrator/invocation-supervisor.js";';
  assert.equal(findViolations(PRODUCTION_AGENT, bypass).length, 1);
  assert.deepEqual(
    findViolations(
      "apps/itotori/src/orchestrator/localize-project-stage-command.ts",
      "return dispatchProviderAdapter(inner, request);",
    ),
    [],
  );
  assert.deepEqual(
    findViolations(
      "apps/itotori/src/services/db-live-workflow-ports.ts",
      "return dispatchProviderAdapter(inner, request);",
    ),
    [],
  );
});

test("ignores comments, strings, and invoke method declarations", () => {
  const source = [
    "// provider.invoke(request);",
    'const example = "provider.invoke(request)";',
    "class Agent { invoke(actor: Actor, input: Input): Result { return input; } }",
  ].join("\n");

  assert.deepEqual(findViolations(PRODUCTION_AGENT, source), []);
});

test("exempts only provider adapter source and the canonical supervisor module", () => {
  const directCall = "await provider.invoke(request);";

  assert.equal(isExemptPath("apps/itotori/src/providers/openrouter.ts"), true);
  assert.equal(isExemptPath("apps/itotori/src/orchestrator/invocation-supervisor.ts"), true);
  assert.deepEqual(findViolations("apps/itotori/src/providers/openrouter.ts", directCall), []);
  assert.deepEqual(
    findViolations("apps/itotori/src/orchestrator/invocation-supervisor.ts", directCall),
    [],
  );

  assert.equal(isExemptPath("apps/itotori/src/orchestrator/attempt-outcome-journal.ts"), false);
  assert.equal(
    findViolations("apps/itotori/src/orchestrator/attempt-outcome-journal.ts", directCall).length,
    1,
  );
  assert.equal(
    findViolations("apps/itotori/src/orchestrator/invocation-supervisor-helper.ts", directCall)
      .length,
    1,
  );
});

test("the repository scan is limited to shipped Itotori source", () => {
  assert.equal(shouldScanPath("apps/itotori/src/agents/translation/agent.ts"), true);
  assert.equal(shouldScanPath("apps/itotori/src/ui/view.tsx"), true);
  assert.equal(shouldScanPath("apps/itotori/test/translation-agent.test.ts"), false);
  assert.equal(shouldScanPath("packages/itotori-db/src/index.ts"), false);
  assert.equal(shouldScanPath("apps/itotori/src/readme.md"), false);
});
