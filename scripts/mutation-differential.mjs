#!/usr/bin/env node
// synthetic-fixture-differential-validation — MUTATION harness.
//
// The guardrail that makes single-mode synthetic CI strict-proof-compliant.
// It proves the SYNTHETIC test suite is AS STRONG AS the ~30-minute real-bytes
// lanes at CATCHING REGRESSIONS, so per-gate CI can run the fast, copyright-free
// synthetic fixtures instead of re-parsing whole real archives WITHOUT losing
// regression-detection power.
//
// HOW IT WORKS (source-level mutation runner — the faithful, strict-proof form):
//   For each realistic decoder/patchback/replay bug in MUTATIONS, the runner
//   applies a targeted one-line SOURCE PATCH to the decoder/patchback code,
//   recompiles, and runs the owning engine family's SYNTHETIC (default,
//   non-`#[ignore]`, no-real-bytes) test suite. The synthetic suite MUST turn
//   red (the mutation is "killed"). A mutation that the synthetic suite lets
//   pass ("escaped") is a coverage hole and FAILS this lane loud.
//
//   The mutations are NEVER applied to the LIVE in-tree source. The runner first
//   copies the workspace into a throwaway per-run SANDBOX (its own source tree +
//   its own isolated CARGO_TARGET_DIR) and mutates/recompiles ONLY inside that
//   sandbox, which is deleted when the run ends. The live `crates/**/src` is
//   therefore byte-identical before and after — never opened for write — so a
//   CONCURRENTLY-running per-gate lane (e.g. `just check`'s source-reading
//   self-test, or `cargo fmt/clippy`) can never observe a half-mutated source
//   file. This removes the earlier in-place-mutation concurrency race
//   (mutation-differential-source-mutation-concurrency-race) at the root: two
//   full-CI runs sharing a checkout no longer collide, because each run mutates
//   only its own disposable copy, never the shared tree.
//
// WHY 100% SYNTHETIC KILL ⇒ synthetic >= real: the mutation set is drawn from
//   the representative real-regression classes, each landing in a code path the
//   real-bytes lanes also exercise (see scripts/coverage-parity.mjs). If the
//   synthetic suite kills EVERY mutation, then trivially
//   `synthetic_kills (=N) >= real_kills (<=N)` — there is no mutation real could
//   catch that synthetic misses, because synthetic catches all of them. The
//   optional `--with-real` mode runs the real-bytes lane per mutation as
//   corroborating evidence (needs the staged corpora + env), but the proof does
//   not depend on it.
//
// Exit codes:
//   0 — every mutation killed by the synthetic suite (guardrail live)
//   1 — a mutation ESCAPED the synthetic suite (coverage hole), an invalid
//       (non-compiling) mutation, or a non-green baseline. Details to stderr.
//
// Run:
//   node scripts/mutation-differential.mjs            # synthetic kill matrix
//   node scripts/mutation-differential.mjs --list     # print the mutation set
//   node scripts/mutation-differential.mjs --json      # machine-readable report
//   node scripts/mutation-differential.mjs --with-real # + real-bytes corroboration
//   node scripts/mutation-differential.mjs --only header_wrong_offset,choice_drop_option
//
// The cargo driver is `cargo` by default; override with ITOTORI_MUTATION_CARGO
// (e.g. `direnv exec . cargo`) for a devshell that wraps the toolchain.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// ---------------------------------------------------------------------------
// The mutation set — representative real-regression classes.
//
// Each entry patches ONE line of REAL decoder/patchback code with a bug of the
// named class, and names the engine family whose SYNTHETIC suite must catch it.
// `find` must occur EXACTLY once in `file` (asserted); `replace` must compile
// cleanly (a compile error is an INVALID mutation, not a kill).
// ---------------------------------------------------------------------------
export const MUTATIONS = [
  {
    id: "header_wrong_offset",
    category: "wrong offset (off-by-one header/table read)",
    file: "crates/kaifuu-reallive/src/scene_header.rs",
    find: "let bytecode_uncompressed_size = read_u32_le(blob_bytes, 0x24);",
    replace: "let bytecode_uncompressed_size = read_u32_le(blob_bytes, 0x23);",
    guardCrates: ["kaifuu-reallive", "utsushi-reallive"],
    realFamily: "reallive",
  },
  {
    id: "opcode_byteswap",
    category: "swapped / mis-typed opcode",
    file: "crates/kaifuu-reallive/src/opcode.rs",
    find: "let opcode_u16 = u16::from_le_bytes([bytes[pos + 3], bytes[pos + 4]]);",
    replace: "let opcode_u16 = u16::from_le_bytes([bytes[pos + 4], bytes[pos + 3]]);",
    guardCrates: ["kaifuu-reallive", "utsushi-reallive"],
    realFamily: "reallive",
  },
  {
    id: "framing_off_by_one",
    category: "off-by-one framing (arg_count / overload / header width)",
    file: "crates/kaifuu-reallive/src/opcode.rs",
    find: "let mut consumed = COMMAND_HEADER_LEN;",
    replace: "let mut consumed = COMMAND_HEADER_LEN + 1;",
    guardCrates: ["kaifuu-reallive", "utsushi-reallive"],
    realFamily: "reallive",
  },
  {
    id: "xor2_skip_cipher",
    category: "skipped / incorrect cipher (xor_2)",
    file: "crates/kaifuu-reallive/src/xor2.rs",
    find: "*slot ^= key[i % XOR2_KEY_LEN];",
    // Semantic no-op: still reads the key byte (no unused warning) but XORs
    // with 0 — i.e. the xor_2 second-level segment transform is skipped.
    replace: "*slot ^= key[i % XOR2_KEY_LEN] & 0;",
    guardCrates: ["kaifuu-reallive", "utsushi-reallive"],
    realFamily: "reallive",
  },
  {
    id: "avg32_broken_backref",
    category: "broken AVG32 decompress step (LZSS back-reference run length)",
    file: "crates/utsushi-reallive/src/decompressor.rs",
    find: "let run_length = ((count & 0x0f) as usize) + AVG32_LZSS_MIN_RUN;",
    replace: "let run_length = ((count & 0x0f) as usize) + AVG32_LZSS_MIN_RUN + 1;",
    guardCrates: ["utsushi-reallive"],
    realFamily: "reallive",
  },
  {
    id: "patchback_no_rebase",
    category: "patchback jump-recalc error (goto target not re-based)",
    file: "crates/kaifuu-reallive/src/patchback/bundle_driven.rs",
    // Neuter the cumulative re-base delta: goto targets after a length-changing
    // splice are left at their stale pre-splice offset.
    find: "cumulative_delta += delta;",
    replace: "cumulative_delta += delta * 0;",
    guardCrates: ["kaifuu-reallive"],
    realFamily: "reallive",
  },
  {
    id: "choice_drop_option",
    category: "dropped choice option",
    file: "crates/kaifuu-reallive/src/opcode.rs",
    // Only ever keep the FIRST select-block option; every later option is
    // silently dropped from the decoded Choice.
    find: "if !text.is_empty() {",
    replace: "if !text.is_empty() && choices.len() < 1 {",
    guardCrates: ["kaifuu-reallive", "utsushi-reallive"],
    realFamily: "reallive",
  },
  {
    id: "assignop_plain_eq_to_shr",
    category: "swapped assignment operator (AssignOp table: plain `=` mis-decoded)",
    file: "crates/utsushi-reallive/src/expression.rs",
    // The exact historical bug: pin op 0x1E (plain `=`) back to `>>=`, so
    // every `intX[Y] = <expr>` silently executes as `intX[Y] >>= <expr>`.
    // The synthetic `synth_42_plain_assign_into_intb` fixture (intB[0] = 7)
    // then evaluates to `0 >> 7 = 0` and the assertion turns red — the
    // guardrail that catches an AssignOp-table regression WITHOUT real bytes.
    find: "            0x1E => Self::Plain,",
    replace: "            0x1E => Self::ShrAssign,",
    guardCrates: ["utsushi-reallive"],
    realFamily: "reallive",
  },
  {
    id: "g00_paletted_reorder",
    category: "broken decode step (type-1 paletted-LZSS G00 palette B/R reorder)",
    file: "crates/utsushi-reallive/src/g00.rs",
    // Skip the on-disk B,G,R,A -> R,G,B,A palette reorder (emit B,G,R,A
    // verbatim). Formerly a real-only path (no synthetic paletted fixture) —
    // now killed by the synthetic type-1 G00 fixture + first-pixel assertion
    // that `synthetic-fixture-differential-validation` added.
    find:
      "                (\n" +
      "                    decoded[off + 2],\n" +
      "                    decoded[off + 1],\n" +
      "                    decoded[off],\n" +
      "                    decoded[off + 3],\n" +
      "                )",
    replace:
      "                (\n" +
      "                    decoded[off],\n" +
      "                    decoded[off + 1],\n" +
      "                    decoded[off + 2],\n" +
      "                    decoded[off + 3],\n" +
      "                )",
    guardCrates: ["utsushi-reallive"],
    realFamily: "reallive",
  },
  {
    id: "rpgmaker_misclassify_dialogue",
    category: "swapped / mis-typed opcode (cross-family: RPG Maker event code)",
    file: "crates/kaifuu-rpgmaker/src/codes.rs",
    find: "401 => CodeClass::Text(TextRole::DialogueLine),",
    replace: "401 => CodeClass::Unknown,",
    guardCrates: ["kaifuu-rpgmaker"],
    realFamily: "rpg_maker_mv_mz",
  },
];

// Real-bytes guard invocations (only used with --with-real). Each family runs
// its `#[ignore]`-gated real-bytes suite against the staged corpora named in the
// justfile `ci-real-bytes` recipe.
export const REAL_GUARDS = {
  reallive: {
    crates: ["kaifuu-reallive", "utsushi-reallive"],
    ignored: true,
  },
  rpg_maker_mv_mz: {
    crates: ["kaifuu-rpgmaker"],
    ignored: true,
  },
};

// ---------------------------------------------------------------------------
// Pure helpers (exercised directly by scripts/mutation-differential.test.mjs).
// ---------------------------------------------------------------------------

/**
 * Apply one mutation's `find -> replace` to `source`, asserting the `find`
 * token occurs EXACTLY once (so a mutation can never silently no-op or hit an
 * unintended second site).
 */
export function applyMutation(source, mutation) {
  const parts = source.split(mutation.find);
  const occurrences = parts.length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `mutation '${mutation.id}': expected exactly 1 occurrence of find token in ` +
        `${mutation.file}, found ${occurrences}`,
    );
  }
  return parts.join(mutation.replace);
}

/**
 * Classify a cargo run into `killed` (synthetic suite went red on a real test
 * assertion — GOOD), `escaped` (suite stayed green despite the mutation — a
 * coverage hole), or `compile_error` (the mutation did not compile — INVALID,
 * not a legitimate kill).
 */
export function classifyOutcome({ status, output }) {
  // Only treat *rustc* failures as INVALID mutations. Do not match broad
  // phrases like `error: expected` — cargo/libtest panic output can include
  // those substrings when a mutant *compiles* but assertions fail (a kill).
  const compileError =
    /error\[E\d{2,4}\]/u.test(output) ||
    /error: could not compile/u.test(output) ||
    /error: linking with/u.test(output) ||
    /error: aborting due to/u.test(output);
  if (compileError) return "compile_error";
  if (status === 0) return "escaped";
  return "killed";
}

// ---------------------------------------------------------------------------
// cargo driver.
// ---------------------------------------------------------------------------
function cargoBin() {
  return process.env.ITOTORI_MUTATION_CARGO || "cargo";
}

function runCargoTest({ crates, ignored, cwd, env }) {
  const pflags = crates.map((c) => `-p ${c}`).join(" ");
  const ignoredFlag = ignored ? " -- --ignored" : "";
  const cmd = `${cargoBin()} test ${pflags} --quiet${ignoredFlag}`;
  const started = Date.now();
  const res = spawnSync(cmd, {
    shell: true,
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  const output = `${res.stdout || ""}${res.stderr || ""}`;
  return { status: res.status, output, elapsedMs: Date.now() - started, cmd };
}

// ---------------------------------------------------------------------------
// Disposable per-run sandbox.
//
// The mutation runner NEVER writes to the live in-tree source. It copies the
// workspace into a throwaway directory (excluding heavy/irrelevant build caches)
// with its OWN isolated CARGO_TARGET_DIR, mutates + recompiles only there, then
// deletes the whole sandbox. Because the copy is unique per run (mkdtemp), two
// concurrent full-CI runs sharing a checkout never collide, and no concurrent
// lane can ever read a source file this runner has mid-mutated.
// ---------------------------------------------------------------------------
const SANDBOX_SKIP_DIRS = new Set([
  ".git",
  "target",
  "node_modules",
  ".tmp",
  ".corepack",
  ".direnv",
]);

function sandboxBaseDir() {
  if (process.env.ITOTORI_MUTATION_SANDBOX_DIR) return process.env.ITOTORI_MUTATION_SANDBOX_DIR;
  // Prefer the fast scratch RAID0 the devshell already uses for build artifacts.
  if (existsSync("/scratch/cache/itotori")) return "/scratch/cache/itotori/mutdiff";
  return join(tmpdir(), "itotori-mutdiff");
}

function prepareSandbox() {
  const base = sandboxBaseDir();
  mkdirSync(base, { recursive: true });
  const sandboxRoot = mkdtempSync(join(base, `run-${process.pid}-`));
  const srcRoot = join(sandboxRoot, "src");
  const targetDir = join(sandboxRoot, "target");

  cpSync(repoRoot, srcRoot, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const rel = relative(repoRoot, src);
      if (rel === "") return true;
      return !rel.split(sep).some((segment) => SANDBOX_SKIP_DIRS.has(segment));
    },
  });

  // Isolated target dir so the sandbox cold-builds into its own space and never
  // fights (or invalidates) the live worktree's CARGO_TARGET_DIR. Disable
  // incremental compilation so a restored source file after a prior mutation
  // cannot re-use a stale mutant artifact and produce false compile_errors.
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
    CARGO_INCREMENTAL: "0",
  };
  return {
    root: srcRoot,
    env,
    cleanup: () => rmSync(sandboxRoot, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------
function guardSignature(crates) {
  return crates.slice().sort().join(",");
}

function runOne(mutation, { withReal, sandbox }) {
  // Mutate ONLY the sandbox copy — never the live in-tree source.
  const absPath = join(sandbox.root, mutation.file);
  const original = readFileSync(absPath, "utf8");
  const result = {
    id: mutation.id,
    category: mutation.category,
    file: mutation.file,
    outcome: undefined,
    syntheticElapsedMs: 0,
    realOutcome: undefined,
    realElapsedMs: 0,
  };
  try {
    const mutated = applyMutation(original, mutation);
    writeFileSync(absPath, mutated);

    const synth = runCargoTest({
      crates: mutation.guardCrates,
      ignored: false,
      cwd: sandbox.root,
      env: sandbox.env,
    });
    result.outcome = classifyOutcome({ status: synth.status, output: synth.output });
    result.syntheticElapsedMs = synth.elapsedMs;
    result.syntheticStatus = synth.status;

    if (withReal && result.outcome !== "compile_error") {
      const guard = REAL_GUARDS[mutation.realFamily];
      if (guard) {
        const real = runCargoTest({
          crates: guard.crates,
          ignored: guard.ignored,
          cwd: sandbox.root,
          env: sandbox.env,
        });
        result.realOutcome = classifyOutcome({ status: real.status, output: real.output });
        result.realElapsedMs = real.elapsedMs;
      }
    }
  } finally {
    // Restore the sandbox copy's pristine bytes so the NEXT mutation targeting
    // the same file applies cleanly, then verify byte-identity (within the
    // sandbox — the live tree is never touched at all).
    writeFileSync(absPath, original);
    const restored = readFileSync(absPath, "utf8");
    if (restored !== original) {
      throw new Error(
        `failed to restore sandbox copy of ${mutation.file} to its pristine bytes after mutation`,
      );
    }
  }
  return result;
}

function parseArgs(argv) {
  const opts = { list: false, json: false, withReal: false, only: null };
  for (const a of argv) {
    if (a === "--list") opts.list = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--with-real") opts.withReal = true;
    else if (a.startsWith("--only=")) opts.only = a.slice("--only=".length).split(",");
    else if (a === "--only") opts.only = "NEXT";
    else if (opts.only === "NEXT") opts.only = a.split(",");
  }
  return opts;
}

function selectMutations(only) {
  if (!only) return MUTATIONS;
  const set = new Set(only);
  const picked = MUTATIONS.filter((m) => set.has(m.id));
  const unknown = [...set].filter((id) => !MUTATIONS.some((m) => m.id === id));
  if (unknown.length) throw new Error(`unknown mutation id(s): ${unknown.join(", ")}`);
  return picked;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.list) {
    for (const m of MUTATIONS) {
      process.stdout.write(`${m.id}\n    ${m.category}\n    ${m.file}\n`);
    }
    return 0;
  }

  const mutations = selectMutations(opts.only);

  // Stage a throwaway per-run sandbox copy of the workspace up front; ALL cargo
  // work (baselines + mutations) runs there so the live tree is never mutated.
  const sandbox = prepareSandbox();
  if (!opts.json) {
    process.stderr.write(`sandbox   ${sandbox.root}  (isolated CARGO_TARGET_DIR)\n`);
  }

  let results;
  try {
    // Baseline: every distinct synthetic guard must be GREEN before we mutate, so
    // a red run can only mean the mutation (not a pre-existing failure).
    const uniqueGuards = new Map();
    for (const m of mutations) uniqueGuards.set(guardSignature(m.guardCrates), m.guardCrates);
    for (const [sig, crates] of uniqueGuards) {
      const base = runCargoTest({ crates, ignored: false, cwd: sandbox.root, env: sandbox.env });
      const green = base.status === 0;
      if (!opts.json) {
        process.stderr.write(
          `baseline  ${sig.padEnd(38)} ${green ? "GREEN" : "RED"}  (${base.elapsedMs}ms)\n`,
        );
      }
      if (!green) {
        process.stderr.write(
          `mutation-differential: baseline synthetic suite for [${sig}] is not green; ` +
            "cannot attribute a red run to a mutation.\n" +
            base.output.split("\n").slice(-25).join("\n") +
            "\n",
        );
        return 1;
      }
    }

    results = [];
    for (const m of mutations) {
      const r = runOne(m, { withReal: opts.withReal, sandbox });
      results.push(r);
      if (!opts.json) {
        const tag =
          r.outcome === "killed" ? "KILLED " : r.outcome === "escaped" ? "ESCAPED" : "INVALID";
        const realTag = r.realOutcome ? `  real=${r.realOutcome}` : "";
        process.stderr.write(
          `mutation  ${m.id.padEnd(30)} ${tag} by synthetic (${r.syntheticElapsedMs}ms)${realTag}\n`,
        );
      }
    }
  } finally {
    sandbox.cleanup();
  }

  const killed = results.filter((r) => r.outcome === "killed").length;
  const escaped = results.filter((r) => r.outcome === "escaped");
  const invalid = results.filter((r) => r.outcome === "compile_error");
  const killRate = results.length ? killed / results.length : 1;

  const report = {
    schema: "itotori.mutation_differential.v0",
    total: results.length,
    killed,
    escaped: escaped.map((r) => r.id),
    invalid: invalid.map((r) => r.id),
    killRatePct: Math.round(killRate * 1000) / 10,
    withReal: opts.withReal,
    results,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }

  const ok = escaped.length === 0 && invalid.length === 0;
  if (!ok) {
    if (escaped.length) {
      process.stderr.write(
        `\nmutation-differential FAILED: ${escaped.length} mutation(s) ESCAPED the synthetic ` +
          "suite — the synthetic fixtures are NOT as strong as the real-bytes lanes for these " +
          "regressions:\n",
      );
      for (const r of escaped) process.stderr.write(`  - ${r.id}  (${r.category})\n`);
    }
    if (invalid.length) {
      process.stderr.write(
        `\nmutation-differential FAILED: ${invalid.length} INVALID (non-compiling) mutation(s); ` +
          "fix the mutation definition:\n",
      );
      for (const r of invalid) process.stderr.write(`  - ${r.id}\n`);
    }
    return 1;
  }

  if (!opts.json) {
    process.stderr.write(
      `\nmutation-differential PASSED: ${killed}/${results.length} mutations killed by the ` +
        `synthetic suite (kill rate ${report.killRatePct}%). ` +
        "Synthetic kill set >= real-bytes kill set (see scripts/coverage-parity.mjs).\n",
    );
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(main());
}
