# Softpal real-bytes validation plan (orchestrator merge gate)

This worktree wires Softpal through the **real** `apps/itotori` extract seam and
registers Softpal on the engine-capability matrix. Unit tests prove the app
dispatches `--engine softpal` through that seam. They do **not** replace
multi-game real-bytes proof.

**You (orchestrator) own the real-bytes + parity merge gate.** Do not treat
unit green alone as acceptance.

## Preconditions

1. `p3-wire-kaifuu-softpal-into-kaifuu-cli-extract-patch-verify-dis` is landed so
   `kaifuu-cli extract --engine softpal` is a real production arm (not
   identify-only detector failure).
2. Owned Softpal research tree is available read-only, e.g.:
   - `ITOTORI_SOFTPAL_RESEARCH_ROOT=/scratch/softpal-research`
   - Titles used by substrate proofs: `v21465` (Kizuna) and `v60663`
     (Dimension-Totsu-Lovers). Resolve the install root that contains
     `data.pac` and/or `dll/Pal.dll` under each title.
3. Worktree setup: `direnv exec . just worktree-setup` (once per worktree).
4. Native CLI resolvable via normal path (`ITOTORI_KAIFUU_BIN`, libexec, or
   `cargo run -p kaifuu-cli` fallback).

## Command 1 — native Softpal extract (kaifuu-cli production path)

Pick one title game root (`$SOFTPAL_GAME_ROOT`) that detection classifies as
`engine_family=softpal`. Then:

```sh
direnv exec . bash -lc '
  set -euo pipefail
  OUT="$(mktemp -d /tmp/softpal-extract-XXXXXX)"
  GAME_ROOT="${SOFTPAL_GAME_ROOT:?set SOFTPAL_GAME_ROOT to an owned Softpal install}"
  # Prefer a built/installed binary when present; cargo fallback is fine in dev.
  KAIFUU_BIN="${ITOTORI_KAIFUU_BIN:-}"
  if [[ -z "${KAIFUU_BIN}" ]]; then
    run() { cargo run -q -p kaifuu-cli -- "$@"; }
  else
    run() { "${KAIFUU_BIN}" "$@"; }
  fi
  run extract \
    --engine softpal \
    --game-root "${GAME_ROOT}" \
    --game-id softpal-real \
    --game-version 1.0 \
    --source-profile-id softpal-real \
    --source-locale ja-JP \
    --bundle-output "${OUT}/bridge.json"
  test -s "${OUT}/bridge.json"
  python3 - "${OUT}/bridge.json" <<'PY'
import json, sys
from pathlib import Path
bundle = json.loads(Path(sys.argv[1]).read_text())
assert bundle.get("schemaVersion") == "0.2.0", bundle.get("schemaVersion")
units = bundle.get("units") or []
assert len(units) > 0, "expected dialogue/choice units from Softpal SCRIPT.SRC+TEXT.DAT"
assets = bundle.get("assets") or []
print(f"OK softpal kaifuu-cli extract: units={len(units)} assets={len(assets)}")
PY
  echo "bundle=${OUT}/bridge.json"
'
```

### Expected shape

- Exit status **0**.
- `${OUT}/bridge.json` is a non-empty v0.2 BridgeBundle:
  - `schemaVersion === "0.2.0"`
  - `units.length > 0` (dialogue and/or choices resolved from TEXT.DAT)
  - identity metadata matches the flags above
- No retail/protected dialogue is committed; the path is operator-local only.

## Command 2 — app production path (itotori extract seam)

Same game root; proves the **app** reaches Softpal through the wired seam
(not a mock):

```sh
direnv exec . bash -lc '
  set -euo pipefail
  OUT="$(mktemp -d /tmp/softpal-itotori-extract-XXXXXX)"
  GAME_ROOT="${SOFTPAL_GAME_ROOT:?set SOFTPAL_GAME_ROOT to an owned Softpal install}"
  pnpm exec itotori extract \
    --engine softpal \
    --game-root "${GAME_ROOT}" \
    --game-id softpal-real \
    --game-version 1.0 \
    --source-profile-id softpal-real \
    --source-locale ja-JP \
    --bundle-output "${OUT}/bridge.json"
  # stdout is a small JSON summary (engine/mode/status); bridge is on disk.
  test -s "${OUT}/bridge.json"
  python3 - "${OUT}/bridge.json" <<'PY'
import json, sys
from pathlib import Path
bundle = json.loads(Path(sys.argv[1]).read_text())
assert bundle.get("schemaVersion") == "0.2.0"
assert len(bundle.get("units") or []) > 0
print("OK itotori extract --engine softpal")
PY
'
```

### Expected shape

- Process exit **0**.
- CLI summary JSON includes `"engine": "softpal"` and `"mode": "whole-game"`.
- Bridge file matches Command 1 expectations (v0.2, non-empty units).

If `pnpm exec itotori` is not on PATH in the environment, use the package
binary entry the repo documents for local CLI (same argv after the binary).

## Command 3 — multi-game law (≥2 Softpal titles)

Repeat Command 1 (or 2) for **both**:

| Title id | Research tree segment                   | Notes                                |
| -------- | --------------------------------------- | ------------------------------------ |
| v21465   | `$ITOTORI_SOFTPAL_RESEARCH_ROOT/v21465` | pal-dll / SCRIPT.SRC+TEXT.DAT        |
| v60663   | `$ITOTORI_SOFTPAL_RESEARCH_ROOT/v60663` | pac-script variant; decoupled SELECT |

Both must produce green v0.2 bridges with `units.length > 0`. Failure on either
title is a merge blocker (multi-game-validation law).

## Command 4 — engine-capability parity gate

```sh
direnv exec . bash -lc '
  set -euo pipefail
  node scripts/generate-engine-capability-matrix.mjs --check
  node --test scripts/generate-engine-capability-matrix.test.mjs
'
```

### Expected shape

- `--check` exits **0** (committed matrix matches generator; Softpal row present).
- Matrix contains row `softpal-pac-detector-readiness` with
  `engineFamily: "softpal"`, `adapterId: "kaifuu.softpal"`.
- Softpal is not absent/silent: identify is claimed; extract/patch stay honest
  to the detector claimed-support tuples until a positive extract adapter claim
  is evidenced.

## What this PR already proves (unit / wiring)

- `buildExtractArgs({ engine: "softpal", ... })` emits
  `extract --engine softpal ...` with **no** RealLive `--scene` / `--whole-seen`.
- `runKaifuuExtract` + Studio decode runner + CLI handler all share that argv
  construction (real seam, inject `runProcess` only for CI spawn avoidance).
- Softpal is registered on the generated engine-capability matrix like RealLive.

## What this PR deliberately does not claim

- Successful Softpal extract on real PAC/SCRIPT.SRC/TEXT.DAT bytes (orchestrator).
- Softpal as a positive extract/patch matrix adapter (still readiness/identify
  until claimed-support evidence is upgraded after CLI bridge production is
  proven on ≥2 titles).
- Utsushi Softpal EnginePort parity (separate DAG node:
  `p3-utsushi-softpal-engineport-crate-scene-dispatch-execution-re`).
