# LLM physical-attempt policy

The application owns the only visible retry policy. Provider SDK retries stay
disabled. A logical step may make at most three physical attempts, including
attempts made before a process restart. Only transport failures, HTTP 408 and
429 responses, and HTTP 5xx responses are transient and retryable. A
`Retry-After` header takes precedence; otherwise retries use bounded full
jitter with one- and two-second exponential windows. Typed provider failures,
content filtering, and schema-invalid responses complete the immutable step
memo and are not retried.

The persistent three-attempt cap intentionally counts transient failures. It
bounds provider load and billing exposure across restarts. When the cap is
reached, another invocation returns a typed exhausted-retries failure before
opening a new connection. The spend-exposure report also counts the exhausted
step, so this state is visible rather than becoming a silent retry wedge.

Each measured model profile owns its normal and deep deadlines. Dispatch
selects the deadline from the profile, verifies that the profile matches the
selected model version, and applies a fresh deadline to every physical
attempt. A deadline failure is a transient attempt and consumes the same
bounded attempt budget.

Cancellation is checked before every new attempt and during retry delay. It
also aborts an attempt already in progress. If a response wins the race and is
committed first, its completed memo remains authoritative; cancellation never
deletes or replaces that winning response. A later physical step is not
started once cancellation is visible.

## Spend admission and exposure

Admission reads physical-attempt facts; it does not reserve, debit, own, or
release budget. Starting a provider request inserts an `in-flight` attempt with
its profile-derived maximum exposure and deadline. Completing that request
updates the same fact once with its terminal outcome and billing state.

The report has three independent quantities:

- **Confirmed** is the sum of reconciled provider cost on physical attempts.
- **Unknown** is the count of completed `billing_unknown` attempts plus
  in-flight attempts whose deadline has expired.
- **Bounded in flight** is the sum of maximum exposure for active attempts,
  accompanied by their count.

Admission is a soft cap over confirmed spend. Concurrent attempts may expose
bounded overshoot, which the in-flight figure reports explicitly. Unknown cost
is never treated as zero. A crash-left attempt moves from bounded in-flight to
unknown after its deadline; it does not become a reservation or require a
lease, fence, or run owner.
