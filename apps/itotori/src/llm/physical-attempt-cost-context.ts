import { AsyncLocalStorage } from "node:async_hooks";
import type { PhysicalAttemptCostObserver } from "./physical-attempt-policy.js";

type CostObserverScope = {
  readonly observer: PhysicalAttemptCostObserver;
  active: boolean;
};

const observers = new AsyncLocalStorage<CostObserverScope>();

/** Bind a project-run observer around a workflow invocation. Physical dispatch
 * reads this at the sole attempt boundary, including role closures assembled
 * before the invocation began. */
export async function withPhysicalAttemptCostObserver<T>(
  observer: PhysicalAttemptCostObserver,
  operation: () => Promise<T>,
): Promise<T> {
  let scope!: CostObserverScope;
  scope = {
    active: true,
    // `memoizedPhysicalAttempt` reads this once before its retry loop. Keep the
    // guard on the object it captures, not only in `current…`, so a detached
    // attempt cannot invoke the original observer after this scope closes.
    observer: {
      onAttemptStarted: async (input) => {
        assertScopeIsActive(scope);
        await observer.onAttemptStarted(input);
      },
      onAttemptCompleted: async (input) => {
        assertScopeIsActive(scope);
        await observer.onAttemptCompleted(input);
      },
    },
  };
  return await observers.run(scope, async () => {
    try {
      return await operation();
    } finally {
      // AsyncLocalStorage propagates to resources created inside this callback.
      // Do not let a detached resource retain a writer after the localize run's
      // DB scope has returned its pool.
      scope.active = false;
    }
  });
}

export function currentPhysicalAttemptCostObserver(): PhysicalAttemptCostObserver | undefined {
  const scope = observers.getStore();
  return scope?.active === true ? scope.observer : undefined;
}

function assertScopeIsActive(scope: CostObserverScope): void {
  if (!scope.active) {
    throw new Error("physical-attempt cost observer was used after its localize run ended");
  }
}
