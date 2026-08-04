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

Starting a provider request inserts an `in-flight` attempt with its
profile-derived maximum exposure and deadline. The same durable attempt fact is
the admission reservation: there is no separate ownership, lease, or debit row.
Completing the request updates that fact once with its terminal outcome and
billing state, which releases its active reservation.

The report has three independent quantities:

- **Confirmed** is the sum of reconciled provider cost on physical attempts.
- **Unknown** is the count of completed `billing_unknown` attempts plus
  in-flight attempts whose deadline has expired.
- **Bounded in flight** is the sum of maximum exposure for active attempts,
  accompanied by their count.

Every profile admission is serialized by a transaction-scoped PostgreSQL
advisory lock. It accepts a request only when:

`confirmed cost + unresolved in-flight maximum exposure + requested maximum exposure <= profile cap`.

The maximum exposure is a declared upper bound: the database rejects a
confirmed receipt above it. Exact equality is allowed. Admission retains every
unresolved `in-flight` attempt as a reservation, including one past its
deadline, until a durable terminal outcome arrives. This is deliberately more
conservative than the report's **Bounded in flight** figure, which includes
only unexpired attempts.

Durable project runs add a second, independent check under that profile lock.
Before provider work, a portfolio atomically declares one immutable admission
epoch: its canonical full member list and membership-derived cohort ID. The
database gives every declared active member the equal whole-micro share
`floor(profile cap in micros-USD / member count)`. Thus three registered runs
each receive one third of the cap, while the profile check continues to bound
their combined confirmed and reserved exposure. A genuine singleton declaration
has one member and retains the historical full profile cap.

The same active epoch declaration is idempotent. A different declaration while
that profile epoch is active is a typed `profile-cohort-busy` outcome: the caller
retries after the epoch closes or submits the coordinated portfolio, rather than
silently borrowing another run's budget. Attempt admission only looks up its
already-active member; it never adds a late run. Members release on completion,
failure, or pause. Under that same profile lock, a release gives every survivor
equal _new_ capacity: its stored
total cap becomes its current-cohort confirmed and unresolved exposure plus the
whole-micro floor of the remaining profile headroom divided by the active member
count. Thus no irrevocable spend or unresolved request is reissued to survivors;
a stored total cap may change, but never below the member's current exposure.
The cohort closes after its last release. An unscoped legacy caller has no
run-share check and retains the full profile cap. Project-run cost-account caps
are not rewritten by provider fair sharing, so existing durable runs retain their
immutable resume-time account identity; provider admission is the fair-share
authority.

A closed exact singleton declaration may be reactivated by the durable lifecycle
to resume that same paused run, but only when the profile has no active epoch.
Attempt admission cannot reopen it, and a released multi-run epoch never
reactivates; this keeps a prior multi-run allocation from being re-sliced after
any member has spent.

A terminal HTTP failure or cancellation changes the physical attempt out of
`in-flight`, releasing its reservation without a separate cleanup path. A
terminal `billing_unknown` result is never silently counted as zero: it remains
in the Unknown report and requires reconciliation before treating the
confirmed-cost bound as a finalized provider invoice total.
