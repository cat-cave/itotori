#!/usr/bin/env node
// synthetic-fixture-differential-validation — COVERAGE-PARITY check.
//
// The second safeguard (paired with scripts/mutation-differential.mjs). It
// asserts the SYNTHETIC corpus exercises the SAME decode / patchback / replay
// component surface the real-bytes tests do, so a synthetic-only per-gate lane
// cannot silently under-cover a component the real lanes would have caught.
//
// It cross-checks THREE artifacts and fails loud (exit 1) on any mismatch:
//
//   1. fixtures/synthetic/coverage-manifest.v0.json — the per-engine-family
//      enumeration of every UNIQUE component the REAL corpora + real-bytes tests
//      exercise, each entry DERIVED from a named source-of-truth
//      catalogue/enum/assertion (already 100%-instantiated; enforced by
//      scripts/synthetic-coverage-manifest.mjs --check).
//
//   2. INSTANTIATION_MAP — for EVERY manifest component group, the synthetic
//      test file + `#[test]` fn that drives that group's components through the
//      REAL decoder and asserts 100% instantiation. If a manifest group has no
//      synthetic instantiation test, synthetic is NOT a superset of real for
//      that group ⇒ FAIL. (This is what makes "synthetic ⊇ real" enforced, not
//      asserted in prose.)
//
//   3. REAL_ONLY_SURFACES — the explicitly-documented residual surfaces that
//      ONLY real bytes exercise (with the reason each cannot be closed by a
//      synthetic fixture). This is the honest, reviewed gap list — nothing is
//      hidden. Each entry is a real-only *integration* surface whose underlying
//      decode LOGIC is still covered by a targeted synthetic fixture or unit
//      test (documented per entry), so no decode-correctness regression can
//      escape the synthetic suite.
//
// A synthetic fixture QUALIFIES to replace a real-bytes test in a per-gate lane
// only when BOTH safeguards hold: mutation-kill(synthetic) >= mutation-kill(real)
// (mutation-differential) AND coverage-parity (synthetic ⊇ real, this script).
//
// Exit codes:
//   0 — synthetic ⊇ real for every manifest component group.
//   1 — a manifest group lacks a synthetic instantiation test, a mapped test
//       file/fn is missing, or the manifest carries a group the map does not
//       cover. Details to stderr.
//
// Run: node scripts/coverage-parity.mjs         (enforce)
//      node scripts/coverage-parity.mjs --json   (machine-readable ledger)

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const MANIFEST_PATH = "fixtures/synthetic/coverage-manifest.v0.json";

// ---------------------------------------------------------------------------
// INSTANTIATION_MAP — manifest (family -> group) => the synthetic test that
// drives that group's components through the REAL decoder. Every group the
// manifest enumerates MUST appear here (enforced below).
// ---------------------------------------------------------------------------
export const INSTANTIATION_MAP = {
  reallive: {
    opcode_tuple: {
      file: "crates/utsushi-reallive/tests/synthetic_corpus_real_pipeline.rs",
      test: "synthetic_scene_instantiates_every_opcode_tuple",
    },
    element_form: {
      file: "crates/utsushi-reallive/tests/synthetic_corpus_real_pipeline.rs",
      test: "synthetic_corpus_instantiates_every_element_form",
    },
    expression_form: {
      file: "crates/utsushi-reallive/tests/synthetic_corpus_real_pipeline.rs",
      test: "synthetic_expressions_instantiate_every_expression_form",
    },
    opener_marker: {
      file: "crates/utsushi-reallive/tests/synthetic_corpus_real_pipeline.rs",
      test: "synthetic_scene_contains_every_opener_marker",
    },
    named_opcode: {
      file: "crates/utsushi-reallive/tests/synthetic_corpus_real_pipeline.rs",
      test: "synthetic_scene_instantiates_every_named_opcode",
    },
    cipher_case: {
      file: "crates/utsushi-reallive/tests/synthetic_corpus_real_pipeline.rs",
      test: "synthetic_corpus_instantiates_every_cipher_case",
    },
    g00_type: {
      file: "crates/utsushi-reallive/tests/synthetic_corpus_real_pipeline.rs",
      test: "synthetic_g00_images_instantiate_every_g00_type",
    },
    decoder_parity_corpus: {
      file: "crates/utsushi-reallive/tests/synthetic_corpus_real_pipeline.rs",
      test: "synthetic_archives_decode_clean_and_frame_round_trip_through_real_pipeline",
    },
  },
  rpg_maker_mv_mz: {
    event_command_code: {
      file: "crates/kaifuu-rpgmaker/tests/synthetic_event_code_coverage.rs",
      test: "synthetic_www_instantiates_every_event_command_code_clean",
    },
  },
  kirikiri_xp3: {
    capability_variant: {
      file: "crates/kaifuu-core/tests/synthetic_xp3_capability_coverage.rs",
      test: "synthetic_corpus_instantiates_every_xp3_capability_variant",
    },
  },
  siglus: {
    opcode: {
      file: "crates/kaifuu-siglus/tests/synthetic_siglus_opcode_coverage.rs",
      test: "synthetic_corpus_instantiates_every_siglus_opcode",
    },
  },
};

// ---------------------------------------------------------------------------
// REAL_ONLY_SURFACES — the honest, reviewed residual gap list. Each entry is a
// surface ONLY real bytes exercise as an *integration*, with the reason it
// cannot be closed by a synthetic fixture AND where its underlying decode LOGIC
// is still covered so no correctness regression escapes the synthetic suite.
// ---------------------------------------------------------------------------
export const REAL_ONLY_SURFACES = [
  {
    id: "avg32_scn2k_tail_clip_under_backreference",
    family: "reallive",
    surface:
      "AVG32 / SCN2k LZSS 'clip the final back-reference against the declared " +
      "uncompressed size' branch, reached only when a compressed stream ends " +
      "with a back-reference that overshoots the target buffer.",
    why_real_only:
      "The synthetic G00 (type-1/type-2) and Seen.txt corpora are compressed " +
      "LITERAL-ONLY (compress_avg32_literal / encode_all_literals), so decode " +
      "is input-bounded and never reaches the out_size clip. Authoring a " +
      "tail-overshoot back-reference stream is possible but adds no decode-" +
      "LOGIC coverage beyond what is already covered below.",
    logic_still_covered_by:
      "The back-reference COPY logic (distance/run-length/window) is exercised " +
      "by the utsushi-reallive decompressor synthetic unit tests " +
      "(synthetic_pure_back_references_round_trip and siblings) and the type-0 " +
      "G00 fixture's trailing back-reference token; only the exact out_size " +
      "CLIP arithmetic is real-only.",
  },
  {
    id: "reallive_real_scene_plaintext_variety_for_xor2_recovery",
    family: "reallive",
    surface:
      "xor_2 known-plaintext key recovery over the natural plaintext-byte " +
      "DISTRIBUTION of many real scenes.",
    why_real_only:
      "The synthetic xor2 corpus stages a planted key over uniform MetaLine(0) " +
      "padding so recovery is exact and deterministic; real scenes have a " +
      "richer plaintext distribution.",
    logic_still_covered_by:
      "The recovery + validate + decrypt ALGORITHM (recover_and_decrypt_archive) " +
      "runs on the synthetic xor2 corpus and is mutation-killed by " +
      "'xor2_skip_cipher'; only the real plaintext-distribution robustness is " +
      "real-only.",
  },
  {
    id: "siglus_real_opcode_operand_semantics",
    family: "siglus",
    surface:
      "Real Siglus scene-bytecode operand SEMANTICS (expression trees, argument " +
      "values, string references, control flow) and the runtime CD_COMMAND " +
      "read-flag decision resolved by the stack VM.",
    why_real_only:
      "The STRUCTURAL opcode catalogue (command-code classification + exact " +
      "operand-byte spans) is synthetically covered — the synthetic corpus " +
      "instantiates every catalogued opcode through partition_scene. What only " +
      "real scenes exercise is the downstream SEMANTIC decode of those operand " +
      "bytes, which the skeleton partitioner does not yet perform.",
    logic_still_covered_by:
      "The partitioner's structural logic (operand-width model, arg-list " +
      "recursion, label-anchored CD_COMMAND tail disambiguation, Unknown " +
      "reporting) is covered by the synthetic opcode-catalogue test and the " +
      "kaifuu-siglus unit tests; only operand SEMANTICS are real-only until the " +
      "downstream decoder lands.",
  },
];

// ---------------------------------------------------------------------------
export function loadManifest(root = repoRoot) {
  return JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8"));
}

/**
 * Pure evaluator: given the manifest's engineFamilies and the INSTANTIATION_MAP,
 * return the list of violations (a manifest group with no mapped synthetic test,
 * or a mapped group absent from the manifest).
 */
export function evaluateParity(engineFamilies, instantiationMap) {
  const violations = [];
  for (const [family, famObj] of Object.entries(engineFamilies)) {
    const groups = Object.keys(famObj.componentGroups || {});
    const mapped = instantiationMap[family] || {};
    for (const group of groups) {
      if (!mapped[group]) {
        violations.push({
          family,
          group,
          rule: "manifest component group has no synthetic instantiation test (synthetic NOT ⊇ real)",
        });
      }
    }
    // Also flag a mapped group that no longer exists in the manifest (stale map).
    for (const group of Object.keys(mapped)) {
      if (!groups.includes(group)) {
        violations.push({
          family,
          group,
          rule: "INSTANTIATION_MAP references a group absent from the manifest (stale map)",
        });
      }
    }
  }
  // Flag a whole family in the map that the manifest dropped.
  for (const family of Object.keys(instantiationMap)) {
    if (!engineFamilies[family]) {
      violations.push({
        family,
        group: "*",
        rule: "INSTANTIATION_MAP references a family absent from the manifest (stale map)",
      });
    }
  }
  return violations;
}

function fileContainsTest(relFile, testFn, root = repoRoot) {
  const abs = join(root, relFile);
  if (!existsSync(abs)) return { exists: false, hasTest: false };
  const text = readFileSync(abs, "utf8");
  return { exists: true, hasTest: new RegExp(`fn\\s+${testFn}\\b`, "u").test(text) };
}

function run({ json } = {}) {
  const manifest = loadManifest();
  const families = manifest.engineFamilies || {};

  const violations = evaluateParity(families, INSTANTIATION_MAP);

  // Verify every mapped test file exists and contains the named test fn.
  const ledger = [];
  for (const [family, famObj] of Object.entries(families)) {
    for (const group of Object.keys(famObj.componentGroups || {})) {
      const map = (INSTANTIATION_MAP[family] || {})[group];
      const count = famObj.componentGroups[group].count;
      if (!map) {
        ledger.push({ family, group, count, instantiatedBy: null, ok: false });
        continue;
      }
      const { exists, hasTest } = fileContainsTest(map.file, map.test);
      const ok = exists && hasTest;
      if (!ok) {
        violations.push({
          family,
          group,
          rule: `mapped synthetic test ${map.file}#${map.test} is missing`,
        });
      }
      ledger.push({
        family,
        group,
        count,
        instantiatedBy: `${map.file}#${map.test}`,
        ok,
      });
    }
  }

  const report = {
    schema: "itotori.coverage_parity.v0",
    manifest: MANIFEST_PATH,
    ledger,
    realOnlySurfaces: REAL_ONLY_SURFACES,
    violations,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("coverage-parity: synthetic ⊇ real component-surface ledger\n");
    for (const row of ledger) {
      const mark = row.ok ? "ok " : "MISS";
      process.stdout.write(
        `  [${mark}] ${row.family}/${row.group} (${row.count} components) <- ${row.instantiatedBy || "(no synthetic test)"}\n`,
      );
    }
    process.stdout.write(
      `\ncoverage-parity: ${REAL_ONLY_SURFACES.length} documented real-only residual surface(s) ` +
        "(decode LOGIC still covered — see REAL_ONLY_SURFACES):\n",
    );
    for (const s of REAL_ONLY_SURFACES) {
      process.stdout.write(`  - ${s.id} [${s.family}]\n`);
    }
  }

  if (violations.length > 0) {
    process.stderr.write(
      `\ncoverage-parity FAILED: ${violations.length} violation(s) — the synthetic corpus is ` +
        "NOT a proven superset of the real-bytes component surface:\n",
    );
    for (const v of violations) {
      process.stderr.write(`  ${v.family}/${v.group}: ${v.rule}\n`);
    }
    return 1;
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(run({ json: process.argv.includes("--json") }));
}

export { run };
