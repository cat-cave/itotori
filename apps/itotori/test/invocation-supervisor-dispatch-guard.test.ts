import { describe, expect, it } from "vitest";
import {
  dispatchProviderAdapter,
  executeModelInvocation,
  UnsupervisedProviderAdapterDispatchError,
} from "../src/orchestrator/invocation-supervisor.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest, ModelProvider } from "../src/providers/types.js";

describe("InvocationSupervisor provider-adapter delegation", () => {
  it("rejects the helper outside an active supervised dispatch", () => {
    let physicalDispatches = 0;
    const transport = new FakeModelProvider({
      generate: () => {
        physicalDispatches += 1;
        return "usable delegated output";
      },
    });

    expect(() => dispatchProviderAdapter(transport, request())).toThrow(
      UnsupervisedProviderAdapterDispatchError,
    );
    expect(physicalDispatches).toBe(0);
  });

  it("permits decorated dispatch only while its supervisor capability is active", async () => {
    let physicalDispatches = 0;
    let retainedRequest: ModelInvocationRequest | undefined;
    const transport = new FakeModelProvider({
      generate: () => {
        physicalDispatches += 1;
        return "usable delegated output";
      },
    });
    const decorator: ModelProvider = {
      descriptor: transport.descriptor,
      invoke: (candidate) => {
        // Production posture decorators spread the request before delegating.
        // The private symbol capability must survive that spread.
        retainedRequest = { ...candidate };
        return dispatchProviderAdapter(transport, retainedRequest);
      },
    };

    const result = await executeModelInvocation(decorator, request());

    expect(result.content).toBe("usable delegated output");
    expect(physicalDispatches).toBe(1);
    expect(retainedRequest).toBeDefined();
    expect(() => dispatchProviderAdapter(transport, retainedRequest!)).toThrow(
      UnsupervisedProviderAdapterDispatchError,
    );
    expect(physicalDispatches).toBe(1);
  });
});

function request(): ModelInvocationRequest {
  return {
    taskKind: "draft_translation",
    modelId: "itotori-fake-draft-v0",
    providerId: "itotori-fixture",
    inputClassification: "synthetic_public",
    messages: [{ role: "user", content: "Return one usable line." }],
    prompt: {
      presetId: "invocation-supervisor-dispatch-guard",
      templateVersion: "1",
      promptHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    },
  };
}
