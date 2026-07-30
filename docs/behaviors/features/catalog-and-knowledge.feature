Feature: Select and prepare lawful localization work
  Producers and reviewers work from sourced facts, exact owned releases, and
  isolated locale guidance through boundaries another implementation can expose.

  @behavior-catalog.refresh-sourced-candidates
  Scenario Outline: Refresh sourced candidates without losing provenance
    Given <source_kind> has <source_admission>, <relationship_case>, and <fact_case>
    And channel <channel_case> has <privacy_case> with <conflict_case>
    And its last accepted refresh is available
    When the operator performs a <refresh_mode> refresh with <interruption_case>
    Then the persisted candidates retain their source, revision, and privacy class
    And relationships, unique counts, and gaps end as <catalog_outcome>
    And exposed candidate data is <disclosure_outcome>
    And the completed candidate set is <expected_result>

    Examples:
      | source_kind       | source_admission   | relationship_case                    | fact_case                         | channel_case       | privacy_case                          | conflict_case          | refresh_mode | interruption_case   | catalog_outcome                                      | disclosure_outcome                                      | expected_result                         |
      | recorded feed     | registered         | valid multi-release relationships     | every imported fact has an origin | direct source      | public-safe                           | no conflicting facts   | incremental  | no interruption     | identities and relationships round-trip exactly     | only admitted public fields                            | complete and provenance-linked          |
      | unknown feed      | unregistered       | no admitted relationships             | no admitted facts                 | direct source      | unclassified                          | no conflicting facts   | full         | no interruption     | no relationship or fact persists                    | no candidate data                                      | refused without persistence             |
      | recorded feed     | registered         | valid relationships                   | language and conflict kind absent | direct source      | public-safe                           | no conflicting facts   | incremental  | no interruption     | absent values stay absent without invented defaults | only admitted public fields                            | complete with explicit source gaps      |
      | local catalog     | registered         | two lawful local candidate identities | complete hash and profile facts   | private local scan | restricted                            | no conflicting facts   | resumable    | no interruption     | both candidates count once and remain selectable    | safe identities without roots, filenames, or owned content | complete and private                  |
      | community source  | registered         | equivalent reports link               | consent and provenance present    | two community channels | personal data removed              | duplicate reports       | incremental  | no interruption     | duplicates merge once with both origins             | consented redacted report fields                        | complete and deduplicated               |
      | recorded feed     | registered         | one dangling or cross-work relation    | complete sourced facts            | direct source      | public-safe                           | no conflicting facts   | full         | no interruption     | invalid relationship is rejected                    | only admitted public fields                            | refused without partial persistence     |
      | combined feeds    | registered         | overlapping evidence pools             | one known fact removed            | several sources    | mixed permitted classes               | one unresolved conflict | resumable   | interruption midway | overlaps count once and the exact gap changes       | each field follows its declared class                  | identical after a resumed refresh       |
      | contradictory sources | registered      | valid source relationships              | platform and language facts retain each origin | several sources | public-safe                        | incompatible sourced facts | full      | no interruption     | both originals remain inspectable and resolution appends without overwrite | only admitted public fields             | a resolved view with immutable source evidence |

  @behavior-catalog.select-owned-release
  Scenario Outline: Select an exact owned release and work scope without guessed identity
    Given a producer lawfully holds a candidate with <match_outcome>
    And the candidate reports <readiness> for <engine_profile>
    And query <query_case> uses <filter_case>
    And the candidate exposes <entry_case>
    When the producer compares its edition, platform, language, and provenance and performs <selection_action>
    Then selection ends as <selection_outcome>
    And returned candidates and selected scope are <scope_outcome>
    And an ambiguous release or work entry is not silently committed

    Examples:
      | match_outcome             | readiness                  | engine_profile       | query_case                       | filter_case                               | entry_case                         | selection_action                 | selection_outcome                         | scope_outcome                                                |
      | one exact sourced match   | declared limitations       | a recognized profile | exact candidate lookup            | valid edition and platform filters         | one unambiguous work               | select the exact release         | the exact release is selected             | one exact persisted work scope                                |
      | several fuzzy matches     | conflicting evidence       | an unknown profile   | ranked candidate lookup           | valid evidence filters                     | one unambiguous work               | leave unresolved                 | selection remains unresolved              | explained candidates without a guessed commitment             |
      | several sourced matches   | complete required support  | a recognized profile | benchmark seed query               | all required capabilities before the limit | one work per candidate             | inspect qualifying rows          | no release is silently selected           | every row satisfies every filter and lower-volume matches remain |
      | one sourced match         | declared limitations       | a recognized profile | malformed benchmark seed query     | an unknown or malformed filter              | one unambiguous work               | request candidates               | an exact client error                     | no candidate is prefiltered or selected                       |
      | one exact sourced archive | declared limitations       | a recognized profile | owned archive lookup               | valid identity filters                     | two discovered work entries        | accept both discovered entries   | the exact archive is selected             | two disjoint required-unit scopes with shared context          |
      | one exact sourced archive | declared limitations       | a recognized profile | owned archive lookup               | valid identity filters                     | ambiguous automatic work discovery | provide an explicit entry override | the exact archive and entry are selected | one exact scope with no overlapping or guessed units           |
      | same-release evidence with an incompatible-platform report | language support under review | a recognized profile | exact candidate lookup | valid release and platform filters | one unambiguous work | inspect platform-language support | compatible evidence contributes while incompatible evidence stays unknown or review-only | the demotion basis and every original source remain visible |
      | one exact sourced match   | identification observed and every downstream operation unobserved | a detector-only profile | exact candidate lookup | valid identity filters | one unambiguous work | inspect readiness | detector-only readiness with no inferred support | only identification is available; every unobserved operation names its evidence class and limitation |
      | one mixed local inventory | declared per-candidate limitations | recognized discovered profiles | redacted count and hash lookup | valid engine and profile filters | one unambiguous owned candidate | select by its safe identity | the exact private candidate is selected | one exact scope without absolute path, private filename, or text |
      | two known-equivalent releases | declared limitations | a recognized profile | exact identity lookup | canonical external identifiers and hashes | two release identities for one work | resolve the equivalent identities | one canonical work is selected | both immutable release origins remain linked to that work |
      | two conflicting exact identities | conflicting evidence | a recognized profile | exact identity lookup | canonical external identifiers and hashes | incompatible work mappings | request automatic resolution | selection remains unresolved with the exact conflict | both conflicting identities and their evidence remain inspectable |
      | one exact sourced edition | declared patch compatibility | a recognized profile | compatible patch-target lookup | valid edition and platform filters | compatible targets plus one cross-work target | inspect patch targets | only compatible same-work targets are selectable | the cross-work target is rejected with its exact relationship evidence |
      | ranked opportunities before and after one sourced fact changes | evidence-backed readiness | a recognized profile | ranked opportunity lookup | demand, availability, edition fit, runtime evidence, and benchmark filters | one unambiguous work per candidate | recompute the ranking | rank and explanation change only from the changed fact | static family metadata contributes no launched-runtime evidence |

  @behavior-studio.find-authorized-work
  Scenario Outline: Navigate accessible authorized work without stale or cross-scope results
    Given <actor> may access <resource_kind> in the selected account and locale
    And the collection contains <collection_size> equally sortable records
    When the actor uses <navigation_mode> at <viewport_case> while <selection_transition>
    Then the rendered results have <collection_outcome>
    And the interface has <interface_outcome>
    And <action_case> ends as <action_outcome>
    And <response_case> ends as <transition_outcome>
    And direct navigation or refresh returns the addressed interface while non-interface requests retain their own result
    And one search returns a ranked heterogeneous authorized set with stable addresses and one global limit
    And resources outside <authorization_scope> are absent

    Examples:
      | actor              | resource_kind   | collection_size | navigation_mode               | viewport_case            | selection_transition                          | collection_outcome           | interface_outcome                                       | action_case                       | action_outcome                           | response_case                         | transition_outcome                           | authorization_scope  |
      | project member     | all core routes | 25              | direct navigation and refresh | representative desktops  | selected context stays unchanged              | one current addressed view   | no clipped action and unambiguous global privacy status | an authorized contextual action   | the action completes                     | current response                      | applied to the selected context               | the selected project |
      | portfolio operator | projects        | 50000           | search and pagination         | narrowed desktop width   | selected context stays unchanged              | no duplicate or missing row  | named keyboard-operable controls remain visible         | a permitted contextual action     | the action completes                     | current response                      | applied to permitted accounts                | permitted accounts   |
      | project member     | locale runs     | 25              | contextual command search     | keyboard-only navigation | selected context stays unchanged              | one current addressed result | names, roles, values, and focus remain available         | a disabled context-invalid action | it stays disabled with an exact reason   | current response                      | applied to the selected context               | the selected project |
      | multi-account user | projects        | 25              | account switch                | representative desktops  | active account changes                         | only new-account projects     | selected account and identity remain unambiguous         | inspect current grants             | only new-account grants appear           | a prior-account response               | discarded without changing the new selection | the new account      |
      | project member     | locale runs     | 25              | project and locale switch     | representative desktops  | active project and locale change               | only new-branch records        | the exact selected context remains visible               | open a branch-scoped view           | the addressed new-branch view opens      | a stale prior-selection response       | discarded without leaking or replacing data  | the new branch       |
      | project member     | projects, scenes, terms, runs, and artifacts | 50000 | one ranked heterogeneous search | keyboard-only navigation | selected context stays unchanged | authorized types interleave without exceeding the global limit | every result has a stable address and declared kind | open one heterogeneous result | its exact addressed view opens | current response | applied to the selected context | the selected project |

  @behavior-privacy.govern-evidence-disclosure
  Scenario Outline: Govern private and public evidence disclosure
    Given <actor> is authorized for <view_mode> access to <artifact_kind>
    And the artifact is classified as <privacy_class>
    When the actor previews or publishes it through the evidence boundary
    Then the result contains <expected_content>
    And the stored artifact retains its original classification and lineage
    And when no compliant derivative exists, publication is disabled with the exact policy reason

    Examples:
      | actor             | view_mode   | artifact_kind       | privacy_class | expected_content                         |
      | project reviewer  | private     | runtime observation | restricted    | the authorized full-fidelity observation |
      | public publisher  | public-safe | evidence summary    | restricted    | only non-reconstructive redacted fields  |
      | unrelated account | private     | source artifact     | restricted    | no artifact content                      |
      | public publisher  | public-safe | private Wiki media with no derivative | restricted | no blob content and a disabled publication action naming the missing derivative |

  @behavior-project.create-locale-branch
  Scenario Outline: Create an isolated locale branch from one source revision
    Given source revision <source_revision> is selected for <work_scope>
    When the producer creates target branch <target_locale>
    Then source facts remain shared and immutable
    And guidance, output, cost, patch, and play history are isolated as <isolation_outcome>
    And complete project and branch state either commits atomically or leaves no partial persisted object
    And every new branch exposes its explicit default policy, readiness checks, and required artifact set
    And retrying the same creation returns the same branch without duplication or partial state
    And any returned project identity can immediately start its first permitted run

    Examples:
      | source_revision | work_scope     | target_locale | isolation_outcome                   |
      | revision-one    | one work       | locale-alpha  | a new independent branch            |
      | revision-one    | a related set  | locale-beta   | no state copied from another locale |
      | revision-two    | one selected catalog candidate | locale-alpha | one complete project state and a run-ready branch |
      | invalid revision | a candidate with an invalid relationship | locale-beta | refused with no project, branch, accepted work, round receipt, or artifact |
      | revision-two    | the same selected candidate retried | locale-alpha | the original branch identity and defaults with no duplicate |

  @behavior-project.configure-localization
  Scenario Outline: Configure versioned localization policy by branch
    Given branch <target_locale> contains <surface_kind>
    When the producer changes <setting_kind> with <conflict_case>
    Then the accepted policy is versioned for that branch
    And the affected surfaces report <policy_outcome>
    And the exact required-unit set ends as <required_set_outcome>
    And the saved policy governs the next equivalent command, HTTP, and rendered-interface run
    And an out-of-policy surface is refused rather than silently skipped

    Examples:
      | target_locale | surface_kind       | setting_kind        | conflict_case               | policy_outcome                  | required_set_outcome                         |
      | locale-alpha  | dialogue           | terminology         | no conflict                 | the new term applies            | unchanged because terminology does not alter scope |
      | locale-beta   | image text         | localization scope  | an overlapping exclusion    | the conflict requires a choice  | unchanged until the conflict is resolved     |
      | locale-alpha  | dialogue and choices | localization scope | no conflict                | the selected surfaces apply     | exactly the selected units are required      |
      | locale-beta   | unsupported surface | localization scope | outside the declared policy | the setting is refused          | no silent omission or added required unit    |

  @behavior-knowledge.maintain-source-wiki
  Scenario Outline: Maintain complete cited source facts
    Given <work_scope> contains <fact_kind> supported by <evidence_kind>
    And completeness is <completeness_case>
    When an authorized reviewer performs <edit_outcome>
    Then the source Wiki retains the fact's citation, version, and route scope
    And completeness ends as <knowledge_outcome>
    And dependent locale guidance ends as <dependent_locale_outcome>
    And target-locale guidance does not mutate the source fact

    Examples:
      | work_scope     | fact_kind             | evidence_kind          | completeness_case                         | edit_outcome                   | knowledge_outcome                              | dependent_locale_outcome                     |
      | one work       | character identity    | decoded structure      | all required fields or source-absent proof | an evidenced correction        | complete cited source knowledge                | every dependent locale is marked stale       |
      | related works  | relationship          | a sourced citation     | all required fields or source-absent proof | a scoped cross-work addition   | complete cited source knowledge                | affected locale guidance requires refresh    |
      | configured work | all required objects | complete sourced facts | all dependencies resolve                   | retain the accepted snapshot   | every object and field is populated or absent  | dependent locale guidance stays current      |
      | configured work | one required object  | its cited source       | one required entry removed                  | request a completeness report  | failed with the exact missing dependency       | drafting remains blocked                     |
      | configured work | owned media citation | matching media bytes and hashes | provenance and privacy class accepted | ingest the matching bytes twice | one hash-identified blob with both citations | dependent rendering remains current |
      | configured work | owned media citation | a changed media hash   | prior bytes remain cited                     | accept the changed-byte revision | one new media version with the prior version retained | dependent rendered assets are marked stale |
      | configured work | nonblocking source enhancement | an accepted cited addition | the prior patch remains reproducible | accept the dependent revision | one new source fact version visibly supersedes the prior version | one new guidance and patch revision visibly supersedes the reproducible prior patch |

  @behavior-knowledge.prepare-locale-context
  Scenario Outline: Prepare frozen ground truth for each target locale
    Given source facts for <work_scope> are accepted
    And branch <target_locale> requests <context_kind>
    And mandatory context is <context_completeness>
    When <change_kind> is incorporated before the round starts
    Then locale guidance ends as <preparation_outcome>
    And drafting cannot begin when mandatory context is absent
    And every dependent target and its lineage cite the same accepted guidance version
    And a target fact that contradicts that version is rejected or retained as an explicit conflict
    And guidance for other locales and source facts remains unchanged

    Examples:
      | work_scope   | target_locale | context_kind        | context_completeness                | change_kind                    | preparation_outcome                         |
      | one work     | locale-alpha  | voice and names     | every mandatory field is cited      | an approved style change       | complete, cited, and frozen for the round  |
      | related set  | locale-beta   | terms and relations | every mandatory field is cited      | a corrected sourced fact      | complete, cited, and frozen for the round  |
      | one work     | locale-alpha  | terms and voice     | one mandatory field is missing      | no accepted replacement       | a resumable pre-drafting pause             |
      | one work     | locale-beta   | accepted fact and target lineage | every mandatory field is cited | a contradictory target fact is submitted | rejected or retained as an explicit conflict against the same guidance version |

  @behavior-knowledge.retrieve-authorized-precedent
  Scenario Outline: Retrieve branch-compatible precedent without leaking private text
    Given <actor> has <authorization_case> for branch <target_locale>
    When the actor queries accepted history using <match_case>
    Then retrieval ends as <retrieval_outcome>
    And authorized matches are ranked by branch compatibility and evidence
    And a denied result exposes no target text or source identity

    Examples:
      | actor               | authorization_case | target_locale | match_case                         | retrieval_outcome                               |
      | project producer    | permitted          | locale-alpha  | exact and contextual source match  | ranked branch-compatible accepted targets       |
      | project reviewer    | permitted          | locale-beta   | normalized and fuzzy source match  | ranked branch-compatible historical evidence    |
      | unrelated account   | denied             | locale-alpha  | exact source match                 | a schema-valid denial without text or identities |
