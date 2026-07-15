# Privacy, retention, and egress contract

This is the binding contract for the rebuilt LLM boundary. It applies to every
request, tool result, persistence path, log, metric, and recovery path owned by
that boundary. It does not certify older application subsystems; they must not
be reused by the rebuilt dispatcher without meeting this contract.

The policy manifest is
[`privacy.ts`](../../apps/itotori/src/contracts/privacy.ts). App bootstrap
parses it, and a rebuilt live dispatcher must also call
`assertRebuildLlmStartupPolicy` before it can construct transport. A failure is
startup-fatal; there is no warning, fallback, or per-call privacy opt-out.

## Scope and terms

Content-bearing data means source text, target text, prompts, model responses,
tool arguments and results, web excerpts, rendered OCR text, and any value from
which one of those can be reconstructed. Hashes, opaque IDs, byte counts,
timestamps, route policy, model/provider identifiers, and bounded error codes
are metadata only when they contain no content.

External egress means a request to a system other than the local process,
database, controlled object store, or OpenRouter. A local read tool is not
external egress. A provider-hosted tool is external egress even when invoked as
part of an inference request.

## OpenRouter privacy boundary

OpenRouter is the only inference and billing egress. Every physical model step,
including a retry and every step of a tool loop, must be planned and validated
as `RebuildCallWirePolicySchema` before bytes leave the process. The plan must
contain all of the following:

| Wire part                     | Required value                                                  |
| ----------------------------- | --------------------------------------------------------------- |
| `model`                       | Exact versioned model slug; never a router, `auto`, or `latest` |
| `provider.order`              | Non-empty ordered approved-provider list                        |
| `provider.only`               | The same providers as `order`; it is the allow-list             |
| `provider.allow_fallbacks`    | `false`                                                         |
| `provider.zdr`                | `true`                                                          |
| `provider.data_collection`    | `"deny"`                                                        |
| `provider.require_parameters` | `true`                                                          |
| `X-OpenRouter-Metadata`       | `enabled`                                                       |
| `X-OpenRouter-Cache`          | `false`                                                         |
| plugins                       | Empty list                                                      |
| remote cache                  | Disabled                                                        |
| transport retries             | Disabled; only the visible rebuilt retry policy may retry       |

The outbound capture test is the final authority: it must assert the actual
snake-case JSON body and headers. SDK option types are not evidence that a
camel-case field reached the wire. A call with a missing or different field is
not dispatched.

Defense in depth is mandatory:

1. The OpenRouter account is ZDR-only for every selectable model group; input
   and output logging and data-use opt-ins are off.
2. The API key is restricted by a guardrail that repeats ZDR and data-collection
   constraints.
3. The operator explicitly provides both `OPENROUTER_ZDR_ACCOUNT_ASSERTED=1`
   and `OPENROUTER_ZDR_GUARDRAIL_ASSERTED=1` before rebuilt live transport
   starts.
4. The per-call routing block above is always sent.

No OpenRouter plugin, hosted search, server-side tool, response healer,
provider-side conversation state, or remote response cache is allowed. A future
Responses implementation must additionally use `store: false`.

The dispatcher records requested and served model/provider pairs separately.
It enables router metadata and persists the generation ID. The current RB-015
writer uses `served_pair_status = 'confirmed'` only when the
whole served pair was present and schema-valid after parsing stream metadata: it
is stream-attested, not independently verified against OpenRouter. Acceptance
requires an active source memo whose `generation_id` is present, served pair is
`confirmed`, and verification status is `verified`; otherwise the response is
quarantined and cannot contribute to an accepted artifact. Independent
OpenRouter `/generation` reconciliation is deferred to RB-010, gated on upstream
issue #941. Until then, the injected lookup seam defaults to unknown and no
production `/generation` client is implied.

## Local storage and access

Content-bearing local storage uses operator-managed envelope encryption. Plain
content may exist only in process memory during an authorized operation. It is
never placed in plaintext database columns, local volumes, queues, caches,
backups, diagnostics, or telemetry.

The persistence implementation must meet all of these rules:

- A database column or volume containing content is encrypted and named or
  typed as encrypted/ciphertext; its key reference is separate from ciphertext.
- The durable row includes content hash, retention deadline, encryption key
  reference, and deletion state. The hash is not a substitute for ciphertext.
- Source material mounted for decoding is an encrypted, job-lifetime volume.
  It is wiped before the job is acknowledged and is excluded from snapshots and
  backups.
- Content decryption occurs only after an exact `content.read` permission check.
  Authorization is permission-based; no read decision may branch on a role
  name. The caller, grant, content reference, purpose, and outcome are audited
  without logging content.
- Derived indexes, embeddings, exports, and temporary files are content-bearing
  unless they are demonstrably irreversible. They inherit the same encryption,
  permission, retention, and deletion rules.

The encrypted references in the rebuilt conversation and call contracts make
the content boundary explicit. The future persistence migration must register
every rebuilt-LLM content column with the encryption implementation; an
unregistered plaintext content field is a release-blocking defect.

## Content-free observability

Logs, errors, traces, metrics, and audit events must contain only metadata.
They must never contain source or target text, prompts, responses, tool
arguments/results, web excerpts, OCR text, or serialized request/response
bodies. This includes exception interpolation and debug formatting.

Use content hash, opaque IDs, byte/token counts, redaction class, error code,
and a bounded reason instead. Failure handling must redact before emitting and
must preserve the original encrypted payload only where persistence policy
allows it. Tests inject a unique content sentinel through success, error, retry,
and telemetry paths and prove it is absent from every observable record.

## Retention and deletion

Deletion is an explicit lifecycle operation, not an implication of a status
change. Every content record has a terminal timestamp and a non-null deletion
deadline. The deadlines are measured from terminalization or supersession; a
derived artifact does not restart its source's clock.

| Content class                                         | Maximum retention       | Deletion result                                                |
| ----------------------------------------------------- | ----------------------- | -------------------------------------------------------------- |
| Provider attempt request/response and failed output   | 7 days                  | Ciphertext deleted, key destroyed, metadata tombstone retained |
| Conversation, tool, web, and non-accepted run content | 30 days                 | Ciphertext deleted, key destroyed, metadata tombstone retained |
| Accepted content needed for reproducibility           | 365 days                | Ciphertext deleted, key destroyed, metadata tombstone retained |
| Decoded source volume                                 | Authorized job lifetime | Volume wiped before job acknowledgement                        |

The deletion worker runs at least daily, is idempotent, and records a tombstone
with deletion time and content hash. It must delete ciphertext, destroy the
associated encryption key, remove derived content, and verify that a subsequent
content read fails. An expired record cannot be silently retained, resurrected
from a backup, or served from a cache. A retention change requires a new
versioned policy and migration; it cannot be supplied as an ad-hoc runtime
override.

## Billing truth (target contract; RB-010 deferred)

The `/generation`-reconciled billing state below is the target contract for
RB-010, not a claim that RB-015 independently reconciles stream metadata.

Billing states are deliberately disjoint:

- `confirmed` means the generation ID was reconciled with OpenRouter's
  `/generation` record and has an authoritative cost.
- `billing_unknown` means dispatch may have reached OpenRouter but billing is
  not yet authoritative, including transport loss, a malformed response, or a
  missing generation record. It is never recorded as zero or as confirmed.

The RB-010 reconciler will make one OpenRouter-only `/generation` lookup when a
generation ID is available and store its evidence. It may transition an unknown
entry to confirmed, but it will not erase the original uncertainty evidence.
Reporting, admission, and acceptance must keep confirmed and unknown totals
separate.

## Egress

There is exactly one external-egress exception: direct `web_search` for the
configured analyst role. It is allowed only when an operator explicitly enables
egress, it is absent from every other role's allow-list, and the call first
passes `assertWebSearchEgress`.

Each persisted web result includes URL, retrieval date, content hash, `web`
provenance, and low-or-medium confidence. It may not override decoded or
same-work facts until corroborated. Query text and fetched content are
content-bearing and follow the local encryption, read, logging, and deletion
rules after receipt.

Qualifying runs set `qualifyingRun: true` and `webSearchEnabled: false`; the
strict qualifying-run schema rejects any other combination. In that mode no
query and no fetched content may leave the ZDR boundary. Every other external
request is forbidden; inference and billing reconciliation remain OpenRouter
only.

## Enforcement status

| Control                                                                                                                   | Enforced now                        | Completion evidence required when its implementation lands     |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| Policy manifest shape, startup validation, account/guardrail assertions, qualifying-run egress, A7-only web authorization | Yes                                 | Unit tests and startup failure tests                           |
| Exact private call plan                                                                                                   | Yes, as a strict schema             | Captured actual wire test for every adapter                    |
| Encrypted conversation/call references                                                                                    | Yes, in rebuilt contracts           | Persistence round trip with ciphertext-only inspection         |
| Plaintext rebuilt-LLM migration fields and obvious content-bearing log calls                                              | Yes, by the privacy audit           | Negative fixture tests plus CI gate                            |
| Encryption implementation, permission-before-decrypt, deletion worker, backup/volume wipe                                 | Contract and audit registration now | Integration tests against real storage and the deletion worker |
| Stream-attested served pair plus quarantine projection                                                                    | Yes, RB-015                         | Live persistence and independent guard-mutation tests          |
| Independent `/generation` route and billing reconciliation                                                                | Deferred to RB-010 (upstream #941)  | Provider conformance and reconciliation tests                  |

The audit is intentionally conservative and scoped to the rebuilt LLM tree and
its `itotori_llm_*` migrations. It does not treat older paths as compliant.
