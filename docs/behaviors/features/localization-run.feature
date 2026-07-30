Feature: Run complete localization work
  A producer can configure, operate, and inspect a whole-scope localization
  round without taking over the agent-owned unit loop.

  @behavior-run.configure-policy
  Scenario Outline: Admit only a complete and permitted run policy
    Given branch <target_locale> requests <run_mode> with <provider_posture>
    And its privacy posture is <privacy_posture> with <budget_case>
    When the portfolio operator submits the run policy
    Then admission ends as <expected_admission>
    And admitted execution makes <provider_call_outcome>
    And a refused policy incurs no provider use or billed cost

    Examples:
      | target_locale | run_mode               | provider_posture       | privacy_posture | budget_case          | expected_admission       | provider_call_outcome                      |
      | locale-alpha  | whole-project round    | approved served pair   | no retention    | sufficient exact cap | admitted and versioned   | only calls declared by the accepted policy |
      | locale-beta   | incremental refinement | unapproved destination | restricted      | sufficient exact cap | refused before any call  | zero calls                                  |
      | locale-alpha  | comparison baseline    | approved served pair   | no retention    | insufficient cap     | paused before any call   | zero calls                                  |
      | locale-beta   | replay-only            | approved served pair   | no retention    | sufficient exact cap | admitted and versioned   | zero model calls                            |

  @behavior-run.localize-complete-scope
  Scenario Outline: Localize every required surface into accepted game text
    Given <engine_family> profile <profile> has configured <scope> for <target_locale>
    And the round uses <context_case>
    And quality judgment covers <quality_case> using <quality_evidence>
    When the localization and quality loop completes with <repair_case>
    Then configured-scope coverage ends as <coverage_outcome>
    And every accepted target is nonblank game text that satisfies deterministic constraints
    And malformed output is never salvaged; every physical attempt remains an immutable billed receipt, and exhaustion pauses resumably
    And every accepted target traces through its exact cited fact, frozen context, provider receipt, candidate output, and quality decision
    And a missing or cyclic lineage reference refuses terminal success
    And a targeted repair changes only cited dependent targets and artifacts while unrelated accepted hashes remain unchanged
    And quality handling ends as <quality_outcome>
    And the produced patch content is <expected_output>

    Examples:
      | engine_family            | profile             | scope                    | target_locale | context_case           | quality_case                          | quality_evidence                    | repair_case              | coverage_outcome                     | quality_outcome                                                       | expected_output                      |
      | registered native family | protected profile   | dialogue and choices     | locale-alpha  | frozen locale guidance | one seeded meaning defect             | cited source and frozen guidance    | one evidenced repair    | complete with one target per surface | the finding is repaired with exact evidence                           | the repaired accepted targets        |
      | registered web family    | plain profile       | text and image assets    | locale-beta   | frozen locale guidance | clean controls                        | governing locale context            | no repair needed        | complete with one target per surface | no unsupported finding                                               | the original accepted targets        |
      | registered family        | registered profile  | all configured surfaces  | locale-alpha  | missing required fact  | an ambiguous required fact            | no supporting evidence              | a resumable fact pause  | paused with uncertainty explicit     | no unsupported resolution                                            | no falsely successful partial patch  |
      | registered family        | registered profile  | dialogue                  | locale-alpha  | frozen locale guidance | an ambiguous speaker                  | supporting later and sibling facts  | no repair needed        | complete with one target per surface | only an evidence-backed speaker identity is accepted                  | the accepted targets                 |
      | registered family        | registered profile  | dialogue                  | locale-beta   | frozen locale guidance | an ambiguous speaker                  | no supporting evidence              | a resumable fact pause  | paused with uncertainty explicit     | unresolved identity stays explicit without a default or guess         | no falsely successful partial patch  |
      | registered family        | registered profile  | dialogue and choices      | locale-alpha  | frozen locale guidance | a seeded term violation and approved variant | the governing term version    | one targeted repair      | complete with one target per surface | every violation is repaired, the variant passes, and the version is cited | the repaired accepted targets     |
      | registered family        | registered profile  | one disputed scene        | locale-beta   | frozen locale guidance | two conflicting reviews               | both reviews and frozen evidence    | one targeted repair      | complete with one target per surface | a reproducible disposition cites both without a majority shortcut     | the evidence-resolved accepted targets |
      | registered family        | registered profile  | all configured surfaces   | locale-alpha  | frozen locale guidance | one unresolved non-blocking quality finding | complete valid targets and mechanical patch evidence | retain the finding without repair | complete with one target per surface | the unresolved finding remains visible without gating complete valid coverage | one versioned mechanically valid patch |
      | registered family        | registered profile  | one configured scene      | locale-beta   | frozen locale guidance | one malformed candidate output         | its typed failure and provider receipt | one permitted fresh bounded attempt | complete with one target per surface | the malformed attempt remains billed and the fresh schema-valid output alone is accepted | the fresh accepted target |
      | registered family        | registered profile  | one configured scene      | locale-alpha  | frozen locale guidance | repeated malformed candidate output    | every typed failure and provider receipt | exhaust the bounded attempts | paused with the target still missing | every attempt remains billed and the exact operational pause is visible | no partial patch |
      | registered family        | registered profile  | one configured scene      | locale-beta   | frozen locale guidance | a candidate with an orphan or cyclic evidence reference | exact cited facts, receipts, outputs, and decisions | refuse completion | paused with lineage invalid | the exact missing or cyclic reference is visible | no terminal patch |

  @behavior-run.control-durable-work
  Scenario Outline: Control durable work without duplicates or crossed scope
    Given <actor> with <authorization_case> controls <project_count> isolated projects with work in <run_state>
    When the operator requests <control_action> during <interruption_case>
    Then the selected run reaches <expected_state>
    And accepted work and round history end as <persistence_outcome>
    And committed output, provider use, and cost appear at most once
    And execution never exceeds the declared concurrency bound across configured unique inputs
    And retrying, failed, and cancelled states retain distinct permitted controls and outcomes
    And no other project or locale changes

    Examples:
      | actor               | authorization_case | project_count | run_state                 | control_action | interruption_case           | expected_state                  | persistence_outcome                         |
      | portfolio operator  | permitted          | 2             | running                   | pause          | normal operation            | resumable pause                 | existing run retained once                  |
      | portfolio operator  | permitted          | 3             | paused                    | resume         | process restart             | continued accepted work         | existing run retained once                  |
      | portfolio operator  | permitted          | 2             | running                   | cancel         | provider result uncertainty | reconciliation required         | cancellation recorded once                  |
      | steering producer   | permitted          | 1             | validated ready           | start          | normal operation            | one bounded active run          | exactly one durable run and round receipt    |
      | steering producer   | permitted          | 1             | tens-of-thousands ready   | execute        | normal operation            | complete accepted work          | each unique input and output committed once  |
      | portfolio operator  | permitted          | 1             | retrying after failure    | resume         | declared retry boundary     | one bounded retry               | no duplicate committed output or cost        |
      | portfolio operator  | permitted          | 1             | failed with exact cause   | retry          | operator-selected retry     | one new bounded attempt         | failed attempt retained separately           |
      | portfolio operator  | permitted          | 1             | cancelled                 | inspect        | cancellation settled        | remains cancelled              | cancellation and retained work remain visible |
      | unrelated actor     | denied             | 1             | validated ready           | start          | normal operation            | launch refused                 | no accepted work or round receipt            |
      | steering producer   | permitted          | 1             | invalid policy            | start          | normal operation            | validation refusal             | no accepted work or round receipt            |

  @behavior-run.inspect-truthful-state
  Scenario Outline: Inspect truthful whole-scope progress and next action
    Given a run requires <required_count> unique surfaces
    And its latest outcome is <outcome_case>
    When the operator opens <view_scope>
    Then required, written, patched, and replayed counts report <count_outcome>
    And the visible state, blocker, owner, and next action are <status_outcome>
    And a successful status cannot hide a failed required surface
    And every present cockpit tile resolves to its persisted detail
    And removing a data producer makes its tile absent or visibly limited rather than fabricated
    And every plotted point reconciles exactly to a persisted aggregate
    And a missing value appears as a gap rather than zero
    And each failure class follows recorded outcome evidence even when its message names another class
    And a retained-partial finding can reference a patch result only after that immutable result exists
    And querying a patch-result identity returns its exact outcome and artifact links
    And every open decision has a working authorized resolution link
    And a resolved decision leaves the open set while its immutable history remains available
    And <notification_case> produces <notification_outcome>

    Examples:
      | required_count | outcome_case                                      | view_scope       | count_outcome                         | status_outcome                       | notification_case               | notification_outcome                                        |
      | 12             | all required work done                            | one locale run   | equal complete unique counts          | successful and export-gated          | one completion event            | one deduplicated safe notification with a working deep link |
      | 50000          | one required target absent                        | portfolio view   | one explicit missing target           | blocked with a next action           | one blocking decision           | one deduplicated safe notification with a working deep link |
      | 250            | provider unavailable                              | project cockpit  | accepted work remains counted         | resumably paused                     | repeated identical pause event  | one notification without private payload                    |
      | 120            | one persisted trend interval absent               | project cockpit  | unique current totals remain exact    | missing trend interval shown as a gap | no notification                 | no fabricated event                                           |
      | 24             | one producer removed                              | project cockpit  | remaining producer counts stay exact  | affected tile absent or limited      | one configuration-change event  | one deduplicated safe notification with a working deep link |
      | 24             | retained-partial finding after patch publication | one patch result | exact immutable patch-result counts   | exact result and artifact links      | one retained-finding event       | one safe deep link to the immutable patch result             |
      | 8              | an in-profile failure whose message mentions an operational pause | one locale run | failed required work stays visible | in-profile failure with its exact next action | one failure event | one safe notification with the evidence-derived class |
      | 20             | runtime session running                           | runtime status   | current unique observations           | running with profile, readiness, progress, limitations, and evidence links | one running event | one safe running treatment |
      | 20             | runtime session cancelled                         | runtime status   | retained observations before cancellation | cancelled with final progress and evidence links | one cancellation event | one safe final cancelled treatment |
      | 20             | runtime session failed                            | runtime status   | retained observations before failure | failed with last typed failure and evidence links | one failure event | one safe actionable failed treatment |
      | 16             | one unresolved scope decision                     | project cockpit  | accepted work remains counted         | blocked with owner, next action, and a working authorized resolution link | one blocking decision | one safe deep link to the resolution surface |
      | 16             | the scope decision was resolved                   | project cockpit  | exact post-resolution counts          | no open decision and the ordered resolution history remains available | one resolution event | one safe deep link to the retained history |

  @behavior-run.account-provider-use
  Scenario Outline: Account for the provider and model actually served
    Given a run requests <requested_pair> under <fallback_policy>
    When the provider request ends as <call_outcome> from <served_pair>
    Then receipt status is <receipt_outcome>
    And certification is verified against the provider artifact, generation identity, served pair, and validity period
    And fabricated, replay-substituted, expired, or differently served certification is rejected and quarantined
    And any actual call records requested and served identity, generation, privacy evidence, retries, and a real provider artifact
    And usage, latency, and billed cost are <accounting_outcome>
    And every positive token count resolves to provider or admitted tokenizer evidence
    And an absent token count remains absent rather than becoming a heuristic or zero
    And every cost-complete aggregate reconciles to the provider artifact at exact precision
    And missing billed cost for an actual call remains missing and cannot be plotted or qualified as zero
    And an unidentified or unapproved response cannot become accepted output

    Examples:
      | requested_pair    | fallback_policy     | call_outcome                                     | served_pair        | receipt_outcome                                       | accounting_outcome                              |
      | approved pair A   | approved list only  | success with current bound certification         | approved pair A    | qualifying receipt with privacy proof                 | exact and reconciled                            |
      | approved pair A   | approved list only  | fallback with current bound certification        | approved pair B    | qualifying receipt for the pair actually served      | exact for the pair actually served              |
      | approved pair A   | no unapproved pairs | contradictory served identity                    | unidentified pair  | quarantined non-qualifying receipt                    | absent from output and quarantined              |
      | approved pair A   | approved list only  | missing credentials                              | no served pair     | explicit non-proof without a provider artifact       | zero usage and no fabricated cost               |
      | no requested pair | replay-only         | zero-call replay                                 | no served pair     | declared zero-call outcome without provider evidence | zero calls, latency, tokens, and cost            |
      | approved pair A   | approved list only  | success with fabricated certification            | approved pair A    | quarantined non-qualifying receipt                    | actual use recorded but excluded from output     |
      | approved pair A   | approved list only  | success with replay-substituted certification    | approved pair A    | quarantined non-qualifying receipt                    | actual use recorded but excluded from output     |
      | approved pair A   | approved list only  | success with expired certification               | approved pair A    | quarantined non-qualifying receipt                    | actual use recorded but excluded from output     |
      | approved pair A   | approved list only  | success with differently served certification    | approved pair A    | quarantined non-qualifying receipt                    | actual use recorded but excluded from output     |
      | approved pair A   | approved list only  | success with billed cost absent                  | approved pair A    | cost-incomplete non-qualifying receipt                | exact usage with billed cost explicitly missing |
      | approved pair A   | approved list only  | success with provider-reported token counts      | approved pair A    | qualifying receipt with provider token evidence       | positive tokens and exact cost resolve to the provider artifact |
      | approved pair A   | approved list only  | success with admitted tokenizer counts           | approved pair A    | qualifying receipt with tokenizer provenance          | positive tokens and exact cost resolve to admitted evidence |
      | approved pair A   | approved list only  | success with token counts absent                 | approved pair A    | token-incomplete receipt                               | token values stay absent and never become estimates or zero |

  @behavior-workflow.use-equivalent-entrypoints
  Scenario Outline: Receive equivalent results through each supported entrypoint
    Given <actor> is <authorization> to request <task_kind>
    When the actor submits the same request input through <entrypoint>
    Then validation, authorization, result identity, and artifact outcome are <equivalence>
    And extraction accepts registered options for its selected family
    And an omitted family or options registered to a foreign family are refused before extraction
    And diagnostics expose no implementation-specific requirement

    Examples:
      | actor             | authorization | task_kind                                              | entrypoint         | equivalence                          |
      | project producer  | authorized    | extraction with registered native-family options      | rendered interface | equal to the command and HTTP result  |
      | project producer  | authorized    | extraction with registered web-family options         | rendered interface | equal to the command and HTTP result  |
      | project producer  | authorized    | extraction with the family omitted                    | rendered interface | the same exact validation refusal     |
      | project producer  | authorized    | extraction with options from a foreign family         | rendered interface | the same exact validation refusal     |
      | project producer  | authorized    | standard extraction                                   | command boundary   | equal to the HTTP result              |
      | service principal | authorized    | start localization                                    | HTTP boundary      | equal to the durable work result      |
      | unrelated actor   | denied        | download patch                                        | rendered interface | the same denial outcome               |

  @behavior-journey.localize-owned-release
  Scenario Outline: Complete the owned-release journey through played export
    Given <starting_state> follows <setup_path> for an exact lawful <engine_family> release with profile <profile>
    When guidance installs, initializes, authenticates or configures privacy, detects the input, and selects <target_locale> with <scope>
    Then preparation ends as <onboarding_outcome>
    And any successful journey makes every required target one validated patch at <placement>
    And any successful journey includes review of that exact immutable patch before a successor round
    And replacing any required decode, provider, patch, replay, or render leg with an intermediate fixture invalidates the composed receipt
    And export of <export_kind> succeeds only with the exact play receipt

    Examples:
      | starting_state          | setup_path                                     | engine_family            | profile             | target_locale | scope                       | onboarding_outcome                                        | placement   | export_kind   |
      | fresh supported machine | fully guided install and private local input   | registered native family | registered profile  | locale-alpha  | configured text and assets | ready without repository knowledge, manual data upload, or terminal dependency | self-hosted | delta       |
      | fresh managed account   | guided sign-in, privacy, and owned input setup | registered web family    | registered profile  | locale-beta   | configured text and assets | ready through guided checks                               | managed     | patched build |
      | configured installation | guided selection of an existing owned input   | registered family        | registered profile  | locale-alpha  | configured dialogue        | ready without duplicating existing setup                  | self-hosted | delta         |
      | fresh installed command user | guided command setup and private owned input | registered family      | registered profile  | locale-beta   | configured text and assets | ready through public help, initialization, extraction, structure export, localization, patching, and validation without a family-specific script or manual conversion | self-hosted | delta |
      | configured installation | one required leg replaced by an intermediate fixture | registered family | registered profile | locale-alpha | configured dialogue | composed receipt refused with the exact substituted leg | self-hosted | no export |
