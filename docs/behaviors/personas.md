# Behavior personas

These personas were fixed before the behavior catalog was derived. They are
general user types evidenced by the capability inventory and the product
strategy. One person may occupy more than one role, but each role has a
distinct outcome against which a proposed behavior can be tested.

<!-- persona-id: lawful-game-owner -->

## Lawful game owner and localization producer

**Wants:** Select the exact release they lawfully hold, choose target locales
and localization scope, provide style and terminology direction, start or
resume localization, and receive a complete playable patch.

**Never wants to think about:** Archive layouts, encryption offsets, runtime
opcodes, agent choreography, retry mechanics, or a family-specific product
workflow.

**Done means:** Every configured surface has one valid target; the patch
validates against the selected source, visibly plays in the chosen locale, and
retains its source, locale, cost, and privacy lineage. Export becomes available
only after the producer or their reviewer has played that exact patch.

<!-- persona-id: playtest-reviewer -->

## Playtest reviewer and refinement director

**Wants:** Review a translation without operating the localization run, play an
immutable patch in context, compare source and target evidence, edit high-level
Wiki or style guidance, record scene or moment notes, batch feedback, trigger a
new whole review round, and compare patch versions.

**Never wants to think about:** Extraction, model routing, provider mechanics,
raw unit identifiers, or per-unit accept, reject, edit, and defer queues inside
the agent loop.

**Done means:** Feedback is bound to the exact patch that was played and
causally produces a new immutable child patch. Unrelated content remains
unchanged, a failed child leaves its parent usable, and export consumes the
play receipt for the exact version being exported.

<!-- persona-id: portfolio-operator -->

## Localization portfolio operator

**Wants:** Configure branch policy, models, privacy, budgets, and limits; run
multiple projects and locales; pause, resume, or cancel work; and understand
progress, blockers, cost, and provider privacy status.

**Never wants to think about:** Translation-unit adjudication, manual state
repair, worker leases, caches, or storage transactions.

**Done means:** Projects and locales remain isolated, every run exposes a
truthful state and next action, restart or resume duplicates no committed work,
actual usage and cost reconcile, and missing required content can never appear
as success.

<!-- persona-id: service-operator -->

## Deployment and service operator

**Wants:** Install and initialize the service, provision its declared
dependencies, diagnose health, operate durable work and artifacts, recover
from faults, and update or roll back self-hosted and managed placements.

**Never wants to think about:** Game semantics, per-engine switches, embedded
secret material, or repository-specific development machinery.

**Done means:** A clean supported host completes the documented product
journey, declared service boundaries are reachable, crashes recover once
without corrupting accepted work, artifacts survive, and upgrades preserve
data or roll back safely.

<!-- persona-id: organization-admin -->

## Organization and account administrator

**Wants:** Manage identities, single sign-on, memberships, permissions,
sessions, invitations, seats, billing views, and security audit history.

**Never wants to think about:** Database schemas, permission-resolution
algorithms, token material, or provider roles being mistaken for application
authority.

**Done means:** Invite, seat, and revocation changes are transactional;
effective access changes as declared; every actor sees only authorized account
and project data; and identity and session changes are auditable.

<!-- persona-id: custody-admin -->

## Customer privacy and custody administrator

**Wants:** Control keys, plaintext egress, allowed provider destinations,
one-use grants, retention, deletion, and publication of redacted evidence while
inspecting content-free receipts.

**Never wants to think about:** Operator implementation details or trusting
operator-served code as proof that custody policy held.

**Done means:** Wrong, replayed, stale, or spent grants and unapproved
destinations fail; a no-egress run emits no plaintext; actual calls, tokens,
provider, model, and cost are receipted; private sentinels remain unavailable
to the service operator; and public views expose no private payload.

<!-- persona-id: engine-contributor -->

## Engine-support and corpus contributor

**Wants:** Add one engine family or profile through a documented extension
boundary, qualify it on lawful inputs, and publish a truthful statement of
which identification, extraction, patching, and runtime outcomes it supports.

**Never wants to think about:** Coordinated edits to central engine lists,
product-workflow changes, or exposing private retail bytes, keys, and paths in
public evidence.

**Done means:** The family distinguishes positives, negatives, collisions, and
unknown variants; applicable operations pass the same public-boundary
behaviors as other engines; two independent real inputs support any real-family
claim; and exact limitations remain visible.

<!-- persona-id: quality-lead -->

## Translation evaluation and quality lead

**Wants:** Compare current, reference, baseline, and ablation outputs on a
locked holdout; evaluate multiple quality dimensions; calibrate against human
evidence; reproduce cost and latency; and turn failures into inspectable
improvement work.

**Never wants to think about:** Contestant identity or order leakage, unequal
context, opaque aggregate winners, or fresh provider calls merely to replay a
report.

**Done means:** Contestants cover identical inputs and allowed context;
seeded defects, bias, or provenance leakage invalidate the result; metrics,
agreement, bills, and latency reproduce; every required score independently
gates readiness; and failures create evidence-linked backlog items.

## Persona filter

Catalog stewardship is shared by the localization producer, service operator,
and engine-support contributor; it does not require an invented persona.
Automated agents are implementation actors, not user personas.

A capability does not become a separate behavior when its only subject is:

- an engine, profile, codec, parser, virtual machine, or runtime implementation;
- an internal role roster, scheduler, cache, journal, registry, schema, module,
  crate, file, database technology, or framework;
- concurrent edits, code organization, CI topology, worktree setup, linting,
  line budgets, generated-file drift, or other repository governance;
- evidence bookkeeping or a claim about tests rather than an observable user
  outcome;
- a retired planning mechanism; or
- a human per-unit mutation or decision queue that violates the whole-round
  refinement boundary.

Such entries must be folded into a portable outcome wanted by a persona or
explicitly dropped with a reason. Engine families, target locales, profiles,
placements, providers, and run modes are parameters of behaviors, never
personas and never duplicate behaviors.
