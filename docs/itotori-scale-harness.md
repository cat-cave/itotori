# Itotori scale harness

The scale harness creates deterministic synthetic bridge input and measures the
database-backed import, indexing, planning, scheduling, and status paths. It
uses public template text, never a private corpus.

Run the CI-sized profile with:

```sh
just dev scale-smoke
```

The dispatcher starts and waits for its disposable Postgres service, builds the
TypeScript workspaces, then runs the harness. It requires the configured
Postgres host port to be available. The smoke run writes
`.tmp/itotori-scale-harness/smoke/summary.json` and prints its key result
fields. On this tree, the verified run reported `budgetPassed: true`,
`unitCount: 191`, `batchCount: 4`, and `scheduledJobCount: 4`.

`just dev scale-large` follows the same path with the large profile. Neither
profile is a correctness proof for a real corpus.

When available, a profile is a performance measurement, not a correctness
proof for a real corpus. Report the profile, input counts, operation timings,
and pass/fail budgets from its generated summary when making a scale claim.

For qd work, `just ci affected` owns the disposable database lifecycle. Do not
create per-worktree environment variables to choose database ports, compose
files, schema names, or corpus roots. Host deployment mounts and scratch roots
are the only environment inputs, and only when declared in the environment
registry. Developer and translator choices belong in application configuration.

Before changing the harness or its measured budgets, run the applicable public
checks and inspect the output summary. A pass says only that the measured
synthetic profile met its current thresholds; it cannot establish real-corpus
performance, browser rendering, or provider behavior.
