Feature: Review, refine, export, and evaluate localized work
  Human authority stays at immutable played-patch rounds while evaluators compare
  reproducible contestant evidence and gate readiness dimension by dimension.

  @behavior-review.play-exact-patch
  Scenario Outline: Review the exact immutable patch through linked playable context
    Given <engine_family> profile <profile> has immutable patch <patch_revision>
    And <navigation_source> exposes <navigation_inventory>
    When the reviewer uses <playback_mode> to perform <interaction>
    Then any started session consumes that exact patch and records <coverage_outcome>
    And selection lands on <navigation_outcome> with project, branch, and work context intact
    And source, target, choice, frame, and runtime evidence stay linked to the played moment
    And a selected scene contains its complete aligned source-and-target content and nothing from another route or work
    And any accepted playback exposes multiple ordered frames while a one-frame static substitute is refused
    And any displayed ordered thumbnail count matches the permitted frame artifacts
    And static, replay, launched, and reference evidence remain distinct, with an absent producer shown as absent rather than zero
    And no per-unit approval or mutation control is offered

    Examples:
      | engine_family     | profile            | patch_revision | navigation_source | navigation_inventory          | playback_mode       | interaction             | navigation_outcome                  | coverage_outcome        |
      | registered family | registered profile | patch-one      | scene picker       | every expected scene entry    | interactive session | select a visible choice | the exact interactive player moment | exact moments recorded  |
      | registered family | registered profile | patch-two      | rendered route map | every expected node and edge  | recorded replay     | select a route node     | its linked player moment             | declared route coverage |
      | registered family | registered profile | patch-two      | source citation    | every supported citation kind | evidence-linked play | follow the citation    | its cited content                    | linked cited moment     |
      | registered family | registered profile | patch-three    | stored moment      | one current stored moment      | indexed replay      | select the stored moment | the same source unit, state hash, and visible output | one reproducible moment |
      | registered family | registered profile | patch-three    | stored moment      | one stale stored moment        | indexed replay      | select the stale moment | an exact stale-moment refusal         | no observation recorded |
      | registered family | registered profile | patch-four     | ordered filmstrip  | three hash-bound permitted frame artifacts | launched session | advance through two moments | three ordered frames with three matching thumbnails | three exact moments recorded |
      | registered family | registered profile | patch-four     | player stream      | a one-frame static substitute  | interactive session | request the next moment | an exact noninteractive-evidence refusal | no observation recorded |
      | registered family | registered profile | patch-five     | evidence panel     | static, replay, launched, and reference results with one absent producer | evidence-linked play | inspect result classes | distinct evidence classes with the missing metric absent | only produced evidence counted |
      | registered family | registered profile | patch-six      | scene picker       | complete aligned scene content plus a foreign-scope probe | evidence-linked play | select the scene | its complete aligned content in exact order | no content from another route or work |

  @behavior-review.refine-whole-round
  Scenario Outline: Refine localization only through whole played-patch rounds
    Given <actor> provides feedback from <feedback_origin> bound to played patch <parent_patch>
    And the request is <feedback_case> with <feedback_kind>, <privacy_class>, and <feedback_address>
    When the actor <round_action>
    Then the result is <child_outcome>
    And any accepted feedback address persists and reopens at <reopen_outcome>
    And invalid, stale, or unauthorized feedback creates no versioned event or partial effect
    And unrelated accepted output retains its hash
    And failure leaves the parent patch playable and exportable by its own receipt

    Examples:
      | actor                 | feedback_origin | parent_patch | feedback_case | feedback_kind           | privacy_class | feedback_address               | round_action                    | child_outcome                       | reopen_outcome                     |
      | authorized reviewer   | scene moment    | patch-one    | valid         | style and context notes | restricted    | the exact played scene moment   | batches and starts a new round | one immutable successor patch       | the same interactive player moment |
      | authorized reviewer   | asset moment    | patch-two    | valid         | localized-asset note    | project-only  | the exact selected asset region | batches and starts a new round | one immutable successor patch       | the same asset editor region       |
      | authorized reviewer   | source claim    | patch-one    | invalid shape | corrected source fact   | restricted    | malformed address               | submits feedback               | refusal with parent intact          | no location or event created       |
      | authorized reviewer   | scene moment    | patch-one    | stale patch   | style note              | restricted    | a prior patch moment             | submits feedback               | stale refusal with parent intact    | no location or event created       |
      | unrelated actor       | scene moment    | patch-one    | unauthorized  | style note              | restricted    | the exact played scene moment    | submits feedback               | denied with parent intact           | no location or event created       |

  @behavior-review.compare-rounds
  Scenario Outline: Compare immutable round lineage and causal changes
    Given <actor> with <evidence_access> has <round_count> related patch rounds for one locale branch
    When the reviewer compares <comparison_scope> using <evidence_kind>
    Then changed guidance, rerun scope, output, cost, and patch bytes are visible
    And each correction has <lineage_outcome>
    And displayed evidence has <reference_outcome>
    And the detail is <detail_outcome>
    And each reviewed unit shows the exact frozen context version from its lineage rather than a recomputed or newer view
    And a scene-scoped comparison contains its complete aligned content and no content from another route or work
    And unchanged work is distinguishable from rerun work

    Examples:
      | actor                 | evidence_access | round_count | comparison_scope | evidence_kind              | lineage_outcome                       | reference_outcome                  | detail_outcome                         |
      | authorized reviewer   | full project    | 2           | one scene        | source and target text     | a link to played feedback             | every displayed reference resolves | a complete schema-valid view           |
      | authorized reviewer   | full project    | 3           | whole branch     | patch and runtime evidence | a link to changed guidance and rerun  | every displayed reference resolves | a complete schema-valid view           |
      | unauthorized actor    | redacted only   | 2           | one scene        | permitted summary fields   | a redacted causal summary             | every displayed safe reference resolves | a redacted schema-valid view        |
      | authorized reviewer   | full project    | 2           | one accepted target | its frozen context version | a link to the exact context used       | the lineage-bound context reference resolves | the original context rather than a newer view |
      | authorized reviewer   | full project    | 2           | one selected scene | complete aligned source and target content | a link to the exact route and work | every selected-scope reference resolves | complete content with every foreign-scope item absent |

  @behavior-export.download-played-patch
  Scenario Outline: Export only the exact compatible patch that was played
    Given <actor> requests <export_kind> for <engine_family> profile <profile>
    And the source comparison is <source_match>
    When export checks <play_receipt_outcome> under <privacy_class>
    Then export ends as <export_outcome>
    And a refusal exposes no partial or incompatible download

    Examples:
      | actor               | export_kind   | engine_family            | profile            | source_match | play_receipt_outcome | privacy_class | export_outcome             |
      | authorized producer | delta         | registered native family | registered profile | exact        | exact played patch    | project-only  | one hash-bound download    |
      | authorized producer | patched build | registered web family    | registered profile | changed      | exact played patch    | project-only  | refused before production  |
      | unauthorized actor  | delta         | registered family        | registered profile | exact        | exact played patch    | restricted    | denied without content     |

  @behavior-evaluation.compare-contestants
  Scenario Outline: Compare contestants fairly on identical held-out work
    Given <contestant_set> covers the same <engine_family> <target_locale> holdout
    And methodology <methodology> grants each contestant <context_policy>
    And validity probe <validity_probe> contains <seeded_case>
    When <judge_profile> evaluates the anonymized outputs and controls
    Then units, allowed context, quality dimensions, cost, and latency are comparable
    And replay uses <replay_calls> new provider calls
    And calibration ends as <calibration_outcome>
    And the result is <validity_outcome>
    And changing a locked methodological input creates a new methodology identity
    And held-out units must be proven absent from development inputs
    And every judgment remains separate against its dimension-specific anchor
    And every live point links its provider artifact and exact billed cost, while absent cost remains missing rather than zero
    And every below-threshold dimension names its affected units and evidence
    And a reduced-context baseline cannot access Wiki or prior agent output excluded by its manifest
    And admitting a recorded run requires source-split provenance, complete cost, and explicit replay consent

    Examples:
      | contestant_set                          | engine_family                 | target_locale | methodology       | context_policy             | validity_probe                      | seeded_case                                 | judge_profile       | replay_calls | calibration_outcome                                    | validity_outcome                    |
      | current reference baseline and ablation | MAGES benchmark reference    | locale-alpha  | locked benchmark  | identical decoded context  | deterministic metric mutation       | one defect for each intended metric         | calibrated panel    | zero         | repeated scores match and every intended metric changes | valid with complete evidence        |
      | current reference baseline and ablation | registered production family | locale-beta   | locked benchmark  | unequal hidden context     | context equality                     | one contestant receives extra context       | calibrated panel    | zero         | unequal context is detected                            | invalid for unequal context         |
      | anonymized contestants                   | registered production family | locale-alpha  | locked benchmark  | identical decoded context  | frozen-label agreement               | swapped provenance labels                    | calibrated panel    | zero         | agreement, error, and divergence remain label-invariant | valid within frozen calibration     |
      | same-model producer and reviewer         | registered production family | locale-beta   | locked benchmark  | identical decoded context  | same-model bias bounds               | seeded false positive and false negative     | calibrated panel    | zero         | per-defect errors and preference bias stay within bounds | valid within locked bounds          |
      | privacy-admitted backtranslation         | registered production family | locale-alpha  | locked benchmark  | identical decoded context  | supplemental meaning-loss tripwire   | seeded meaning loss and clean paraphrase     | calibrated panel    | one          | meaning loss is flagged and clean paraphrase is not     | valid supplemental signal           |
      | anonymized contestants                   | registered production family | locale-beta   | locked benchmark  | identical decoded context  | sabotage and invariance checks       | order, provenance, judge, and score sabotage | calibrated panel    | zero         | permitted swaps stay stable and sabotage is detected    | invalid if any check fails          |
      | current reference baseline and ablation | registered production family | locale-alpha  | one changed locked input | identical decoded context | methodology identity comparison | one corpus, split, metric, or reporting change | calibrated panel | zero | old and new methodology identities remain distinct | comparison refused across identities |
      | anonymized contestants                   | registered production family | locale-beta   | locked benchmark  | identical decoded context  | holdout leakage audit                | one held-out unit appears in development input | calibrated panel | zero | the leaked unit is identified exactly                   | invalid before comparison           |
      | anonymized contestants                   | registered production family | locale-alpha  | locked benchmark  | identical decoded context  | dimension-anchor validation          | one score lacks its anchor or collapses dimensions | calibrated panel | zero | each dimension retains its own anchored judgment         | invalid if any dimension collapses  |
      | live contestants                         | registered production family | locale-beta   | locked benchmark  | identical decoded context  | provider artifact and billing linkage | one live point has no billed-cost evidence | calibrated panel | one | served evidence resolves and missing cost stays missing | the untraceable point is not plotted |
      | anonymized contestants                   | registered production family | locale-alpha  | locked benchmark  | identical decoded context  | confidence-panel sufficiency         | one judge reports high confidence            | one uncalibrated judge | zero | insufficient calibration is disclosed                  | cannot be high-confidence           |
      | reduced-context baseline                 | registered production family | locale-beta   | locked benchmark  | a manifest excluding Wiki and prior agent output | ablation access and exact-cost audit | one prohibited context access attempt | calibrated panel | one | prohibited access is denied and exact real cost is retained | valid only with the reduced-context manifest |
      | one accepted recorded run                | registered production family | locale-alpha  | locked benchmark  | identical decoded context  | recorded-run admission               | absent replay consent despite provenance, source split, and complete cost | calibrated panel | zero | the missing consent is named exactly                   | admission fails closed              |

  @behavior-evaluation.act-on-confidence
  Scenario Outline: Act on every required confidence dimension independently
    Given evaluation <release_profile> reports <dimension> as <dimension_outcome>
    When the quality lead assesses readiness with <validity_outcome>
    Then release readiness is <readiness_outcome>
    And a failed, missing, or invalid dimension creates <improvement_outcome>
    And repeating the same authorized assessment preserves one stable improvement item
    And each item links affected units, permitted artifacts, and a proposed observation without exposing a private payload
    And strength in another dimension cannot compensate

    Examples:
      | release_profile | dimension            | dimension_outcome | validity_outcome | readiness_outcome | improvement_outcome                |
      | candidate-one   | semantic meaning     | above threshold   | valid            | ready for this dimension | no failure item                 |
      | candidate-one   | rendered layout      | below threshold   | valid            | not ready          | a ranked item tied to affected units, artifacts, and a safe proposed observation |
      | candidate-two   | human calibration    | missing evidence  | invalid          | not ready          | a missing-proof item tied to affected units and a safe proposed observation |
      | candidate-three | judge confidence     | one judge only    | invalid          | not ready          | an insufficient-panel item tied to affected units and a safe proposed observation |
