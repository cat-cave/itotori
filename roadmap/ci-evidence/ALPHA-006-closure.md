# ALPHA-006 closure — CI reuse evidence

ALPHA-006 ("first real-engine end-to-end alpha vertical", Oshioki Sweetie HD) is an
UMBRELLA node with no code of its own. Its acceptance is demonstrated by two merged,
CI-green, independently-audited constituent nodes on integrated main:

- **alpha-006d-full-chain-e2e** (commit 889237d0) — criteria 1-4: full chain e2e on real
  Sweetie HD bytes, Kaifuu+Utsushi only (no shell-outs), vault-source read-only, static
  xor2 (no dynamic-key helper), redacted feedback screenshot. Live ZDR agentic run
  (usd 0.00079, all zdr:true), byte-correct patch, localized line observed. Affected CI
  (check ci-itotori ci-kaifuu ci-utsushi ci-real-bytes localize-project-test) EXIT=0; audit PASS.
- **alpha-006f-outcome-classification** (commit 274a10d5) — criterion 5: the RealLive chain
  run report classifies in-profile-pass | in-profile-bug | out-of-profile-diagnostic on
  success AND failure; unknownOpcodes!=0 fails closed as in-profile-bug. Affected CI
  (check localize-project-test) EXIT=0; audit PASS; 41 tests.

ALPHA-006 reuses those constituent CI runs (no new code → no new CI). Closure assessment:
`.tmp/alpha-006-closure-assessment.json` (all 5 criteria verified `met`).
