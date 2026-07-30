# Maximum-truth private real-input proof

Full-fidelity source, dialogue, patches, frames, art, audio, prompts, provider
responses, and runtime captures stay on a private evidence path. Public CI sees
only externally derived, schema-restricted attestations. Candidate code is
hostile for this design: it cannot choose what is published, hold a proof key,
or obtain a public artifact credential.

## Measured failure and immediate quarantine

| Current fact                                                                                                                      | Evidence                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| The runner API reports zero registered runners                                                                                    | `gh api repos/cat-cave/itotori/actions/runners`                                                                                 |
| In 21 inspected scheduled runs, each private job had zero executed steps: 20 cancelled and one queued                             | Actions run/job API for `real-bytes-oracle.yml`                                                                                 |
| The opt-in selector executes only preflight, not extract, structure, patch, or replay                                             | `.github/workflows/real-bytes-private-proof.yml` and `scripts/developer-command.mjs`                                            |
| Preflight hashes the hash-list file rather than every selected corpus byte                                                        | `scripts/ci/private-real-byte-proof.mjs`                                                                                        |
| Preflight expects an absolute `root`, while the documented registry uses `ITOTORI_VAULT_ROOT` plus mount-relative `relative_path` | `docs/fixtures-and-corpora.md:147-166`, `crates/corpus-registry/src/lib.rs:61-72`, and `scripts/ci/private-real-byte-proof.mjs` |
| A dynamically read provider profile is outside the closed deployment registry                                                     | `scripts/ci/private-real-byte-proof.mjs`, `.env.example`, and `config/environment-registry.json`                                |

The current opt-in workflow is also an exfiltration path. A label can send
pull-request-controlled code and a repository-local composite action to the
corpus-tagged host. That code can place arbitrary private bytes at the upload
path; `always()` then gives the public Actions upload step a chance to publish
them even after preflight fails. Its `if-no-files-found: warn` also permits a
green run with no receipt.

Disable the corpus jobs and remove their pull-request/label route **before**
attaching any corpus-bearing host. Do not reuse that workflow for the
replacement. GitHub's
[secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use)
warns that self-hosted runners do not provide a clean isolated environment and
are almost never appropriate for public repositories.

## Admission sequence

Private and human work happens after review but before queue admission:

```text
approved, reviewed candidate tree
  → external verifier validates cells, issue dependencies, and policy
  → protected hosted broker job presents a pinned OIDC identity
  → broker admits one immutable request to a clean private evidence agent
  → machine stages run and the sidecar seal private evidence
  → authorized human supplies played-round/export receipts where required
  → external verifier admits the exact candidate tree
  → merge group verifies tree/dependency-cone equivalence only
  → main verifies the squashed tree/build equivalence before release
```

No corpus run, provider call, played review, successor round, or export begins
inside the merge queue. If a merge group changes an affected tree or dependency
cone, admission is red and the changed candidate needs new protected evidence.

The broker-facing hosted job is protected outside the candidate tree. It alone
has job-scoped `id-token: write`; the candidate execution job and every private
agent have no GitHub token capable of publishing an artifact or check. Never
use `pull_request_target` to execute candidate code.

The broker validates the execution identity's exact OIDC issuer, dedicated
audience, subject, immutable repository-owner and repository IDs, allowed
event, run ID, run attempt, token `jti`, and—when reusable—the exact
`job_workflow_ref` and `job_workflow_sha`. OIDC execution claims do not prove a
target candidate tree. The external App independently resolves the reviewed
target head SHA, tree, ref, approval state, requested cells, and
dependency-cone digests, then binds them into the one-use nonce/request along
with expiry, sandbox image, policy, and custody request. GitHub documents the
execution claims and job-scoped token permission in its
[OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).
Any omitted, replayed, mutable, fork-substituted, or mismatched claim is red.

## Private inventory and immutable custody snapshot

The private inventory is signed configuration, not a ninth deployment input.
It contains:

- opaque corpus/title IDs, lawful-use basis, owner/custodian, privacy class,
  retention class, and allowed validation scope;
- canonical engine/profile and independent-title group;
- mount-relative object references plus custody-secret references;
- every selected entry's opaque ID, type, size, and expected digest;
- expected file/byte counts and domain-separated Merkle root; and
- allowed stages, assertions, provider posture, and resource limits.

Before candidate code can read input, a trusted sidecar:

1. validates request signature, nonce, reviewed tree, adapter manifest,
   dependency cone, toolchain, image, cells, and two-title quorum: two distinct
   reviewed title-equivalence groups with independent acquisition/provenance
   records, different corpus roots, and no alias, edition, or copy counted
   twice;
2. resolves the mount-relative inventory under the one approved custody root;
3. creates a verity/seal-backed immutable snapshot, content-addressed store, or
   equivalent backing that cannot change in place during the run, then holds
   descriptor-rooted, no-follow handles into that snapshot;
4. rejects symlinks, aliases, devices, writable roots, mount escape,
   unexpected entries, duplicate identities, and case-fold collisions;
5. reads and hashes every selected byte through those handles, with canonical
   domain separation for entry, directory, and root nodes;
6. compares every entry digest, file/byte count, and private raw Merkle root;
7. repeats the descriptor and Merkle checks after execution as defense in
   depth; and
8. rejects a missing immutability guarantee, mutation attempt, replacement,
   disappearance, or any before/after mismatch.

The raw Merkle root, paths, exact counts, and stable corpus digests stay
private. A public attestation may carry only a request-specific keyed or
randomized commitment scoped to one policy and verifier, so repeated
publication does not create a stable corpus identifier or dictionary oracle.

Missing input, an empty selection, zero bytes, one title, or an unknown
inventory entry is a failed proof. Nonapplicable cases are absent from the
signed plan; selected work never succeeds by skipping.

Before releasing anything, the customer key agent preallocates the exact output
recipient and key/nonce namespace and marks the attempt spent. Only then may it
release named object and provider-credential keys over the attested,
session-bound channel. A replay, fork, recipient change, or namespace reuse is
red; project epoch keys never reach a job or operator.

## Sandbox and controlled provider boundary

Each request uses a freshly created unprivileged VM or equivalent one-use
isolation boundary with:

- a digest-pinned operating system, toolchain, browser, renderer, fonts, and
  audio image;
- exact source/build subjects verified before launch;
- read-only least-scope corpus handles and a bounded scratch/output volume;
- no host socket, cloud metadata, sibling corpus, broker key, signing key, raw
  provider credential, GitHub publication token, or general network route;
- fixed CPU, memory, disk, process, decompression, output, call, token, byte,
  and deadline limits with private high-water measurements; and
- unconditional scratch-key destruction and sandbox disposal after sealing.

In managed-confidential placement, plaintext exists only in bounded memory/
tmpfs; every input/output object outside that boundary is encrypted R2
ciphertext for the preallocated recipient. Persistent scratch, swap, crash
dumps, and plaintext disk snapshots are red.

Default is no egress. Only a selected live-provider case enables a trusted,
attested egress component inside the customer-controlled executor boundary. It
uses the customer's provider account and one-use custody credential and opens
direct executor TLS—never an operator gateway—to exactly the customer-signed
DNS name, resolved-address policy, host, port, certificate identity,
provider/model, and zero-data-retention posture. Any external policy monitor
is non-terminating and sees only connection metadata and ciphertext.

The trusted component constructs or validates the exact authorized unit
payload set and hashes, signed prompt/template digest, HTTP method/path,
content type, and response bound. Redirects are disabled unless the signed
policy names an exact destination; CONNECT, protocol upgrade, tunneling, and
arbitrary request bodies are forbidden. It emits authenticated destination,
call, token, plaintext-byte, response-byte, served-identity, and
bill-reconciliation receipts without exposing the raw credential to candidate
code.

Served generation/model/account identity, usage, billing, and
zero-data-retention/retention evidence must also originate from the provider
and be cryptographically bound to that request. Local destination or counter
evidence cannot self-attest a remote provider claim; missing provider-origin
evidence keeps the cell red.

Negative controls attempt one extra destination, call, token, and byte in each
direction; any success or missing counter is red. A no-egress case must emit
zero destination, call, token, and byte events. The sandbox never receives a
general proxy credential or a route that can tunnel arbitrary traffic.

## Machine and human stage boundary

The machine stage planner derives the smallest complete path for the selected
cells. A production journey can include:

```text
admit → detect/profile → extract → structure → source/locale context
→ localize/QA → patch → re-extract/compare → launch
→ deterministic input/replay → frame/event/audio observation
```

Every selected stage records nonzero input/output/assertion counts, immutable
subjects, bounds, and typed outcome. Selected cells must equal planned,
executed, and reported cells. Replacing any leg with a fixture invalidates the
composed private receipt.

Machine execution stops after it produces and observes an immutable playable
patch. It cannot originate played review, human feedback, a successor-round
decision, or export authority. The candidate Studio/runtime used for review
stays in the same no-publication, controlled-egress boundary. For
`cell::review.refine-whole-round::all`,
`cell::review.compare-rounds::all`,
`cell::export.download-played-patch::decode.engine.reallive`, and
`cell::journey.localize-owned-release::decode.engine.reallive`:

1. a trusted companion outside the candidate tree issues a nonce-bound
   challenge and requires hardware/WebAuthn-style user presence from an
   authorized human;
2. the human opens the exact parent patch in Studio and plays it while an
   independently attested runtime/input observer binds patch, session, inputs,
   moments, and private notes to that challenge; every accepted review/play
   input originates over the independently installed companion's
   user-authenticated session channel and carries its challenge provenance
   through a candidate-noninjectable hardware input path, and unproven or
   candidate-injected input is red;
3. fresh user presence signs the first feedback batch and starts the first
   successor round; that successor imports the receipt and completes;
4. the human plays the first changed child under a fresh challenge, then fresh
   user presence signs a second feedback batch and starts the second successor;
5. after the second successor completes, the human plays the second changed
   child under another fresh challenge;
6. seeded successor failure leaves the last valid parent current and unrelated
   hashes unchanged; and
7. fresh user presence separately authorizes export of the second changed
   child, bound to that child's own play receipt rather than a parent or
   superseded receipt.

For managed use, the independently installed customer companion terminates an
end-to-end encrypted display/input channel bound to the exact device,
recipient, patch, and session. Full frames, audio, inputs, and notes never
terminate in operator browser code or a relay. Recording, clipboard, and
download are separately granted and receipted.

Stale, foreign, inaccessible, unplayed, machine-originated, or replayed human
receipts keep those cells red. Agents retain the inner per-unit loop; humans
never edit or decide individual units.

Production family qualification also requires the same mechanism on two
independently sourced lawful titles, exact field N/total with canonical gap
categories, positive and negative detection neighbors, byte-safe round trip,
isolated intended mutation, patch/re-extraction equivalence, causal runtime
change, bounded replay, and synthetic/real differential agreement.

## Private evidence and publication boundary

The source corpus remains in its immutable custody snapshot; the evidence
bundle does not duplicate it. The sidecar encrypts the minimum full-fidelity
derived artifacts needed to reproduce the conclusion: stage outputs, patch,
logs, traces, frames, audio, field reports, provider receipts, human receipts,
and private diagnostics. It binds them to the opaque snapshot reference and
retains them under the approved private policy. A customer-controlled key agent
releases an attestation-bound one-use evidence key to the authorized sidecar;
the operator cannot decrypt it. Rotation, revocation, retention expiry,
cryptographic deletion, recovery, and authorized auditor release are signed
custody operations. Public output contains only an opaque private-bundle
reference and a request-scoped commitment.

Candidate-authored stage counts, field reports, and semantic outcomes are
untrusted input. Disposable protected oracle workers with no key or network
authority recompute semantic assertions and every N/total, run every selected
private `kill::` mutation, and return narrow typed results that the sidecar
binds into the signed transcript.

Exact private counts, sizes, durations, costs, hashes, field ratios, and
resource use remain private. Private candidate runs publish only fixed
request-known IDs, one generic candidate-stage failure or pass, and a randomized
commitment. Pass/fail is the unavoidable declassified bit. Run-derived bands
and detailed candidate-stage failure classes are omitted. Publication uses
fixed/padded timing, preallocated opaque handles, a strict request limit per
reviewed tree/plan, and no automatic oracle retry. Candidate-selected numbers
and hashes are never copied into public output.

An attested declassifier inside the customer-controlled boundary applies the
typed allowlist and scans the complete prospective receipt, logs, diagnostics,
and metadata, then emits one narrow signed publication candidate. It can read
private material but has no public uploader token or channel. The external
publisher has the public credential but can read only that signed candidate,
never corpus, bundle, private logs, or the private filesystem.

Privileged components hash/encrypt candidate blobs as opaque bounded streams
and decode only strict canonical typed scalars with memory-safe code. Content
and leak scanners run in a disposable no-key/no-network sandbox. The final
signer and publisher consume only the protected verifier's narrow typed result,
never candidate media, archives, logs, or metadata.

Canaries in every forbidden class are defense in depth, not the primary proof;
the allowlist and independent private scan are mandatory. A leak candidate is
quarantined before publication and creates a private security record. Published
private content is never treated as safely recoverable by deletion.

Only a trusted, enumerated, content-free failure diagnostic may use
`always()`. Every required public receipt upload uses
`if-no-files-found: error`. No private evidence is ever placed in a GitHub
Actions artifact.

## Attestation and independent verification

The public test receipt is a
[DSSE v1 envelope](https://github.com/in-toto/attestation/blob/main/spec/v1/envelope.md)
with exact `payloadType: application/vnd.in-toto+json`, whose payload is an
[in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md).
Its predicate type is exactly the vetted
[`https://in-toto.io/attestation/test-result/v0.1`](https://github.com/in-toto/attestation/blob/main/spec/predicates/test-result.md):

- subjects are the source artifacts actually tested, including candidate
  tree/build and request-scoped custody commitment;
- `configuration` contains ResourceDescriptors for the signed plan, policy,
  sandbox image, toolchain, adapter manifest, and detailed receipt;
- `result` is `PASSED`;
- `passedTests` is exactly the selected cell-test set; and
- `warnedTests` and `failedTests` are empty.

Stage counts, bounds, field reports, two-title quorum, human authority,
provider accounting, and private-bundle binding live in a second DSSE-signed
Statement whose owned immutable predicate TypeURI is
`https://github.com/cat-cave/itotori/attestation/private-behavior-proof/v0.1`.
Its versioned schema is hash-pinned in both producer and verifier; no external
registration is required. Its private evidence binds the distinct
title-equivalence groups, acquisition/provenance records, and root inequality.
The standard receipt binds that envelope's digest as configuration.

A third DSSE-signed Statement uses
`https://github.com/cat-cave/itotori/attestation/private-proof-bundle-index/v0.1`;
its subjects are the two envelope digests and its typed predicate binds the
request and verification-transcript digests. The root bundle owns the schemas
and conformance tests in
`cell::evidence.publish-safe-runtime-proof::all`; an absent schema, unpinned
digest, or failed independent conformance check is red.

A hardware-backed key proves possession only. The signing key must be
ephemeral and bound by hardware-rooted measured-boot/workload attestation to
the authorized sidecar image, policy, request, and isolation state. The same
safe-runtime-publication cell owns the attestation mechanism, verifier roots,
rotation, revocation, and recovery contract. Until every predicate is
implemented and independently verified, private admission is red.

The external verifier requires all of:

- the broker's OIDC verification transcript;
- sidecar workload attestation and signature;
- exact DSSE, Statement, predicate, subject, configuration, and cell schemas;
- a trusted-broker timestamp plus append-only transparency-log receipt and
  inclusion proof;
- request freshness, nonce uniqueness, selected/executed equality, negative
  control results, role oracle, two-title quorum, and private-bundle
  resolvability; and
- a content-free verification transcript produced by verifier code outside the
  candidate tree.

GitHub artifact attestation may additionally bind a published receipt artifact,
but it is not a substitute for semantic receipt verification or the private
transparency record.

## Fail-closed outcomes

| Condition                                                                                              | Required result                                          |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| No eligible agent, broker outage, unhealthy agent, or request limit                                    | Required check red with a content-free enumerated reason |
| Missing/empty corpus, byte/hash mismatch, writable mount, snapshot drift, or nonindependent title pair | Red before candidate execution                           |
| Missing renderer/font/tool/secret policy, image drift, or bad workload attestation                     | Red before behavior execution                            |
| Skip, pending step, zero assertion, zero stage bytes, timeout, cancellation, or crash                  | Red; no receipt admitted                                 |
| Selected, planned, executed, and reported cell sets differ                                             | Red                                                      |
| Field zero lacks independent source-absence proof                                                      | Red with private canonical gap category                  |
| Extra provider destination/call/token/byte, bad identity, or bill mismatch                             | Red and private security record                          |
| Required human receipt is absent, stale, foreign, replayed, or machine-originated                      | Red                                                      |
| Prospective public output contains an unapproved field/value or canary                                 | Quarantine before publication; red                       |
| Bad/revoked signature, stale request, missing log inclusion, or wrong subject                          | Red                                                      |
| Private evidence cannot resolve from its opaque reference                                              | Red even if the public envelope otherwise verifies       |

## Queue, main, and release use

- Merge admission comes from a distinct external GitHub App and an App-bound
  required context; atomically add that expected App to protection while
  retaining the two Actions aggregates. A matching check name or candidate
  Actions job is insufficient.
- The external verifier admits the reviewed tree only after all required
  machine and human receipts exist.
- It grants one exclusive admission lease per private dependency cone. A second
  overlapping pull request stays red outside the queue until the first merges
  or leaves, then rebases and obtains fresh evidence; disjoint cones may group.
  Unexpected overlap in a merge group is red rather than repeatedly regrouped.
- The merge group resolves the union of linked cells and checks final
  tree/build/dependency-cone equivalence against those pre-issued receipts.
- Unaffected receipts are reusable only when every immutable subject and cone
  digest matches; the verifier explains that match.
- After squash, main verifies tree/build equivalence rather than requiring an
  impossible commit-SHA match, or requests fresh evidence.
- The quarantined workflows remain disabled. The replacement becomes release
  evidence only after two independently requested complete cycles produce
  resolvable private bundles, valid public attestations, and successful
  negative controls.

Absence is red, private truth stays full fidelity, and public CI admits only a
proof bound to the exact code, cells, evidence, human authority, and custody
policy it claims.
