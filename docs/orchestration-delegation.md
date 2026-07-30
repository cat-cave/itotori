# Orchestrator Delegate Reference

## Choose and isolate workers

Use one worktree per worker and give workers disjoint files. Mechanical docs
and tooling work can use a shell agent. Byte-sensitive, gate, or
runtime-semantics work needs a high-fidelity worker and an independent audit.
The audit model must differ from the implementation model.

On worker exit, inspect its worktree and pull request state; a reaped worker can
leave useful uncommitted work behind.

Before asking a worker to finish, state the formatting requirement explicitly:

```sh
pnpm exec vp check --fix
pnpm exec vp check
```

Run the second command yourself during intake. Formatting errors are not a
flake and will fail the TypeScript tier.

## Shell-agent contract

Put the full brief in a durable file. Pass only a short instruction that points
to that file; never send the full prompt over stdin. Run one agent in one
worktree and use a soft watchdog for a background process. Never hard-kill a
slow worker solely because it is slow.

Examples:

```sh
BRIEF=/tmp/brief-<task>.md

grok --prompt-file "$BRIEF" --always-approve --output-format plain \
  --cwd /scratch/worktrees/itotori-<slug>

cd /scratch/worktrees/itotori-<slug>
opencode run --auto -m zai-coding-plan/glm-5.2 \
  "Read the instructions at $BRIEF and follow them completely."

codex exec "Read the instructions at $BRIEF and follow them completely." < /dev/null
```

The `/dev/null` redirect is required for the last command: otherwise it waits
for stdin. If it must be stopped, locate its PID with `pgrep -f '^codex exec'`
and signal that PID; do not use a broad pattern kill.

## Operating reminders

- Worktrees live outside the repository and use their own build artifacts.
- Update local `main` to `origin/main` before creating or auditing a branch.
- Keep real-byte proof work deliberate: the full oracle is long-running and
  should not be launched as a casual inline worker step.
- Never commit private corpora, environment files, keys, or private render
  output.
- If a result claims scale, density, or fidelity, request the measurement or
  screenshot that establishes the claim.
