# UTSUSHI-027 — Trace and branch conformance

- **Node**: UTSUSHI-027
- **Title**: Trace and branch conformance
- **Branch**: `spec/utsushi-027`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-027`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress → ready_for_review (single implementation slice)
- **Dependency layer landed**: UTSUSHI-020 (VFS), UTSUSHI-021 (input / clock /
  replay), UTSUSHI-022 (sinks), UTSUSHI-103 (engine port runner template),
  UTSUSHI-026 (conformance manifest + result schema) all on main.

## 1. Goal restatement

UTSUSHI-026 shipped the **declarative half** of the conformance contract: a
manifest that says which profiles an adapter claims and a result schema that
reports one outcome per profile. UTSUSHI-027 ships the first two **executable
checks** that ride on top of that contract — the only checks that the
`text-trace` and `branch-capture` profiles authorise:

1. A **trace conformance check** that compares a golden ordered text trace
   against an observed text trace and produces a typed Pass/Fail with
   per-event mismatch diagnostics.
2. A **branch conformance check** that compares a golden ordered set of
   discovered branches (and each branch's choice-index path + expected
   outcome label) against the observed set and produces the same shape.
3. A **bridge-unit linkage rule** that fails (does not silently pass) when an
   observed text event has no `bridge_unit_id` or when its bridge unit id
   diverges from the golden expectation.
4. Two **golden fixture trees** (one matching, one negative-per-mismatch-kind)
   under `crates/utsushi-core/tests/fixtures/conformance/trace_branch/` that
   validate independently — no engine adapter required to exercise the check.
5. The new `utsushi.conformance.*` semantic codes added to
   `conformance::diagnostics::codes::ALL`, mirroring the UTSUSHI-026
   precedent so the downstream allowed-code validator stays exhaustive.

The audit-focus items this slice has to make unrepresentable:

- **Trace-only evidence overclaiming rendered playback.** The check trait
  rejects a Pass that claims an evidence tier above the profile-id ceiling
  (`E1` for both `text-trace` and `branch-capture` per UTSUSHI-026 §3). Trace
  conformance MUST NOT cite frame/screenshot evidence; the check's evidence
  surface only emits `EvidenceRef::TextLine`, `EvidenceRef::BridgeUnit`,
  `EvidenceRef::ReplayLogRef`, and `EvidenceRef::ImplMapFixture`. A typed
  evidence filter (§9) rejects `EvidenceRef::RuntimeArtifact { kind:
Screenshot | FrameCapture | Recording, .. }` at construction time.
- **Branch mismatches hidden as skipped checks.** Skip is **forbidden** for
  the two declared profiles by UTSUSHI-026's
  `cross_validate_results_against_manifest`. UTSUSHI-027 surfaces missing
  branches as a typed `Fail` variant with the
  `utsushi.conformance.branch_missing` code; it never emits Skip from inside
  the check.
- **Bridge-unit links missing from conformance output.** Every observed text
  event MUST carry a `bridge_unit_id`. Unlinked events fail with
  `utsushi.conformance.bridge_unit_unlinked`. The Pass-emitting path also
  appends an `EvidenceRef::BridgeUnit` per checked text event so the
  ingestion side (UTSUSHI-030) can join traces to bridge units without
  recomputing.

### Downstream constraints

- **UTSUSHI-030** (ingestion fixture, `dependsOn` UTSUSHI-027) consumes
  `ConformanceResult` entries whose `profile_id` is `TextTrace` or
  `BranchCapture`. The `EvidenceRef::BridgeUnit` references must
  round-trip through the JSON wire shape that UTSUSHI-026 already
  defined. UTSUSHI-027 adds **no new** wire-format variants; it produces
  results that fit the UTSUSHI-026 schema verbatim. The new codes added
  to `codes::ALL` are the only schema-visible delta.
- **UTSUSHI-028 / UTSUSHI-029** (snapshot / capture conformance) sit in the
  same parallel group. They will add their own check types but MUST be
  additive to the UTSUSHI-026 enums. UTSUSHI-027 commits to the same rule
  (§14): no breaking change to `ResultOutcome`, `EvidenceRef`, or
  `ProfileId`. The trait surface is internal to UTSUSHI-027 and does not
  re-export typed result enums to consumers.
- **UTSUSHI-031..039** (engine ports) will eventually populate
  `ObservedTextEvent` / `ObservedBranch` arrays from real adapters.
  UTSUSHI-027 does NOT touch engine ports; it ships with synthetic
  fixtures only.

### Distinction from UTSUSHI-022 (text sink) and UTSUSHI-021 (replay log)

- UTSUSHI-022 already emits `TextLine { line_id, evidence_tier, text,
speaker, text_surface, bridge_ref, source_asset }`. UTSUSHI-027 does NOT
  redefine that struct; it consumes `TextLine` indirectly through an adapter
  that lowers `TextLine` into `ObservedTextEvent`. The lowering is a
  test-utility helper, **not** a public engine-port contract — engine ports
  will land their own lowering as part of UTSUSHI-031+ (out of scope here).
- UTSUSHI-021 already records `InputEvent::Choice { index: ChoiceIndex,
bridge_unit_id }` in `ReplayLog`. UTSUSHI-027 does NOT redefine choice
  recording; it consumes the recorded `ChoiceIndex` path through an
  adapter that lowers `ReplayLog` cursor events into the
  `choice_index_path: Vec<ChoiceIndex>` field of `ObservedBranch`. Same
  rule as the trace lowering: test-utility only, engine ports own the
  production wiring.

## 2. Module placement

**Recommendation**: keep the trace + branch check substrate in
`utsushi-core` as a new submodule
`utsushi_core::conformance::trace_branch`, sibling to
`utsushi_core::conformance::{manifest, result, diagnostics, fixtures}`.

Justification (mirrors the UTSUSHI-026 placement reasoning):

- The check trait and the data types both need
  `EvidenceTier`, `EvidenceRef`, `ResultOutcome`, `ConformanceResult`,
  `ProfileId`, `ConformanceError`. All live in `utsushi-core`.
- The fixture loader needs `serde_json` (already pulled in by
  `utsushi-core`), nothing else.
- A separate `utsushi-conformance-checks` crate would require re-exporting
  every UTSUSHI-026 type or adding a `utsushi-core` dep. Zero isolation
  win; one extra dep edge per downstream node.
- Module layout matches the precedent already set by `conformance/manifest`
  and `conformance/result`.

**Submodule layout under `crates/utsushi-core/src/conformance/trace_branch/`:**

```
crates/utsushi-core/src/conformance/trace_branch/
  mod.rs           # re-exports + crate docs + TraceConformanceCheck
                   #   + BranchConformanceCheck + run() helpers
  trace.rs         # TraceConformanceCheck, GoldenTextEvent,
                   #   ObservedTextEvent, TraceCheckResult, TraceMismatch,
                   #   TraceCheckOptions, evidence-tier filter
  branch.rs        # BranchConformanceCheck, GoldenBranch,
                   #   ObservedBranch, BranchCheckResult, BranchMismatch,
                   #   BranchCheckOptions
  fixtures.rs      # Loaders + builders for the
                   #   tests/fixtures/conformance/trace_branch/* tree.
                   #   Gated #[cfg(any(test, feature =
                   #   "conformance-fixtures"))] so UTSUSHI-030 tests can
                   #   opt in via dev-dep without exposing the loader on
                   #   release builds.
```

`utsushi-core/src/lib.rs` adds (within the existing conformance re-export
block — additive, no rename):

```rust
pub use conformance::trace_branch::{
    BranchCheckOptions, BranchCheckResult, BranchConformanceCheck,
    BranchMismatch, BranchMismatchKind, GoldenBranch, GoldenTextEvent,
    ObservedBranch, ObservedTextEvent, TraceCheckOptions, TraceCheckResult,
    TraceConformanceCheck, TraceMismatch, TraceMismatchKind,
};
```

**No new workspace member.** **No new third-party dep.** (`serde`,
`serde_json` already present.)

## 3. Trace check shape

### 3.1 `TraceConformanceCheck`

```rust
/// Single trace conformance check. Bound to the `text-trace` profile;
/// the profile_id field is set at construction so the type cannot drift.
#[derive(Clone, Debug)]
pub struct TraceConformanceCheck {
    /// Always `ProfileId::TextTrace`. The field exists to keep the
    /// result construction site honest — `into_result()` reads from this
    /// field, not a `match` on the type.
    profile_id: ProfileId,
    /// Adapter id that owns this check. Lowered into the result's
    /// `adapter_id` and validated against the UTSUSHI-026 id pattern at
    /// `new()` time.
    adapter_id: String,
    /// Ordered golden trace. The order is the assertion: the observed
    /// trace MUST present the same `(text, speaker?, bridge_unit_id)`
    /// tuples in the same `order_index` sequence.
    golden_trace: Vec<GoldenTextEvent>,
    /// Ordered observed trace as lowered by the adapter under test.
    observed_trace: Vec<ObservedTextEvent>,
    /// Check-time options (see §3.4).
    options: TraceCheckOptions,
}

impl TraceConformanceCheck {
    /// Build a check. Validates that
    /// (a) `adapter_id` matches the UTSUSHI-026 id pattern,
    /// (b) golden_trace is non-empty,
    /// (c) golden_trace `order_index` values form `0..golden_trace.len()`
    ///     (strictly monotonic, no gaps),
    /// (d) every `GoldenTextEvent.bridge_unit_id` is non-empty and not a
    ///     local-path leak (reuses UTSUSHI-026 `validate_id_string`-style
    ///     check via the public re-export).
    /// Returns `ConformanceError` on any failure.
    pub fn new(
        adapter_id: impl Into<String>,
        golden_trace: Vec<GoldenTextEvent>,
        observed_trace: Vec<ObservedTextEvent>,
        options: TraceCheckOptions,
    ) -> Result<Self, ConformanceError>;

    /// Execute the check and return a structured result.
    /// Pass: golden and observed traces are equivalent under the
    ///   options' comparison rules, every observed event carries a
    ///   non-empty bridge_unit_id, no tier overclaim has been declared.
    /// Fail: at least one mismatch produced; the result enumerates all
    ///   of them (early exit only on the construction-time invariants,
    ///   never inside the comparison loop — auditors need to see every
    ///   mismatch, not just the first).
    pub fn run(&self) -> TraceCheckResult;
}
```

### 3.2 `GoldenTextEvent` and `ObservedTextEvent`

```rust
/// Golden expectation for a single text trace event. Engine-neutral.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenTextEvent {
    /// Stable id the golden fixture assigns. Lowered into mismatch
    /// diagnostics as `expected_event_id`. Pattern: same as the UTSUSHI-026
    /// id string rules (non-empty, no whitespace, no local-path leak).
    pub event_id: String,
    /// Bridge unit linkage. Required — empty / missing is a Fail at
    /// `TraceConformanceCheck::new()` time (golden side: it is a
    /// fixture-author error to commit an unlinked golden event).
    pub bridge_unit_id: String,
    /// Expected runtime-visible text. Exact match by default; the
    /// `text_normalisation` option (§3.4) controls whitespace folding.
    pub text: String,
    /// Optional speaker label. When present, the observed event's
    /// speaker MUST equal it (a None golden speaker means the observed
    /// event may have any speaker — explicit "don't care" semantics).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    /// 0-based ordering claim. Validated at construction (§3.1) to
    /// match the vector index.
    pub order_index: u32,
}

/// Adapter-emitted text trace event. The adapter is responsible for
/// lowering a `TextLine` (UTSUSHI-022) into this shape; the check does
/// not see `TextLine` directly because that struct carries
/// optional fields (asset id, surface label) the check has no business
/// asserting on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedTextEvent {
    /// Stable id the adapter assigned to the emission (e.g. the
    /// `TextLine.line_id` from UTSUSHI-022). Surfaced in mismatch
    /// diagnostics as `observed_event_id`.
    pub event_id: String,
    /// Bridge-unit linkage from the adapter. Optional on the wire
    /// (because the adapter may legitimately observe a line whose
    /// bridge unit lookup failed) BUT a missing value is itself the
    /// `BridgeUnitUnlinked` mismatch kind. The Option vs typed-None
    /// asymmetry is deliberate: it forces the failure case to surface
    /// as a typed mismatch rather than a panic.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_unit_id: Option<String>,
    /// Observed text after engine substitution.
    pub text: String,
    /// Observed speaker label, if the adapter saw one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    /// 0-based observed order. The check compares this against the
    /// golden's `order_index` for the `OrderShift` mismatch.
    pub order_index: u32,
}
```

### 3.3 `TraceCheckResult` and `TraceMismatch`

```rust
/// The check's outcome. The Pass variant carries the evidence the
/// runner will lower into a `ConformanceResult.evidence` field; the Fail
/// variant carries the per-mismatch diagnostics.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TraceCheckResult {
    Pass {
        /// One `EvidenceRef::TextLine` per checked observed event, in
        /// observed order, followed by one `EvidenceRef::BridgeUnit` per
        /// unique bridge unit referenced. The evidence list is also
        /// available to UTSUSHI-027 callers who need to populate a
        /// `ConformanceResult` directly via `into_conformance_result()`
        /// (§7).
        evidence_refs: Vec<EvidenceRef>,
    },
    Fail {
        /// All mismatches; never truncated. Ordered by golden
        /// `order_index` so reviewers read it in trace order.
        mismatches: Vec<TraceMismatch>,
        /// Evidence cited even on failure — the observed text lines and
        /// bridge units that the adapter DID produce. Lets ingestion
        /// (UTSUSHI-030) surface "we got this far" without re-running.
        evidence_refs: Vec<EvidenceRef>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceMismatch {
    pub kind: TraceMismatchKind,
    /// Expected event id from the golden trace. Always set so the
    /// reviewer can join to the fixture by id alone.
    pub expected_event_id: String,
    /// Observed event id from the adapter. None only when the observed
    /// trace is shorter than the golden trace and the mismatch is a
    /// `Missing` kind (§3.3.1). The `Option<String>` shape is the only
    /// place we permit absence; everywhere else (BridgeUnitUnlinked,
    /// SpeakerMismatch, TextDifference, OrderShift) we have a real
    /// observed event id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_event_id: Option<String>,
    /// Short, public-string description (e.g. "expected speaker 'Akari'
    /// observed 'Akarii'"). Never a host path; the `redaction` rules
    /// from UTSUSHI-026 apply.
    pub detail: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TraceMismatchKind {
    /// `text` field differs (after optional normalisation).
    TextDifference,
    /// Observed `order_index` differs from golden `order_index`.
    OrderShift,
    /// Observed event has no `bridge_unit_id` set (the Option is None).
    BridgeUnitUnlinked,
    /// Observed `bridge_unit_id` is present but differs from the
    /// golden's `bridge_unit_id`.
    BridgeUnitDivergent,
    /// Golden speaker is Some(...) and observed speaker differs (or is
    /// None).
    SpeakerMismatch,
    /// Observed trace is shorter than the golden trace and a
    /// corresponding observed event is missing entirely.
    Missing,
    /// Observed trace is longer than the golden trace and an extra
    /// observed event is present after the golden's last entry.
    Unexpected,
}
```

#### 3.3.1 Mismatch semantics

Pairing rule: for each `i` in `0..max(golden.len(), observed.len())`:

- If `i >= observed.len()`: emit `Missing` (`expected_event_id =
golden[i].event_id`, `observed_event_id = None`).
- If `i >= golden.len()`: emit `Unexpected` (`expected_event_id` is the
  sentinel string `"<beyond-golden>"` — committed as a const so reviewers
  can grep for it; `observed_event_id = Some(observed[i].event_id)`).
- Else compare `golden[i]` against `observed[i]` and emit zero or more
  per-field mismatches in this fixed order:
  1. `BridgeUnitUnlinked` if `observed[i].bridge_unit_id.is_none()`.
  2. `BridgeUnitDivergent` if both ids are present but differ.
  3. `OrderShift` if `observed[i].order_index != golden[i].order_index`.
  4. `TextDifference` if the (optionally-normalised) text differs.
  5. `SpeakerMismatch` if `golden[i].speaker.is_some()` and the speakers
     do not match.

The fixed evaluation order lets reviewers reason about which check ran
first: bridge-unit linkage is checked before order, because an unlinked
event makes the ordering claim less interesting. The check still emits
**every** failing kind for the same `i` — no short-circuit per event —
so the diagnostics are exhaustive.

### 3.4 `TraceCheckOptions`

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TraceCheckOptions {
    /// How to normalise text before comparison. Default
    /// `TextNormalisation::Exact` — byte-for-byte equality. The other
    /// variant collapses runs of ASCII whitespace and trims leading /
    /// trailing whitespace. NFC normalisation is NOT applied here; the
    /// substrate already mandates UTF-8 NFC at the sink boundary
    /// (UTSUSHI-022).
    pub text_normalisation: TextNormalisation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextNormalisation {
    Exact,
    CollapseWhitespace,
}

impl Default for TraceCheckOptions {
    fn default() -> Self {
        Self {
            text_normalisation: TextNormalisation::Exact,
        }
    }
}
```

No other knobs. The audit-focus item "Trace-only evidence overclaiming
rendered playback" means the check has no "ignore screenshot mismatches"
mode — it doesn't deal with screenshots at all, period. No "skip empty
events" mode either: a non-empty golden requires a non-empty observed
counterpart at the same index.

## 4. Branch check shape

### 4.1 `BranchConformanceCheck`

```rust
/// Branch conformance check. Bound to the `branch-capture` profile.
#[derive(Clone, Debug)]
pub struct BranchConformanceCheck {
    profile_id: ProfileId, // Always BranchCapture.
    adapter_id: String,
    golden_branches: Vec<GoldenBranch>,
    observed_branches: Vec<ObservedBranch>,
    options: BranchCheckOptions,
}

impl BranchConformanceCheck {
    /// (a) Validate adapter_id pattern.
    /// (b) golden_branches non-empty.
    /// (c) golden_branches have unique `branch_id` values.
    /// (d) Every `choice_index_path` is non-empty (a branch with no
    ///     choices is not a branch). Each path element must be a valid
    ///     `ChoiceIndex` (u16, no further check — the type itself
    ///     enforces).
    /// (e) Every `expected_outcome` matches the public outcome label
    ///     pattern: `^[a-z][a-z0-9_]{0,63}$` (snake_case engine-neutral
    ///     label, e.g. "happy_end", "true_route", "branch_to_chapter_2").
    pub fn new(
        adapter_id: impl Into<String>,
        golden_branches: Vec<GoldenBranch>,
        observed_branches: Vec<ObservedBranch>,
        options: BranchCheckOptions,
    ) -> Result<Self, ConformanceError>;

    pub fn run(&self) -> BranchCheckResult;
}
```

### 4.2 `GoldenBranch` and `ObservedBranch`

```rust
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenBranch {
    /// Stable branch identifier from the golden fixture. Surfaced in
    /// mismatch diagnostics.
    pub branch_id: String,
    /// Ordered choice-index path to reach this branch. Uses the same
    /// `ChoiceIndex` (u16) that UTSUSHI-021 records inside
    /// `ReplayLog::InputEvent::Choice`. Empty path is rejected at
    /// `new()` (§4.1d).
    pub choice_index_path: Vec<ChoiceIndex>,
    /// Engine-neutral outcome label. Pattern enforced at `new()` (§4.1e).
    pub expected_outcome: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedBranch {
    pub branch_id: String,
    pub choice_index_path: Vec<ChoiceIndex>,
    pub observed_outcome: String,
}
```

The check compares by `branch_id`, NOT by index. Adapters may emit
branches in any order; the check's pairing pass builds a map keyed by
`branch_id` (golden) and walks the observed set against it. This is the
opposite policy from the trace check, which is index-paired. Justification:

- Trace events are inherently ordered — the audit claim IS the order.
- Branch discovery is an unordered set with optional ordering only when
  the adapter happens to traverse depth-first. The check has no business
  asserting traversal order; it asserts the SET equivalence + per-branch
  path + per-branch outcome.

The "branch ordering deterministic when adapter doesn't sort" risk
(§13.2) lives here; the resolution above (id-keyed comparison) is the
mitigation.

### 4.3 `BranchCheckResult` and `BranchMismatch`

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BranchCheckResult {
    Pass {
        /// One `EvidenceRef::BridgeUnit` per branch (the choice-index
        /// path's terminal branch unit) plus one `EvidenceRef::ReplayLogRef`
        /// if the check was constructed with a replay-log id via
        /// options (§4.4).
        evidence_refs: Vec<EvidenceRef>,
    },
    Fail {
        mismatches: Vec<BranchMismatch>,
        evidence_refs: Vec<EvidenceRef>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchMismatch {
    pub kind: BranchMismatchKind,
    pub expected_branch_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_branch_id: Option<String>,
    pub detail: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BranchMismatchKind {
    /// Golden branch id is not present in the observed set.
    Missing,
    /// Observed branch id is not present in the golden set.
    Unexpected,
    /// Branch ids match but the `choice_index_path` differs (any
    /// element-wise difference, including length).
    ChoicePathDivergent,
    /// Branch ids match but `observed_outcome != expected_outcome`.
    OutcomeDifference,
}
```

The four kinds map 1:1 to the four ways an observed-set vs golden-set
join can fail. Audit-focus claim "Branch mismatches hidden as skipped
checks" is enforced structurally: `BranchMismatchKind::Missing` exists,
there is no `Skipped` variant on this enum.

### 4.4 `BranchCheckOptions`

```rust
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct BranchCheckOptions {
    /// Optional `ReplayLog.run_id` (UTSUSHI-021) to cite as evidence
    /// when the check passes. When `None`, the evidence list does not
    /// include a `ReplayLogRef`. This is the ONLY optionality in
    /// UTSUSHI-027 because it represents the legitimate "the check was
    /// invoked without a replay log on hand" case, not a missing
    /// requirement. The check still passes / fails on the same merits;
    /// only the evidence richness changes.
    pub replay_log_run_id: Option<String>,
}
```

## 5. Mismatch diagnostics — every kind, both checks

For convenience and to satisfy the brief's requirement that "each mismatch
identifies expected + observed runtime event id", the table below shows
every mismatch kind and the diagnostic fields it always populates.

| Kind                | expected_event_id    | observed_event_id  | detail content                                                | Stable code                                       |
| ------------------- | -------------------- | ------------------ | ------------------------------------------------------------- | ------------------------------------------------- |
| TextDifference      | golden.event_id      | observed.event_id  | normalised expected/observed text, truncated to 256 bytes     | `utsushi.conformance.trace_text_mismatch`         |
| OrderShift          | golden.event_id      | observed.event_id  | expected/observed `order_index`                               | `utsushi.conformance.trace_order_mismatch`        |
| BridgeUnitUnlinked  | golden.event_id      | observed.event_id  | "observed event has no bridge_unit_id"                        | `utsushi.conformance.bridge_unit_unlinked`        |
| BridgeUnitDivergent | golden.event_id      | observed.event_id  | expected/observed bridge_unit_id                              | `utsushi.conformance.bridge_unit_divergent`       |
| SpeakerMismatch     | golden.event_id      | observed.event_id  | expected/observed speaker label (None rendered as `"<none>"`) | `utsushi.conformance.trace_speaker_mismatch`      |
| Missing (trace)     | golden.event_id      | None               | "observed trace ended at index N"                             | `utsushi.conformance.trace_event_missing`         |
| Unexpected (trace)  | `"<beyond-golden>"`  | observed.event_id  | observed extra event at index N                               | `utsushi.conformance.trace_event_unexpected`      |
| Missing (branch)    | golden.branch_id     | None               | "branch not present in observed set"                          | `utsushi.conformance.branch_missing`              |
| Unexpected (branch) | `"<unknown-golden>"` | observed.branch_id | "observed branch absent from golden"                          | `utsushi.conformance.branch_unexpected`           |
| ChoicePathDivergent | golden.branch_id     | observed.branch_id | choice path delta (head index / length, no full list)         | `utsushi.conformance.branch_choice_path_mismatch` |
| OutcomeDifference   | golden.branch_id     | observed.branch_id | expected/observed outcome label                               | `utsushi.conformance.branch_outcome_mismatch`     |

Two policy notes:

- `detail` is the **only** free-form field. It is capped at 256 bytes,
  ASCII / printable Unicode only, and passes through the same
  `reject_unredacted_local_paths` filter used elsewhere in
  `utsushi-core` so a leaked host path cannot enter the diagnostic.
- The `"<beyond-golden>"` and `"<unknown-golden>"` sentinel strings are
  exported as constants from `trace_branch::trace` and
  `trace_branch::branch` so the codes can be matched cleanly without
  string literals scattered across consumers.

## 6. Stable semantic codes

Added to `conformance::diagnostics::codes` (UTSUSHI-026's module) and to
`codes::ALL`. Twelve new codes:

```rust
pub const TRACE_TEXT_MISMATCH: &str = "utsushi.conformance.trace_text_mismatch";
pub const TRACE_ORDER_MISMATCH: &str = "utsushi.conformance.trace_order_mismatch";
pub const TRACE_SPEAKER_MISMATCH: &str = "utsushi.conformance.trace_speaker_mismatch";
pub const TRACE_EVENT_MISSING: &str = "utsushi.conformance.trace_event_missing";
pub const TRACE_EVENT_UNEXPECTED: &str = "utsushi.conformance.trace_event_unexpected";
pub const BRIDGE_UNIT_UNLINKED: &str = "utsushi.conformance.bridge_unit_unlinked";
pub const BRIDGE_UNIT_DIVERGENT: &str = "utsushi.conformance.bridge_unit_divergent";
pub const BRANCH_MISSING: &str = "utsushi.conformance.branch_missing";
pub const BRANCH_UNEXPECTED: &str = "utsushi.conformance.branch_unexpected";
pub const BRANCH_CHOICE_PATH_MISMATCH: &str = "utsushi.conformance.branch_choice_path_mismatch";
pub const BRANCH_OUTCOME_MISMATCH: &str = "utsushi.conformance.branch_outcome_mismatch";
pub const TRACE_EVIDENCE_TIER_OVERCLAIM: &str = "utsushi.conformance.trace_evidence_tier_overclaim";
```

The twelfth (`TRACE_EVIDENCE_TIER_OVERCLAIM`) is the failure code when a
caller attempts to convert a `TraceCheckResult::Pass { evidence_refs }`
into a `ConformanceResult` with `EvidenceTier > E1`. The tier-overclaim
case is also caught by UTSUSHI-026's
`ConformanceResult::validate` as `evidence_tier_above_profile_ceiling`,
but the trace-specific code surfaces earlier and points reviewers at
the trace check rather than the generic schema validator. Both checks
fire on the same condition; the trace-specific code is the audit-focus
defense.

Each new constant is appended to `codes::ALL`; the existing
`#[cfg(test)]` parity assertion in UTSUSHI-026's diagnostics module
(every `ConformanceError::semantic_code()` is in `ALL`) is extended to
cover the new codes by adding a similar parity test in
`trace_branch::trace::tests` and `trace_branch::branch::tests` that
verifies every `TraceMismatchKind` → code mapping and every
`BranchMismatchKind` → code mapping is a member of `codes::ALL`. The
mapping itself lives in two small free functions
(`trace_mismatch_code(kind: TraceMismatchKind) -> &'static str` and the
branch equivalent) so the test can iterate the enum exhaustively via
`#[deny(unreachable_patterns)]` discipline.

### 6.1 Mapping `kaifuu.*` pass-through

UTSUSHI-026's result schema permits `utsushi.*` and `kaifuu.*` provider
prefixes in `Fail.semantic_code`. UTSUSHI-027 does NOT extend this to a
third provider; the trace and branch checks always emit
`utsushi.conformance.*` codes when they themselves diagnose. A future
engine port that needs to surface a `kaifuu.profile.unknown_key` (e.g.
during bridge-unit resolution) routes it through the existing
`ResultOutcome::Fail.semantic_code` field at the `ConformanceResult`
boundary, not inside `TraceMismatch.kind`.

## 7. Bridge-unit linkage rule

Hard-constraint restatement: "each text trace event links to a bridge
unit id".

Implementation:

1. **Golden side**: `GoldenTextEvent.bridge_unit_id: String` is
   non-optional at the type level. A golden fixture with a missing
   bridge unit cannot be loaded — the deserializer rejects with the
   serde "missing field" error and the loader maps that to
   `ConformanceError::EvidenceRefInvalid { artifact_kind: "bridge_unit",
.. }`. (We do not surface the raw serde error.)
2. **Observed side**: `ObservedTextEvent.bridge_unit_id:
Option<String>` deliberately allows None so the check can emit a
   typed `BridgeUnitUnlinked` mismatch rather than the adapter being
   forced to lie. The Pass path requires every observed event have
   Some(id); the typed Fail path emits when any is None.
3. **Evidence emission**: on Pass, the check appends one
   `EvidenceRef::BridgeUnit { bridge_unit_id }` per **unique** bridge
   unit id (deduped) so the ingestion side does not see N duplicates for
   N events on the same unit. The dedupe order is first-occurrence so
   the citation is stable.
4. **Conformance result helper**:

   ```rust
   impl TraceCheckResult {
       /// Lower this check result into the UTSUSHI-026 result schema.
       /// `evidence_tier` MUST be `E1` (TextTrace profile ceiling);
       /// anything higher is rejected with the
       /// `TRACE_EVIDENCE_TIER_OVERCLAIM` code rather than silently
       /// downgraded.
       pub fn into_conformance_result(
           self,
           adapter_id: &str,
           evidence_tier: EvidenceTier,
           recorded_at: &str,
       ) -> Result<ConformanceResult, ConformanceError>;
   }

   impl BranchCheckResult {
       pub fn into_conformance_result(
           self,
           adapter_id: &str,
           evidence_tier: EvidenceTier,
           recorded_at: &str,
       ) -> Result<ConformanceResult, ConformanceError>;
   }
   ```

   Both helpers call `ConformanceResult::validate()` before returning
   (UTSUSHI-026 already does this from `from_json_value`; we mirror it
   here so the lowered result is structurally valid by construction).

## 8. Golden trace fixtures

Fixture tree under
`crates/utsushi-core/tests/fixtures/conformance/trace_branch/`:

```
trace_branch/
  positive/
    matching_trace.json         # 5 events, monotonic order, all linked
    matching_branches.json      # 3 branches, 2-3 element choice paths
    matching_trace_with_speakers.json  # 4 events, speakers populated
  negative/
    text_diff.json              # 5-event trace, event[2].text differs
    order_shift.json             # 5-event trace, event[2] and event[3]
                                #   swapped in observed
    branch_missing.json          # 3 golden branches, observed omits 1
    bridge_unit_unlinked.json    # 4-event trace, observed event[1].bridge_unit_id = None
    bridge_unit_divergent.json   # 4-event trace, observed event[2] linked
                                 #   to a different (well-formed) bridge unit
    speaker_mismatch.json        # 4-event trace, observed event[1].speaker
                                 #   differs from golden
    trace_event_missing.json     # 5 golden events, observed has 4
    trace_event_unexpected.json  # 5 golden events, observed has 6
    branch_choice_path_divergent.json
    branch_outcome_difference.json
    branch_unexpected.json       # observed has an extra branch
```

Each JSON file is a single object with two top-level arrays
(`goldenTrace`/`observedTrace`, OR `goldenBranches`/`observedBranches`)
plus an `options` block. The fixture loader
(`trace_branch::fixtures`) calls the appropriate `Check::new()` and
returns the constructed check; the test then calls `.run()` and asserts
the expected `Pass`/`Fail` shape.

Fixture file shape (illustrative, schema is the serde-derived JSON of
the types in §3-4):

```json
{
  "options": { "textNormalisation": "exact" },
  "goldenTrace": [
    {
      "eventId": "g-001",
      "bridgeUnitId": "0190a000-0000-7000-8000-000000000001",
      "text": "Hello",
      "orderIndex": 0
    },
    ...
  ],
  "observedTrace": [
    {
      "eventId": "o-001",
      "bridgeUnitId": "0190a000-0000-7000-8000-000000000001",
      "text": "Hello",
      "orderIndex": 0
    },
    ...
  ]
}
```

The positive fixtures validate to `Pass`. Every negative fixture
validates to `Fail` with a specific expected `mismatches[*].kind` set
asserted by the test (one test per fixture; the test name encodes which
kind it claims to provoke — see §10). The fixtures DO NOT carry an
asserted `evidence_refs` field; that is generated by the check and
tested separately. The point of the fixture is the input pair, not the
output snapshot.

### 8.1 Why JSON and not Rust builders alone

The fixtures are JSON (not inline Rust `vec![]`) for three reasons:

- Reviewers can diff fixture changes without reading Rust.
- UTSUSHI-030 ingestion (downstream) will eventually round-trip the same
  JSON shape through its TypeScript validator. Committing the JSON now
  means UTSUSHI-030 can reuse the same files as input examples without
  re-deriving them.
- The audit-focus item "Trace-only conformance remains distinct from
  screenshot or reference-render conformance" is provable by reading the
  fixture: no screenshot URI, no frame-id reference, no recording URI.

Rust builder helpers (`fixtures::trace_check_from_json`,
`fixtures::branch_check_from_json`) wrap the JSON loader so the tests
stay terse. The helpers themselves are gated
`#[cfg(any(test, feature = "conformance-fixtures"))]` mirroring the
UTSUSHI-026 fixture-feature precedent.

## 9. Evidence tier discipline

The evidence-tier filter that backs the audit-focus "Trace-only
evidence overclaiming rendered playback" defense is a small
`accepts_text_trace_evidence(ref: &EvidenceRef) -> bool` function in
`trace_branch::trace`:

```rust
pub fn accepts_text_trace_evidence(evidence: &EvidenceRef) -> bool {
    match evidence {
        EvidenceRef::TextLine { .. }
        | EvidenceRef::BridgeUnit { .. }
        | EvidenceRef::ReplayLogRef { .. }
        | EvidenceRef::ImplMapFixture { .. } => true,
        EvidenceRef::FrameArtifactRef { .. } => false,
        EvidenceRef::RuntimeArtifact { kind, .. } => matches!(
            kind,
            // Trace logs and conformance reports are E1-bounded
            // text-shaped artifacts; allowed.
            RuntimeArtifactKind::TraceLog | RuntimeArtifactKind::ConformanceReport
        ),
    }
}
```

The `into_conformance_result()` helpers (§7) iterate the result's
`evidence_refs`, run them through `accepts_text_trace_evidence`, and
reject (with `TRACE_EVIDENCE_TIER_OVERCLAIM`) any that fail. Branch
conformance uses the analogous `accepts_branch_capture_evidence`
function with the same allowed set (text-trace and branch-capture share
the E1 ceiling and the same admissible evidence shapes).

The audit-focus claim is that this filter is enforced at construction
of the `ConformanceResult`, BEFORE the UTSUSHI-026 schema validator
runs. So a caller cannot construct a trace-conformance result that
cites a `FrameArtifactRef`, even by hand, even if they call
`ConformanceResult::validate()` afterwards — the trace-specific helper
will refuse to build it.

### 9.1 Tier ceiling in the result

`into_conformance_result(evidence_tier = EvidenceTier::E2)` for a
TextTrace profile is rejected immediately:

```rust
if evidence_tier > ProfileId::TextTrace.evidence_tier_ceiling() {
    return Err(ConformanceError::EvidenceTierAboveProfileCeiling { ... });
}
```

This is redundant with UTSUSHI-026's
`ConformanceResult::validate` rule (UTSUSHI-026 plan §5.3) but the
redundancy is intentional. The trace helper rejects on a tier-overclaim
attempt with a specific code (the trace-overclaim code) so the
diagnostic surfaces the trace check as the culprit, not the generic
schema validator. The same code is the audit hook for "no tier
inflation"; the generic schema-level check is the backstop.

## 10. Test plan

All tests follow `docs/testing-standard.md`: falsifiable, behavior-named,
synthetic inline / file fixtures only, no live providers, no private
corpora. Unit tests live with their modules; integration tests under
`crates/utsushi-core/tests/conformance_trace_branch.rs`.

### 10.1 Trace check (in `trace_branch/trace.rs::tests`)

Construction:

- `trace_check_new_accepts_well_formed_input()`.
- `trace_check_new_rejects_empty_golden_trace()`.
- `trace_check_new_rejects_golden_with_non_monotonic_order_indices()`.
- `trace_check_new_rejects_golden_with_empty_bridge_unit_id()`.
- `trace_check_new_rejects_golden_with_bridge_unit_id_local_path_substring()`.
- `trace_check_new_rejects_adapter_id_with_uppercase()`.

Positive run:

- `trace_check_run_passes_with_matching_traces()`.
- `trace_check_run_pass_emits_evidence_for_every_observed_event()`.
- `trace_check_run_pass_dedupes_bridge_unit_evidence_to_unique_ids()`.
- `trace_check_run_pass_applies_collapse_whitespace_normalisation()`.

Negative run (one test per mismatch kind):

- `trace_check_run_fails_with_text_difference_mismatch()`.
- `trace_check_run_fails_with_order_shift_mismatch()`.
- `trace_check_run_fails_with_bridge_unit_unlinked_mismatch()`.
- `trace_check_run_fails_with_bridge_unit_divergent_mismatch()`.
- `trace_check_run_fails_with_speaker_mismatch_when_golden_speaker_some()`.
- `trace_check_run_passes_when_golden_speaker_none_regardless_of_observed_speaker()`.
- `trace_check_run_fails_with_missing_event_when_observed_shorter()`.
- `trace_check_run_fails_with_unexpected_event_when_observed_longer()`.
- `trace_check_run_collects_all_per_event_mismatches_not_only_the_first()`.
- `trace_check_run_orders_mismatches_by_golden_order_index()`.

Diagnostics:

- `trace_mismatch_kind_to_code_is_exhaustive_over_enum_variants()`.
- `trace_mismatch_codes_are_all_members_of_codes_all()`.
- `trace_mismatch_detail_truncates_at_256_bytes()`.
- `trace_mismatch_detail_rejects_local_path_substring()`.

Sentinel:

- `trace_check_unexpected_mismatch_uses_documented_sentinel_event_id()`.

### 10.2 Branch check (in `trace_branch/branch.rs::tests`)

Construction:

- `branch_check_new_accepts_well_formed_input()`.
- `branch_check_new_rejects_empty_golden_branches()`.
- `branch_check_new_rejects_duplicate_golden_branch_id()`.
- `branch_check_new_rejects_empty_choice_path_in_golden()`.
- `branch_check_new_rejects_outcome_label_with_uppercase()`.

Positive run:

- `branch_check_run_passes_with_matching_branches_in_same_order()`.
- `branch_check_run_passes_with_matching_branches_in_reversed_order()` (set
  equivalence — order does not matter).
- `branch_check_run_pass_emits_replay_log_ref_when_options_set()`.
- `branch_check_run_pass_omits_replay_log_ref_when_options_none()`.

Negative run:

- `branch_check_run_fails_with_missing_branch()`.
- `branch_check_run_fails_with_unexpected_branch()`.
- `branch_check_run_fails_with_choice_path_divergence_on_length()`.
- `branch_check_run_fails_with_choice_path_divergence_on_element()`.
- `branch_check_run_fails_with_outcome_difference()`.
- `branch_check_run_collects_all_mismatches_not_only_the_first()`.

Diagnostics:

- `branch_mismatch_kind_to_code_is_exhaustive_over_enum_variants()`.
- `branch_mismatch_codes_are_all_members_of_codes_all()`.

### 10.3 Lowering to `ConformanceResult` (in `trace_branch/trace.rs::tests`

and `trace_branch/branch.rs::tests`)

- `trace_into_conformance_result_emits_pass_with_text_line_evidence()`.
- `trace_into_conformance_result_rejects_evidence_tier_above_e1()`.
- `trace_into_conformance_result_rejects_frame_artifact_evidence()`.
- `trace_into_conformance_result_rejects_recording_runtime_artifact()`.
- `branch_into_conformance_result_emits_pass_with_bridge_unit_evidence()`.
- `branch_into_conformance_result_rejects_evidence_tier_above_e1()`.
- `branch_into_conformance_result_rejects_screenshot_runtime_artifact()`.
- `trace_pass_result_round_trips_through_conformance_schema_v0_1()`.
- `branch_pass_result_round_trips_through_conformance_schema_v0_1()`.

### 10.4 Fixture integration (in

`crates/utsushi-core/tests/conformance_trace_branch.rs`)

One test per fixture file. Names match the kind they exercise so the
test → fixture mapping is obvious:

- `positive_matching_trace_fixture_passes()`.
- `positive_matching_branches_fixture_passes()`.
- `positive_matching_trace_with_speakers_passes()`.
- `negative_text_diff_fixture_fails_with_text_difference()`.
- `negative_order_shift_fixture_fails_with_order_shift()`.
- `negative_branch_missing_fixture_fails_with_branch_missing()`.
- `negative_bridge_unit_unlinked_fixture_fails_with_bridge_unit_unlinked()`.
- `negative_bridge_unit_divergent_fixture_fails_with_bridge_unit_divergent()`.
- `negative_speaker_mismatch_fixture_fails_with_speaker_mismatch()`.
- `negative_trace_event_missing_fixture_fails_with_missing_kind()`.
- `negative_trace_event_unexpected_fixture_fails_with_unexpected_kind()`.
- `negative_branch_choice_path_divergent_fixture_fails_with_choice_path_mismatch()`.
- `negative_branch_outcome_difference_fixture_fails_with_outcome_mismatch()`.
- `negative_branch_unexpected_fixture_fails_with_unexpected_branch()`.

### 10.5 Codes-registry parity (in

`trace_branch/mod.rs::tests`)

- `every_new_trace_code_is_member_of_codes_all()`.
- `every_new_branch_code_is_member_of_codes_all()`.
- `trace_mismatch_codes_match_existing_utsushi_conformance_pattern()` —
  asserts each new code parses through UTSUSHI-026's
  `is_valid_semantic_code` shape check.

## 11. Verification commands

```
cargo test -p utsushi-core conformance::trace_branch
cargo test -p utsushi-core
just check
```

`just check` is the standing umbrella that exercises `cargo check`,
`cargo clippy -- -D warnings`, formatting, and the workspace lints. The
slice does not add a new `just` target.

`cargo test -p utsushi-fixture` is in the node's verification list. The
`utsushi-fixture` crate does not gain code in this slice (UTSUSHI-027
ships fixture JSON inside `utsushi-core/tests/`), but the `-p utsushi-fixture`
test run still has to pass — the slice does not regress it.

## 12. Coordination with parallel nodes

- **UTSUSHI-023** (snapshot primitives) — independent. No shared
  types; UTSUSHI-027 does not touch `SnapshotPrimitives`.
- **UTSUSHI-029** (capture / recording conformance) — adds its own
  check types but MUST be additive to UTSUSHI-026's
  `EvidenceRef`/`ResultOutcome` enums. UTSUSHI-027 commits to the same
  rule: no new `EvidenceRef` variant added here. UTSUSHI-029 may add
  a frame-specific helper trait without touching this module. Mailbox
  for coordination: the `EvidenceRef` enum + UTSUSHI-026's
  `cross_validate_results_against_manifest`.
- **KAIFUU-010** (patch result) — independent. Different result type;
  no overlap.

The slice does NOT block on these nodes landing. If UTSUSHI-029 lands
first and adds a `RuntimeArtifactKind::Recording` evidence reference
inside `EvidenceRef::RuntimeArtifact`, UTSUSHI-027's
`accepts_text_trace_evidence` filter still rejects it (it explicitly
denies `Screenshot`, `FrameCapture`, `Recording`). If UTSUSHI-029 lands
later, no change needed.

## 13. Risks and unknowns

### 13.1 Bridge-unit id stability across runs

`bridge_unit_id` strings are claimed by UTSUSHI-022 to be stable across
runs (the existing `TextLine.bridge_ref.bridge_unit_id` is the truth
source). The risk is that an adapter computes the id from a
non-deterministic source (hashing a timestamp, using a process-id
salt) — in which case golden fixtures break on every run.

Mitigation:

- Plan §3 commits the golden side to UUIDv7-shaped strings (or any
  stable string) — the check does NOT enforce UUIDv7; it only enforces
  non-empty + no whitespace + no path leak. Engine-side stability is
  the engine port's contract (UTSUSHI-031+).
- The fixture suite uses literal UUIDv7-shaped strings so reviewers can
  see "this id is stable by inspection" without running anything.
- A diagnostic mode (NOT shipped here; tracked as a future addition
  noted in §14 Out of Scope) could relax id equality to a normalised
  shape (e.g. "strip leading zeros, lowercase"). This is the wrong
  default and is excluded from this slice.

### 13.2 Branch ordering when adapter does not sort

§4.2 already documents the resolution: id-keyed (not index-keyed) set
comparison. Risk that remains: the `choice_index_path` itself is
index-ordered, and adapters that traverse multiple choices in parallel
may emit `(0,1,2)` and `(0,2,1)` interchangeably. Both forms cannot
match the same golden `(0,1,2)` path.

Mitigation: the golden author commits to the specific order the engine
should produce. If the engine is genuinely non-deterministic at the
choice-traversal level, that is a substrate violation (UTSUSHI-021
already requires deterministic replay), not a UTSUSHI-027 concern. A
non-deterministic-traversal adapter cannot be conformance-tested at all
in the current substrate.

### 13.3 Trace mismatch granularity for partial diffs

For long traces, emitting every per-event diff balloons the failure
output. We do NOT truncate the mismatch list — auditors need
exhaustive output (see audit-focus). We DO truncate the `detail` string
to 256 bytes per mismatch (§5). The two combined cap the
worst-case output at `golden_len * 5 mismatches * 256 bytes ≈
golden_len * 1.3 KB`, which is acceptable for the alpha track's
fixture sizes (golden traces in §8 are ≤5 events).

A future tightening (out of scope, §14) could add a
`MaxMismatchesPerEvent` option for production runs.

### 13.4 Speaker matching policy

§3.3.1 commits to: golden `speaker = None` means observed may be any
speaker (or none). Risk: an adapter regression that introduces a
speaker the golden doesn't expect goes undetected.

Mitigation: the matching positive fixture
(`matching_trace_with_speakers.json`) has golden `speaker = Some(...)`
for every event so the test surface for speaker matching is exercised.
A reviewer authoring a real golden trace is expected to be explicit;
the "None means don't care" rule is the existing precedent inherited
from UTSUSHI-022's `TextLine.speaker: Option<String>`.

### 13.5 No optionality in branch / trace pairing

Acceptance criterion: "Intentional ... mismatches fail predictably."
The check has no "warn only" mode. The branch check's
`replay_log_run_id` option (§4.4) is the ONLY option in the slice; it
is evidence-emission-only and does not affect Pass/Fail.

### 13.6 Schema impact

UTSUSHI-026's `CONFORMANCE_SCHEMA_VERSION = "0.1.0-alpha"` is NOT
bumped by this slice. UTSUSHI-027 adds:

- New entries to `codes::ALL` (additive, no schema bump per UTSUSHI-026
  policy §10.3).
- New Rust types `Trace*`, `Branch*`, `GoldenTextEvent`,
  `ObservedTextEvent`, `GoldenBranch`, `ObservedBranch`. None of them
  appear in the `ConformanceManifest` or `ConformanceResult` wire
  schema; they are inputs to the check and outputs of the check, NOT
  fields in the conformance result. The conformance result's wire
  shape is unchanged.

If a future slice needs to embed `TraceMismatch` in the wire shape,
UTSUSHI-026 schema version bumps then. Not here.

## 14. Out of scope

- **Actual engine ports producing traces.** UTSUSHI-031+ owns the
  lowering from a real engine adapter into `ObservedTextEvent` /
  `ObservedBranch`. This slice ships with synthetic JSON fixtures only.
- **UTSUSHI-028 snapshot conformance.** Separate node.
- **UTSUSHI-029 capture / recording conformance.** Separate node.
- **UTSUSHI-030 ingestion fixture.** Consumes our results; not in scope
  here.
- **`kaifuu.*` provider pass-through inside `TraceMismatch.kind`.**
  Mismatch kinds are typed enums, not free-form strings; provider
  routing happens at the `ResultOutcome::Fail.semantic_code` boundary,
  not inside the check. (See §6.1.)
- **Lenient mismatch truncation modes / "warn only" flags.** No.
- **Bridge-unit id normalisation.** §13.1. No.
- **Embedding `TraceMismatch` in the `ConformanceResult.outcome.fail.detail`
  field as structured JSON.** The schema's `detail: String` field is a
  short public string; we render mismatches into a count summary like
  `"3 trace mismatches: 2 TextDifference, 1 OrderShift"` rather than
  serialising the full mismatch list inside the schema field. The full
  mismatch list is available in-process via `TraceCheckResult` but does
  NOT travel through the conformance JSON wire shape in this slice.
- **TypeScript validators for `TraceCheckResult` / `BranchCheckResult`.**
  UTSUSHI-030 owns ingestion-side validation.
- **Per-event `MaxMismatchesPerEvent` truncation cap.** §13.3 future
  work.

## 15. Worker scoping

**One worker.**

Justification:

- The trace check and branch check share the same module
  (`trace_branch::`), the same fixture root, the same diagnostics code
  registry, and the same `into_conformance_result` lowering policy.
  Splitting into two workers would require coordinating the
  `codes::ALL` extension and the
  `accepts_*_evidence` filter shape in real time and would generate
  merge conflicts on the same module.
- The fixture authoring (§8) is the largest single time sink; one
  worker writes consistent fixtures with consistent ids and a
  consistent style.
- Total scope (in lines of code, generously estimated): ≈400 LoC
  trace, ≈350 LoC branch, ≈150 LoC shared (lowering helpers, codes
  registry extension, mismatch code mapping), ≈400 LoC tests, ≈12 JSON
  fixtures. Well within one worker's slice budget; no parallelism win.

## 16. Header rollup

| Field        | Value                                                             |
| ------------ | ----------------------------------------------------------------- |
| Node         | UTSUSHI-027                                                       |
| Module       | `utsushi_core::conformance::trace_branch`                         |
| New types    | `Trace*`, `Branch*`, `GoldenTextEvent`, `ObservedTextEvent`, etc. |
| New codes    | 12 added to `conformance::diagnostics::codes::ALL`                |
| Fixture root | `crates/utsushi-core/tests/fixtures/conformance/trace_branch/`    |
| Schema bump  | None — additive only                                              |
| Worker count | 1                                                                 |
| Depends on   | UTSUSHI-026 (manifest + result), UTSUSHI-022 (text sink),         |
|              | UTSUSHI-021 (replay log, ChoiceIndex)                             |
| Blocks       | UTSUSHI-030 (ingestion), UTSUSHI-031+ (per-engine port tests)     |
