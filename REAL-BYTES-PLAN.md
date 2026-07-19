# REAL-BYTES-PLAN — Studio patchback trigger

This worktree wires a real Studio mutation that drives the **same**
`applyRealLivePatch` seam the CLI uses (`kaifuu-cli patch --engine reallive`).
CI proves the seam argv + archive retrieval with a fake spawn; it does **not**
claim a retail-game byte proof.

## Env-gated validation (orchestrator)

When a RealLive install is available:

```sh
export ITOTORI_REAL_GAME_ROOT=/path/to/real-reallive-install
# Optional: a pre-built translated v0.2 bridge. If omitted, the operator may
# first run the existing env-gated extract + localize path to produce one.
export ITOTORI_REAL_TRANSLATED_BUNDLE=/path/to/translated-bridge.json

# 1) Unit-level real apply (existing suite)
pnpm exec vitest run apps/itotori/test/patchback-real-bytes.test.ts

# 2) Studio runner against real kaifuu (no injected runApply)
#    Expected: non-zero unit count not required; exit 0 with a retained
#    patchBuildId, artifactHashes.seenTxt = sha256:…, and a tar that contains
#    REALLIVEDATA/Seen.txt whose bytes differ from the source for scoped scenes.
node --input-type=module <<'EOF'
import { createStudioPatchbackRunner } from './apps/itotori/src/patchback/studio-patchback-runner.ts';
import { existsSync } from 'node:fs';

const gameRoot = process.env.ITOTORI_REAL_GAME_ROOT;
const bundle = process.env.ITOTORI_REAL_TRANSLATED_BUNDLE;
if (!gameRoot || !existsSync(gameRoot)) {
  console.error('SKIP: ITOTORI_REAL_GAME_ROOT not staged');
  process.exit(0);
}
if (!bundle || !existsSync(bundle)) {
  console.error('SKIP: ITOTORI_REAL_TRANSLATED_BUNDLE not staged');
  process.exit(0);
}
const runner = createStudioPatchbackRunner(); // real kaifuu-cli
const outcome = await runner.runPatchback({
  gameRoot,
  translatedBundlePath: bundle,
  scope: 'dialogue+choices',
  force: true,
});
const archive = await runner.loadArchive(outcome.patchBuildId);
if (archive === null) throw new Error('archive missing');
console.log(JSON.stringify({
  patchBuildId: outcome.patchBuildId,
  command: outcome.command,
  artifactHashes: outcome.artifactHashes,
  archiveBytes: archive.bytes.byteLength,
  archiveFileName: archive.fileName,
}, null, 2));
if (!outcome.command.includes('reallive')) throw new Error('command missing reallive');
if (!archive.bytes.includes(Buffer.from('REALLIVEDATA/Seen.txt'))) {
  throw new Error('archive missing Seen.txt entry');
}
console.log('PASS: studio patchback real-bytes apply + archive');
EOF
```

### Expected result

| Check                            | Expected                                                             |
| -------------------------------- | -------------------------------------------------------------------- |
| `kaifuu-cli patch` exit          | `0`                                                                  |
| `outcome.command`                | contains `patch --engine reallive`                                   |
| `outcome.artifactHashes.seenTxt` | `sha256:<64 hex>`                                                    |
| `loadArchive`                    | non-null `application/x-tar`                                         |
| tar entry                        | includes `REALLIVEDATA/Seen.txt`                                     |
| SPA download URL                 | `/api/projects/patchback/<patchBuildId>/archive` serves the same tar |

### Not run in this worktree

No `ITOTORI_REAL_GAME_ROOT` was staged here. The synthetic suite in
`apps/itotori/test/studio-patchback.test.ts` proves real-seam argv + tar
retrieval only.

## Engine capability / parity

No capability-matrix row change: RealLive patch-apply was already evidenced.
This slice only exposes the **existing** reallive apply seam through the Studio
HTTP/UI surface (parity gate: same `realLivePatchArgs` / `applyRealLivePatch`
path as the CLI — no second apply implementation).
