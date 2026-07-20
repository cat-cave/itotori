# Reconciled token groups

The Dusk Observatory design reference originally flagged seven token groups that
Itotori surfaces needed before hi-fi and component port work could avoid ad-hoc
values. They are now reconciled in the repo token layer and summarized in
[`docs/design/itotori-design-system.md`](../../docs/design/itotori-design-system.md)
§"Reconciled missing-token candidates".

Status legend: **added** = introduced by `ds-spec-missing-tokens`; **present** =
already existed in `tokens/*.css` and was verified by this node.

| Group                         | Status  | Token prefix / names                                                       | Consumers                                                               |
| ----------------------------- | ------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Cost / spend semantics        | added   | `--ito-cost-billed-ink`, `--ito-cost-zero-muted`, `--ito-cost-unknown-*`   | Overview cost band, pass-ledger spend cells, StatReadout cost readouts. |
| ZDR / privacy posture         | added   | `--ito-privacy-ok-*`                                                       | Persistent status bar and model/provider privacy posture badges.        |
| Frame / render overlay        | added   | `--ito-render-*`                                                           | ScenePlayer textbox and nameplate over game frames.                     |
| Redaction state               | present | `--ito-redact-*`                                                           | Runtime-evidence frames and shared screenshots.                         |
| Annotation severity scale     | present | `--ito-severity-{blocker,critical,warning,note}` plus bg/border companions | AnnotationComposer and QA finding rows.                                 |
| Pass-ledger / iteration state | added   | `--ito-pass-*`                                                             | Pass N / N+1 rows, accepted deltas, superseded/diff states.             |
| Locale-branch identity        | added   | `--ito-locale-source-*`, `--ito-locale-target-*`                           | LocaleBranchSwitch, BiText, ComparisonPane, source->branch status bar.  |

Component CSS must keep referencing these variables, not literal values. The
focused token test (`test/tokens.test.ts`) pins the reconciled names and checks
that component surfaces have no hard-coded colour literals or dangling
`var(--ito-*)` references.
