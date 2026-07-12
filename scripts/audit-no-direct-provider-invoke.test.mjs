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

test("rejects destructuring provider invoke into local bindings", () => {
  const source = [
    "const { invoke } = options.provider;",
    "await invoke(request);",
    "const { invoke: dispatch } = provider;",
    "await dispatch(request);",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["options.provider", "provider"]);
});

test("rejects destructuring provider invoke from a defaulted parameter", () => {
  const source = [
    "function bypass({ invoke: send } = provider) {",
    "  return send(request);",
    "}",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["provider"]);
});

test("rejects provider invoke nested in array destructuring", () => {
  const source = ["const [{ invoke: send }] = [provider];", "send(request);"].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["provider"]);
});

test("rejects provider invoke extraction through Object.values", () => {
  const source = ["const send = Object.values(provider).find(predicate);", "send(request);"].join(
    "\n",
  );

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["provider"]);
});

test("rejects provider invoke through an object spread copy", () => {
  const source = [
    "const copy = { ...provider };",
    "copy.invoke(request);",
    "copy.invoke(request, malformedExtraArgument);",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["copy", "copy"]);
});

test("rejects provider aliases before invoke extraction", () => {
  const source = [
    "const first = options.provider;",
    "const second = first;",
    "const dispatch = second.invoke;",
    "await dispatch(request);",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["second"]);
});

test("rejects Reflect.get extraction of provider invoke", () => {
  const source = [
    'const dispatch = Reflect.get(options.provider, "invoke");',
    "await dispatch(request);",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["options.provider"]);
});

test("rejects statically assembled and dynamically computed provider extraction", () => {
  const source = [
    'const prefix = "inv";',
    "const method = `${prefix}oke`;",
    "const assembled = options.provider[method];",
    "await assembled(request);",
    'const dynamic = provider[chooseMethod("invoke")];',
    "await dynamic(request);",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["options.provider", "provider"]);
});

test("rejects destructured invoke through an imported ModelProvider type alias", () => {
  const source = [
    'import type { ModelProvider as Backend } from "../providers/types.js";',
    "function bypass(backend: Backend, request: Request) {",
    "  const { invoke: send } = backend;",
    "  return send(request);",
    "}",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["backend"]);
});

test("rejects destructured invoke through a typed provider property", () => {
  const source = [
    "function bypass(options: { backend: ModelProvider }, request: Request) {",
    "  const { invoke: send } = options.backend;",
    "  return send(request);",
    "}",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["options.backend"]);
});

test("rejects dynamic extraction from a neutral receiver with a ModelProvider alias type", () => {
  const source = [
    'import type { ModelProvider as Backend } from "../providers/types.js";',
    "type Fn = (request: Request) => Promise<Result>;",
    "function bypass(backend: Backend, method: string, request: Request) {",
    "  const send = backend[method as keyof Backend];",
    "  return (send as Fn)(request);",
    "}",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["backend"]);
});

test("rejects provider invoke extraction through an aliased Reflect.get", () => {
  const source = [
    "function bypass(provider: ModelProvider, key: string, request: Request) {",
    "  const get = Reflect.get;",
    "  const send = get(provider, key);",
    "  return send(request);",
    "}",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["provider"]);
});

test("rejects dynamic extraction through a namespace-qualified ModelProvider type", () => {
  const source = [
    'import type * as Types from "../providers/types.js";',
    "type Fn = (request: Request) => Promise<Result>;",
    "function bypass(",
    "  backend: Types.ModelProvider,",
    "  method: keyof Types.ModelProvider,",
    "  request: Request,",
    ") {",
    "  const send = backend[method];",
    "  return (send as Fn)(request);",
    "}",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["backend"]);
});

test("rejects dynamic extraction from a typed provider-returning function", () => {
  const source = [
    "type Fn = (request: Request) => Promise<Result>;",
    'function getBackend(): ModelProvider { throw new Error("fixture"); }',
    "function bypass(method: string, request: Request) {",
    "  const backend = getBackend();",
    "  const send = backend[method];",
    "  return (send as Fn)(request);",
    "}",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["backend"]);
});

test("rejects provider invoke extraction through destructured Reflect.get", () => {
  const source = [
    "function bypass(provider: ModelProvider, key: string, request: Request) {",
    "  const { get } = Reflect;",
    "  const send = get(provider, key);",
    "  return send(request);",
    "}",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["provider"]);
});

test("rejects dynamic extraction from a typed provider-returning function value", () => {
  const source = [
    "declare const acquire: () => ModelProvider;",
    "function bypass(method: string, request: Request) {",
    "  const backend = acquire();",
    "  const send = backend[method as keyof ModelProvider];",
    "  return (send as ModelProvider['invoke'])(request);",
    "}",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["backend"]);
});

test("rejects Reflect.get aliases reached through a Reflect object alias", () => {
  const source = [
    "function first(provider: ModelProvider, key: string, request: Request) {",
    "  const R = Reflect;",
    "  const take = R.get;",
    "  const send = take(provider, key);",
    "  return send(request);",
    "}",
    "function second(provider: ModelProvider, key: string, request: Request) {",
    "  const R = Reflect;",
    "  const { get: take } = R;",
    "  const send = take(provider, key);",
    "  return send(request);",
    "}",
  ].join("\n");

  assert.deepEqual(receivers(PRODUCTION_AGENT, source), ["provider", "provider"]);
});

test("allows higher-level two-argument agent invoke calls", () => {
  const source = [
    "await agent.invoke(actor, input);",
    "await set.styleAdherence.invoke(actor, withVersion(input));",
  ].join("\n");

  assert.deepEqual(findViolations("apps/itotori/src/qa/regrade-loop.ts", source), []);
});

test("does not trust decorator filenames to exempt raw provider dispatch", () => {
  for (const path of [
    "apps/itotori/src/orchestrator/localize-project-stage-command.ts",
    "apps/itotori/src/services/db-live-workflow-ports.ts",
  ]) {
    assert.equal(findViolations(path, "return inner.invoke(request);").length, 1);
    // This helper is allowed by syntax in any module because its runtime
    // capability check rejects calls outside an active InvocationSupervisor.
    assert.deepEqual(findViolations(path, "return dispatchProviderAdapter(inner, request);"), []);
  }
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
