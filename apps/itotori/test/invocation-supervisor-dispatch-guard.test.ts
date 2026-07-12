import { describe, expect, it } from "vitest";
import {
  dispatchProviderAdapter,
  executeModelInvocation,
  InvocationSupervisor,
  SupervisedModelProviderAdapter,
  supervisedModelProvider,
  UnsupervisedProviderAdapterDispatchError,
} from "../src/orchestrator/invocation-supervisor.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelProvider,
} from "../src/providers/types.js";

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
    class CopyingDecorator extends SupervisedModelProviderAdapter {
      readonly descriptor = transport.descriptor;

      constructor() {
        super(() => transport);
      }

      protected override decorateInvocationRequest(
        candidate: ModelInvocationRequest,
      ): ModelInvocationRequest {
        // Production posture decorators spread the request before delegating.
        // The private symbol capability must survive that spread.
        retainedRequest = { ...candidate };
        return retainedRequest;
      }
    }

    const result = await executeModelInvocation(new CopyingDecorator(), request());

    expect(result.content).toBe("usable delegated output");
    expect(physicalDispatches).toBe(1);
    expect(retainedRequest).toBeDefined();
    expect(() => dispatchProviderAdapter(transport, retainedRequest!)).toThrow(
      UnsupervisedProviderAdapterDispatchError,
    );
    expect(physicalDispatches).toBe(1);
  });

  it("rejects the first use against a provider other than the issued target", async () => {
    let intendedDispatches = 0;
    let wrongDispatches = 0;
    let wrongProviderError: unknown;
    const intendedTransport = new FakeModelProvider({
      generate: () => {
        intendedDispatches += 1;
        return "intended transport output";
      },
    });
    const wrongTransport = new FakeModelProvider({
      generate: () => {
        wrongDispatches += 1;
        return "wrong transport output";
      },
    });

    class CrossProviderProbe extends SupervisedModelProviderAdapter {
      readonly descriptor = intendedTransport.descriptor;

      constructor() {
        super(() => intendedTransport);
      }

      override invoke(candidate: ModelInvocationRequest): Promise<ModelInvocationResult> {
        try {
          dispatchProviderAdapter(wrongTransport, candidate);
        } catch (error) {
          wrongProviderError = error;
        }
        return super.invoke(candidate);
      }
    }

    const result = await executeModelInvocation(new CrossProviderProbe(), request());

    expect(result.content).toBe("intended transport output");
    expect(wrongProviderError).toBeInstanceOf(UnsupervisedProviderAdapterDispatchError);
    expect(wrongDispatches).toBe(0);
    expect(intendedDispatches).toBe(1);
  });

  it("consumes a provider-bound capability before a second same-provider use", async () => {
    let physicalDispatches = 0;
    let secondUseError: unknown;
    const transport = new FakeModelProvider({
      generate: () => {
        physicalDispatches += 1;
        return "one physical dispatch";
      },
    });

    class DoubleDispatchProbe extends SupervisedModelProviderAdapter {
      readonly descriptor = transport.descriptor;

      constructor() {
        super(() => transport);
      }

      override invoke(candidate: ModelInvocationRequest): Promise<ModelInvocationResult> {
        const firstDispatch = super.invoke(candidate);
        try {
          dispatchProviderAdapter(transport, candidate);
        } catch (error) {
          secondUseError = error;
        }
        return firstDispatch;
      }
    }

    const result = await executeModelInvocation(new DoubleDispatchProbe(), request());

    expect(result.content).toBe("one physical dispatch");
    expect(secondUseError).toBeInstanceOf(UnsupervisedProviderAdapterDispatchError);
    expect(physicalDispatches).toBe(1);
  });

  it("gives nested decorators distinct one-shot capabilities for one physical dispatch", async () => {
    let physicalDispatches = 0;
    let physicalRequest: ModelInvocationRequest | undefined;
    const transport = new FakeModelProvider({
      generate: (candidate) => {
        physicalDispatches += 1;
        physicalRequest = candidate;
        return "nested decorator output";
      },
    });

    class MessageDecorator extends SupervisedModelProviderAdapter {
      readonly descriptor: ModelProvider["descriptor"];

      constructor(
        target: ModelProvider,
        private readonly label: string,
      ) {
        super(() => target);
        this.descriptor = target.descriptor;
      }

      protected override decorateInvocationRequest(
        candidate: ModelInvocationRequest,
      ): ModelInvocationRequest {
        return {
          ...candidate,
          messages: [...candidate.messages, { role: "system", content: this.label }],
        };
      }
    }

    const inner = new MessageDecorator(transport, "inner decoration");
    const outer = new MessageDecorator(inner, "outer decoration");
    const result = await executeModelInvocation(outer, request());

    expect(result.content).toBe("nested decorator output");
    expect(physicalDispatches).toBe(1);
    expect(physicalRequest?.messages.slice(-2).map((message) => message.content)).toEqual([
      "outer decoration",
      "inner decoration",
    ]);
  });

  it("revokes delayed nested capabilities when the supervisor attempt ends", async () => {
    let physicalDispatches = 0;
    let releaseNested!: () => void;
    let markNestedEntered!: () => void;
    let markNestedSettled!: () => void;
    let lateDispatchError: unknown;
    const releaseGate = new Promise<void>((resolve) => {
      releaseNested = resolve;
    });
    const nestedEntered = new Promise<void>((resolve) => {
      markNestedEntered = resolve;
    });
    const nestedSettled = new Promise<void>((resolve) => {
      markNestedSettled = resolve;
    });
    const transport = new FakeModelProvider({
      generate: () => {
        physicalDispatches += 1;
        return "must not dispatch after timeout";
      },
    });

    class PassThroughAdapter extends SupervisedModelProviderAdapter {
      readonly descriptor: ModelProvider["descriptor"];

      constructor(target: ModelProvider) {
        super(() => target);
        this.descriptor = target.descriptor;
      }
    }

    class DelayedNestedAdapter extends SupervisedModelProviderAdapter {
      readonly descriptor = transport.descriptor;

      constructor() {
        super(() => transport);
      }

      override async invoke(candidate: ModelInvocationRequest): Promise<ModelInvocationResult> {
        markNestedEntered();
        await releaseGate;
        try {
          return await super.invoke(candidate);
        } catch (error) {
          lateDispatchError = error;
          throw error;
        } finally {
          markNestedSettled();
        }
      }
    }

    const outer = new PassThroughAdapter(new DelayedNestedAdapter());
    const provider = supervisedModelProvider(
      new InvocationSupervisor({
        provider: outer,
        retryPolicy: { deadlineMs: 10 },
        sleep: async () => undefined,
      }),
    );
    const execution = executeModelInvocation(provider, request());

    await nestedEntered;
    await expect(execution).rejects.toThrow(/deadline|exceeded/iu);
    releaseNested();
    await nestedSettled;

    expect(lateDispatchError).toBeInstanceOf(UnsupervisedProviderAdapterDispatchError);
    expect(physicalDispatches).toBe(0);
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
