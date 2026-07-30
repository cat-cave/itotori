Feature: Install and operate a durable compatible service
  Operators use public formats, packages, configuration, persistent outcomes,
  and retained artifacts without depending on this repository's build topology.

  @behavior-platform.public-formats-upgrade-predictably
  Scenario Outline: Interpret public formats and requests with one predictable meaning
    Given <consumer> holds <format_kind> at <from_version>
    When version <to_version> reads or migrates <compatibility_case>
    Then every exposed boundary returns <expected_outcome>
    And an incompatible case names the exact migration or version requirement
    And no boundary silently interprets the same version differently
    And rejected requests create no persisted effect
    And package, command, service, and produced-artifact versions agree without placeholder values

    Examples:
      | consumer          | format_kind         | from_version | to_version | compatibility_case | expected_outcome             |
      | installed client  | standard content    | version-one  | version-two | supported migration | one equivalent migrated value |
      | extension author  | patch result        | version-two  | version-one | unsupported downgrade | named incompatibility       |
      | service operator  | runtime observation | version-two  | version-two | current format       | one accepted meaning          |
      | service client    | current public request | current    | current    | unknown field, arbitrary value, malformed timestamp or variant, wrong method, or unknown query | exact client refusal before any effect |
      | service client    | current public response | current   | current    | success, malformed, permission, not-found, conflict, pagination, or redaction | the exact schema-valid outcome |

  @behavior-platform.interrupted-work-resumes-once
  Scenario Outline: Resume accepted durable work exactly once after interruption
    Given <operation> under <delivery_case> has reached <interruption_point> at <placement>
    When service handles <control_case> after <fault_case>
    Then accepted history and prior artifacts remain intact
    And the operation ends as <recoverable_state>
    And progress, failure, or cancellation reports <status_outcome>
    And competing delivery ends as <completion_outcome>
    And its result, message, and charge occur exactly once

    Examples:
      | operation          | delivery_case                         | interruption_point       | placement   | control_case             | fault_case                 | recoverable_state             | status_outcome                  | completion_outcome                           |
      | localization round | one accepted execution attempt        | after accepted admission | self-hosted | resume                   | process restart            | resumed from accepted work    | current progress                | the accepted execution continues once        |
      | artifact publish   | one accepted delivery attempt         | after durable result     | managed     | redeliver                | delivery restart           | published once                | published status                | no duplicate result or delivery               |
      | provider request   | one accepted request attempt          | after provider acceptance | managed    | reconcile                | result uncertainty         | paused for reconciliation     | exact paused reason             | the accepted request remains pending once     |
      | localization round | one accepted execution attempt        | during active work       | managed     | cancel                   | no infrastructure fault    | durably cancelled             | final cancellation status       | the accepted execution closes without result |
      | localization round | one abandoned and one current attempt | before accepted output   | managed     | recover accepted work    | active execution is interrupted | resumed by the current attempt | current progress                | only the current attempt can commit           |
      | localization round | two concurrent execution attempts     | before active work       | managed     | begin work               | no infrastructure fault    | processed exactly once        | one active then terminal status | one attempt wins and one is refused           |
      | complete project   | one accepted durable project          | after every accepted artifact | self-hosted | restart and reconstruct | service restart            | complete project restored      | every read view matches before restart | no duplicate result, message, or charge       |
      | standard extraction | one accepted execution attempt        | after source admission   | self-hosted | resume                   | service restart            | resumed from accepted work     | exact extraction progress        | one output or one exact failure occurs        |
      | patch production    | one accepted execution attempt        | after input validation   | self-hosted | cancel                   | operator cancellation      | durably cancelled              | final patch progress              | no patch result or charge occurs              |
      | runtime observation | one accepted execution attempt        | after session admission  | managed     | resume                   | runtime interruption       | resumed from accepted work     | exact observation progress        | one observation result occurs                 |
      | evaluation comparison | two concurrent execution attempts   | after holdout admission  | managed     | begin work               | no infrastructure fault    | processed exactly once         | one active then terminal status   | one comparison wins and one is refused        |
      | retention maintenance | one abandoned and one current attempt | after eligible scope selection | managed | recover accepted work | service restart            | resumed by the current attempt | exact maintenance progress        | only the current attempt can commit           |

  @behavior-platform.artifacts-are-immutable-and-retained-by-policy
  Scenario Outline: Retain immutable artifacts and history according to declared policy
    Given <actor> handles <artifact_kind> with <privacy_class> classification and <retention_policy>
    When the actor performs <artifact_action>
    Then hash identity, immutability, and authorization end as <expected_outcome>
    And expiry removes only unreferenced eligible content
    And any authorized prune records its exact scope and preserves required referential evidence
    And retained lineage never points to missing content as if it were available
    And every retained audit event preserves its actor, target, outcome, and append order

    Examples:
      | actor                    | artifact_kind       | privacy_class | retention_policy          | artifact_action          | expected_outcome                                         |
      | authorized reviewer      | accepted patch      | project-only  | retain by lineage         | read and compare         | identical immutable bytes                                |
      | retention administrator  | runtime capture     | restricted    | expire when unreferenced  | expire eligible copy     | removed with auditable status                            |
      | public publisher         | public derivative   | public-safe   | retain by release         | attempt replacement      | original identity unchanged                              |
      | ordinary project role    | event history       | project-only  | append-only               | mutate or truncate       | refused with history unchanged                           |
      | retention administrator  | eligible history    | restricted    | declared prune scope      | prune unreferenced scope | only eligible records removed with an auditable receipt  |
      | authorized reviewer      | managed evidence    | restricted    | retain by lineage         | resolve tampered bytes   | refused with an exact hash-mismatch result                |
      | authorized reviewer      | managed evidence    | restricted    | retain by lineage         | store different bytes under an existing identity | refused as an identity collision with original bytes intact |
      | security administrator   | ordered audit history | restricted  | append-only               | reorder events or omit actor, target, or outcome | refused with exact original order and fields intact |

  @behavior-platform.deployment-inputs-and-secrets-are-safe
  Scenario Outline: Accept only documented deployment inputs and safe secrets
    Given <placement> receives configuration from <config_source>
    And a secret arrives from <secret_source> with <value_case>
    When startup ends as <startup_case>
    Then documented values round-trip as <expected_outcome>
    And unknown, malformed, or insecure input fails before service readiness
    And secret values never appear in logs, diagnostics, or retained temporary material
    And wrapper-created secret files are removed on every exit while explicitly supplied files remain untouched

    Examples:
      | placement   | config_source         | secret_source        | value_case          | startup_case | expected_outcome               |
      | self-hosted | documented settings   | protected local source | valid encoded value | ready       | exact accepted configuration   |
      | managed     | documented settings   | custody reference    | valid reference     | ready        | exact accepted configuration   |
      | self-hosted | unknown setting       | protected local source | valid encoded value | refused     | no partially ready service     |
      | managed     | documented settings   | insecure source      | malformed value     | refused      | no printed or retained secret  |
      | self-hosted | documented settings   | explicitly supplied user-owned file | valid encoded value | interrupted | the supplied file remains byte-identical |
      | self-hosted | more than thirty-two documented settings | protected local source | valid encoded value | ready | every setting and value round-trips exactly |
      | self-hosted | more than thirty-two settings with a late duplicate | protected local source | valid encoded value | refused | exact duplicate-setting diagnostic before readiness |
      | self-hosted | documented settings with a non-Unicode value | protected local source | valid encoded value | refused | exact malformed-value diagnostic before readiness |
      | self-hosted | documented settings   | protected local source | dollar signs, quotes, spaces, and backslashes | ready | every supported credential character round-trips exactly |
      | self-hosted | documented settings   | protected local source | unsupported trailing credential form | refused | exact unsupported-form diagnostic before startup with no expansion or leakage |

  @behavior-platform.clean-host-lifecycle-is-guided-and-recoverable
  Scenario Outline: Complete a guided clean-host lifecycle
    Given clean supported <host_profile> has <installed_version> and <font_case>
    When the operator performs <lifecycle_action> using current user documentation
    Then required services, fonts, dependencies, and product commands end as <lifecycle_outcome>
    And representative source and target glyphs end as <font_outcome> before proof capture
    And repeating initialization ends as <rerun_outcome>
    And any ready installed client exercises help, initialize, extract, localize, patch, and validate
    And any patch operation copies only selected output and no unrelated owned files
    And the installed release exposes no test-only provider or failure control
    And data survives or a failed update leaves <runnable_version>
    And every installed dependency has reproducible authorized provenance

    Examples:
      | host_profile         | installed_version | font_case                           | lifecycle_action     | lifecycle_outcome               | font_outcome                                      | rerun_outcome                    | runnable_version  |
      | supported local host | none              | representative licensed fonts available | initialize       | ready documented installation   | representative glyphs render without missing-glyph boxes | existing state remains singular | installed current |
      | supported local host | version-one       | representative licensed fonts available | apply a valid signed versioned update | ready upgraded installation | representative glyphs render without missing-glyph boxes | existing state remains singular | version-two       |
      | supported local host | version-two       | representative licensed fonts available | failing update   | no partial upgraded service     | prior glyph rendering remains available           | existing state remains singular | version-two       |
      | supported local host | none              | one required font unavailable          | initialize       | blocked before readiness        | exact missing-font diagnosis before evidence      | no partial or duplicate state   | none              |
      | supported local host | version-two       | representative licensed fonts available | initialize again | ready unchanged installation    | representative glyphs render without missing-glyph boxes | no destruction or duplication | version-two       |
      | supported local host | version-two       | representative licensed fonts available | run installed command suite | every documented command returns its declared outcome | representative glyphs render without missing-glyph boxes | existing state remains singular | version-two |
      | supported local host | version-two       | representative licensed fonts available | apply an invalid-signature update | update refused before replacement | prior glyph rendering remains available | existing state remains singular | version-two |
