// ITOTORI-227 — account-wide Zero-Data-Retention assertion.
//
// itotori does NOT reinvent OpenRouter's per-pair privacy registry. Per
// docs/openrouter-integration.md §2 (Privacy posture), the canonical
// three-part posture is:
//
//   (a) the OpenRouter account is configured ZDR-only at the dashboard
//       level (a one-time operator setting Trevor maintains),
//   (b) every non-public request body sends `provider.zdr=true`, and
//   (c) the response is non-error — empirically, OpenRouter returns a
//       404 envelope "No endpoints found matching your data policy
//       (Zero data retention)" if no ZDR provider can serve the call.
//
// This module owns (a)'s in-process check. The operator asserts the
// dashboard-level posture by exporting OPENROUTER_ZDR_ACCOUNT_ASSERTED=1
// before launching the process; if the env var is missing the OpenRouter
// provider refuses to construct, so the failure is loud and the gate is
// owned by the operator (not by a CLI flag a stray script could flip).
//
// (b) is carried by the certified `CallSpec.providerPolicy` through the
// current `llm/dispatch.ts` TanStack boundary; (c) surfaces through the
// existing HTTP-error path as a 404 envelope.

/**
 * Thrown when {@link assertOpenRouterZdrAccount} runs without
 * `OPENROUTER_ZDR_ACCOUNT_ASSERTED=1` in the environment. The current
 * ZDR-admission gate calls the assertion synchronously before qualifying
 * work begins, so this error surfaces before dispatch — never silently
 * during an invocation.
 */
export class AccountZdrAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountZdrAssertionError";
  }
}

/**
 * Assert the operator has flagged the OpenRouter account ZDR-only.
 *
 * Throws {@link AccountZdrAssertionError} synchronously when
 * `OPENROUTER_ZDR_ACCOUNT_ASSERTED` is anything other than the literal
 * string `"1"`. There is no warning mode, no default-true, no inferred
 * "auto" — this gate is load-bearing for the privacy posture and the
 * operator is the only signer.
 */
export function assertOpenRouterZdrAccount(
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (env.OPENROUTER_ZDR_ACCOUNT_ASSERTED !== "1") {
    throw new AccountZdrAssertionError(
      "OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 is required: this process must assert " +
        "the OpenRouter account is configured Zero-Data-Retention-only at the " +
        "dashboard level. See docs/openrouter-integration.md §2.",
    );
  }
}
