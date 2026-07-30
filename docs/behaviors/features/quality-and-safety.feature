Feature: Preserve explicit, reproducible, and safe observable outcomes
  Failures, field gaps, races, evidence references, and private-data boundaries
  are visible through public inputs and outputs rather than implementation checks.

  @behavior-quality.failures-stay-explicit
  Scenario Outline: Keep failures explicit instead of returning empty success
    Given <operation> receives <failure_case> through <entrypoint>
    When the request settles
    Then the caller receives <failure_class>
    And the outcome contains <diagnostic_outcome>
    And no successful, skipped, defaulted, or fixed-empty result is reported

    Examples:
      | operation             | failure_case             | entrypoint       | failure_class       | diagnostic_outcome          |
      | standard extraction   | missing required input   | command boundary | missing input       | safe actionable remediation |
      | start localization    | unavailable provider     | HTTP boundary    | operational pause   | safe resumable next action   |
      | patch production      | unsupported source profile | rendered interface | unsupported profile | exact declared limitation  |
      | standard extraction   | malformed owned input    | command boundary | invalid input        | exact invalid-input reason   |
      | patched playback      | unknown in-profile operation | runtime boundary | in-profile defect | exact unsupported operation  |
      | patch production      | changed source revision  | command boundary | stale source         | exact source mismatch        |
      | publish evidence      | disallowed disclosure    | HTTP boundary    | privacy denial       | safe policy reason           |
      | administer account    | absent effective grant   | HTTP boundary    | permission denial    | safe authority reason        |
      | provider request      | declared deadline reached | HTTP boundary   | timeout              | safe retry guidance          |
      | localization run      | authorized cancellation  | HTTP boundary    | cancellation         | durable cancelled state      |
      | localization run      | exact cap exhausted      | HTTP boundary    | budget refusal       | exact remaining allowance    |
      | persisted operation   | unexpected service fault | HTTP boundary    | internal failure     | safe incident reference      |
      | runtime asset read    | required asset absent    | runtime boundary | missing asset        | exact missing-asset result   |
      | runtime asset read    | protected asset cannot decrypt | runtime boundary | decryption failure | exact protected-asset result |
      | source preparation    | tampered, oversized, timed-out, cancelled, or unapproved helper | command boundary | exact preparation failure | distinct stable safe diagnostic |
      | localization outcome  | in-profile defect whose message names another failure class | HTTP boundary | in-profile defect | evidence-derived class and exact next action |

  @behavior-quality.untrusted-inputs-fail-without-harm
  Scenario Outline: Enforce exact input bounds and reject hazards before harm
    Given <engine_family> profile <profile> receives <input_kind> with <hazard>
    And the request is at <limit_case>
    When <operation> is attempted
    Then the request ends as <boundary_outcome>
    And no destination outside the selected output is read or written
    And time, memory, output size, recursion, and decompression stay within declared bounds
    And any refusal creates no partial artifact or persisted reference

    Examples:
      | engine_family      | profile         | input_kind     | hazard                 | limit_case        | operation  | boundary_outcome          |
      | registered family  | unknown profile | owned archive  | traversal path         | below size limit  | extraction | invalid input refusal     |
      | registered family  | registered profile | compressed input | expansion beyond limit | declared maximum | extraction | resource-limit refusal |
      | registered family  | registered profile | patch request | overlapping protected spans | normal size | patching | pre-write validation refusal |
      | registered family  | registered profile | managed artifact | malicious handle or symlink escape | below size limit | ingestion | containment refusal |
      | registered family  | registered profile | managed artifact | wrong declared kind   | below size limit  | ingestion | kind-mismatch refusal     |
      | registered family  | registered profile | managed artifact | stale revision or bad hash | below size limit | ingestion | integrity refusal      |
      | registered family  | registered profile | managed artifact | valid shape            | over artifact budget | ingestion | resource-limit refusal  |
      | registered family  | registered profile | source preparation tool | wrong identity or unapproved executable | below size limit | preparation | pre-execution authorization refusal |
      | registered family  | registered profile | source preparation tool | oversized input or deadline reached | declared maximum | preparation | bounded resource refusal |
      | registered family  | registered profile | managed artifact | valid bytes and shape | exactly the declared maximum | ingestion | accepted without truncation, clamping, or saturation |
      | registered family  | registered profile | managed artifact | valid bytes and shape | one unit over the declared maximum | ingestion | resource-limit refusal without truncation, clamping, or saturation |
      | registered family  | registered profile | user, archive, output, or download path | hard-link alias, UNC or drive path, dot segment, nested data root, or existing-destination collision | below size limit | extraction or patching | containment or collision refusal before any write |

  @behavior-quality.output-completeness-is-reported
  Scenario Outline: Report population of every structured output field
    Given <engine_family> profile <profile> input has known <field> availability as <source_case>
    When <operation> produces <artifact_kind>
    Then the field reports <expected_status>
    And its nonempty count is reported as <populated_count> of <total_count>
    And zero population cannot be hidden inside an aggregate or called a limitation without source evidence

    Examples:
      | engine_family     | profile            | field      | source_case             | operation  | artifact_kind   | expected_status       | populated_count | total_count |
      | registered family | registered profile | speaker    | source contains values  | extraction | standard bundle | populated             | 8               | 10          |
      | registered family | registered profile | speaker    | source lacks values     | extraction | standard bundle | source absent         | 0               | 10          |
      | registered family | registered profile | choice link | source contains values | extraction | standard bundle | extraction missing    | 0               | 4           |

  @behavior-quality.same-inputs-reproduce-equivalent-results
  Scenario Outline: Reproduce equivalent outcomes from immutable inputs
    Given identical <engine_family> <profile> input, <configuration>, and <replay_source>
    And comparison uses <comparison_source> with <mutation_case>
    When <operation> runs in clean environments for <target_locale>
    Then <artifact_kind> satisfies <equivalence>
    And the mutation ends as <mutation_outcome>
    And changing only <target_scope> changes no unrelated observable field or byte

    Examples:
      | engine_family            | profile             | configuration       | replay_source        | comparison_source                 | mutation_case             | operation  | target_locale | artifact_kind       | equivalence                       | mutation_outcome                  | target_scope            |
      | registered native family | registered profile  | fixed locale policy | recorded input       | a second clean execution          | one intended target edit  | patching   | locale-alpha  | patch bytes         | byte-identical unchanged output   | only the intended target changes  | one target span         |
      | registered web family    | registered profile  | fixed runtime setup | input log            | a second execution target         | one declared renderer difference | playback | locale-beta | observations        | equivalent semantic events        | only the declared rendering differs | one translated message |
      | registered family        | registered profile  | fixed package setup | directory input      | equivalent packaged input         | one traversal attempt     | playback   | locale-alpha  | asset observations  | identical authorized asset reads  | the traversal is refused          | one selected asset      |
      | registered family        | registered profile  | fixed decode policy | recorded source      | independently produced reference  | one-bit output mutation   | extraction  | locale-beta   | standard bundle     | independent results agree         | the mismatch is detected          | one extracted field     |
      | registered family        | registered profile  | fixed patch policy  | recorded source      | unchanged roundtrip reference     | one corrupted input       | patching    | locale-alpha  | patch refusal       | unchanged data remains equivalent | exact corruption failure          | one protected span      |
      | registered family        | registered profile  | fixed full-run policy | model replay and fixed execution environment | a second independently provisioned environment | one intended target edit | full workflow | locale-beta | identities, manifests, standard bundle, patch, traces, scorecard, and aggregates | byte-identical unchanged artifacts and values | only dependent artifacts change | one target unit |

  @behavior-quality.evidence-is-traceable-and-portable
  Scenario Outline: Audit evidence from a fresh environment
    Given <evidence_kind> from <source_class> has <privacy_class> visibility and <content_case>
    When an independent auditor resolves its <reference_kind> in a fresh environment
    Then producer, source revision, input and output hashes, privacy class, and outcome are present
    And resolution ends as <audit_outcome>
    And reference expectations identify a producer independent from the output under evaluation
    And copying evaluated output into expected data invalidates provenance
    And every accepted artifact set belongs to one coherent source lineage and regenerates all dependents deterministically after a source change
    And tampering, stale revision, or environment-local location makes the evidence invalid

    Examples:
      | evidence_kind       | source_class     | privacy_class | content_case                                                        | reference_kind          | audit_outcome                |
      | patch receipt       | real owned input | restricted    | a hash-bound safe manifest                                          | managed artifact handle | exact evidence resolves      |
      | compatibility proof | synthetic input  | public-safe   | redistributable inputs and content-free outcomes                    | relative public handle   | synthetic evidence resolves  |
      | compatibility proof | synthetic input  | public-safe   | a raw key, retail content, captured image, private filename, or path | relative public handle  | rejected as unsafe           |
      | runtime observation | real owned input | restricted    | a changed source revision                                           | changed artifact handle  | invalid hash mismatch        |
      | independent comparison | two separately produced outputs | restricted | expected values created without copying the evaluated output | proof graph | separate producer identities resolve |
      | coherent evidence set | one source revision | restricted | individually valid artifacts under one manifest | managed manifest handle | the complete coherent set resolves |
      | mixed evidence set  | several source revisions | restricted | individually valid artifacts combined across lineages | managed manifest handle | rejected as mixed lineage |
      | regenerated evidence set | one changed source revision | restricted | all dependent artifacts regenerated from the changed source | managed manifest handle | every dependent hash changes deterministically or stays identical when unaffected |

  @behavior-quality.invalid-or-raced-actions-have-no-effects
  Scenario Outline: Leave no effects when authority or validity changes before commitment
    Given <actor> requests <action> while <invalidation_case> occurs
    When the request settles at the public boundary
    Then the result is <expected_outcome>
    And no unauthorized accepted work, durable work receipt, artifact, message, or cost exists
    And one winning valid request can commit at most once

    Examples:
      | actor              | action             | invalidation_case          | expected_outcome           |
      | project member     | start a round      | permission is revoked      | denied with no effects     |
      | account admin      | consume a grant    | another request consumes it | one winner and one refusal |
      | patch producer     | publish an artifact | source revision changes    | stale request refused      |

  @behavior-quality.private-data-stays-within-approved-boundaries
  Scenario Outline: Keep private data within approved processing boundaries
    Given <data_class> is processed at <placement> with <provider_posture>
    When <output_kind> crosses <boundary>
    Then the crossing contains <allowed_content>
    And secret material, personal data, private paths, and reconstructive content remain absent
    And retention and deletion evidence ends as <policy_outcome>
    And removing any required provider privacy control quarantines the response and makes its run non-qualifying
    And public aggregates are recomputed from admitted content-free lineage rather than copied from private payloads

    Examples:
      | data_class       | placement   | provider_posture    | output_kind          | boundary        | allowed_content                     | policy_outcome           |
      | owned source     | self-hosted | no external egress  | public evidence      | public download | content-free lineage only           | policy evidenced         |
      | localized output | managed     | approved no-retention | provider request   | approved endpoint | only the authorized request payload | policy evidenced       |
      | private capture  | managed     | no external egress  | diagnostic summary   | operator view   | non-reconstructive status only      | unauthorized view denied |
      | localized output | managed     | one required privacy control missing | provider response | qualifying run | nothing because the response is quarantined | run is non-qualifying with the exact missing control |
      | private run evidence | managed  | approved no-retention | public aggregate | public report | recomputed hashes, counts, durations, classes, and exact billed aggregates | privacy scan finds no recoverable content |
