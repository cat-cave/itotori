# Path to legitimately using itotori to localize a game (as a normal user)

Status: **plan** (grounds the handoff from core-spine development → real usage). Companion to
`docs/design/localization-engine-overhaul.md` (the spine that makes the core legitimate).

## Goal

A parallel **user-agent** localizes a real RealLive game (Sweetie HD) using **only the real itotori
CLI + dashboard**, as a normal user: import/decode → run → **play the patched game** → validate →
submit feedback → **iterate** patch versions. When it hits bugs, it triages, fixes, and files
issues/PRs that **grow the project** (decode coverage, engine fidelity, breadth, UX) — **without
becoming core development of the tool itself**. At scale, bugs are expected — but only **practical**
ones (a specific opcode, a Gameexe quirk, a render detail, a UI rough edge), never **systemic**
(mocked core, fabricated coverage, handlerless workers — the cosplay the spine purges).

## Why this is gated on the spine

The localizer was paused because the core was cosplay. The spine
(`localization-engine-overhaul`) makes it legitimate; two late nodes ARE the user loop:

- **Node 11 (iteration)** — acceptance is _one run → complete playable patch v1 → play-test feedback
  → refinement run → patch v2, on a real game_, plus the dashboard Play / feedback / QA-callout
  surfaces. This IS the normal-user loop.
- **Nodes 9 (wiki), 10 (result editor)** — the browse/edit/feedback surfaces the play-tester uses.
- **Node 12 (capstone)** — deletes the last reviewer-queue cosplay.

The user-agent cannot legitimately exist until the spine (esp. 11) lands, or it would hit the
systemic problems it must avoid.

## The four gates

### Gate 1 — Finish the spine (in flight)

Nodes 9, 10, 11, 12. Makes the core legitimate + builds the play/feedback/wiki/iteration surfaces.
Status at time of writing: 8/12 landed; 9 + 10 in flight.

### Gate 2 — North-Star on REAL bytes via the real CLI (the readiness gate)

Node 11's synthetic e2e is not sufficient here. A **real-bytes oracle run**:
`itotori localize-game <sweetie-hd>` end-to-end → a genuine playable RealLive patch, using the new
legitimate loop + a live LLM + the byte substrate (kaifuu decode/extract → context/draft/QA →
patchback). Runs on the periodic real-bytes lane, not per-node CI. This answers "does the honest
core actually drive a real game."

### Gate 3 — Play / validation surface on the real game

The dashboard **"Play this patch"** drives **utsushi-reallive** rendering of the patched Sweetie HD
(frames/screenshots with the redaction toggle), the play-tester submits feedback, and a refinement
run consumes it → patch v2. The FE/BE play loop on real bytes, with **no dead surface in the chain**
(the interface-is-the-audit principle).

### Gate 4 — Launch the user-agent (resume the campaign, re-grounded)

A parallel agent operating **only through the CLI + dashboard**, running the full loop and iterating.

## Who drives what

- **The bridge node (Gate 2+3) is driven by a CLAUDE subagent** (≤1 concurrent, Claude-native) — it
  touches real bytes and its job is to VALIDATE that everything is legitimate. This is the one place
  we do not delegate to codex/grok: the legitimacy verdict must come from the trusted model on real
  bytes. (Byte-touching + legitimacy-critical → Claude-native.)
- Spine nodes: codex implements + luna audits (as done).
- The user-agent (Gate 4) and later engine-breadth campaigns: a parallel driver using the CLI +
  dashboard, escalating only systemic issues to core dev.

## Post-bridge roadmap (drive the DAG forward, in order)

Once the bridge node is green (Sweetie HD legitimately localizes end-to-end on real bytes):

1. **Polish — quality-of-life + proper use of the itotori CLIs as a REAL user.** Before breadth,
   make the day-to-day usage genuinely good: the CLI ergonomics of the full loop (import/decode →
   run → play → feedback → iterate), sensible defaults, clear progress/cost/blocker output, the
   dashboard play/feedback UX. This is where "a normal user can actually use it" is proven, not just
   "it functions." (Findings come from the bridge run + first real usage — write concrete nodes from
   them, per evidence-first.)
2. **Engine breadth — make more engines DRIVE-ready.** After RealLive (Sweetie HD) works, extend the
   legitimate loop + byte substrate to:
   - **Softpal** (drive-ready) — Crystalia is the proving ground (cross-game/brand context).
   - **RPG Maker (MV/MZ)** (drive-ready) — the delegation-runtime engine, closest to ready.
   - **KiriKiri** (drive-ready) — the largest engine by VNDB count (8012 titles).
   - **Siglus** (validate) — VERY similar to RealLive but a MORE MODERN variant; the quirk is the
     modernized format. Validate it against the RealLive-family assumptions (it likely reuses much of
     the RealLive interpreter substrate with format deltas).
     Note: the DAG triage beta-parked (did not delete) the non-RealLive breadth nodes precisely so they
     could be revived here — reclaim + re-scope them onto the now-legitimate loop.
3. **Parallel multi-loop — be your own userbase.** Run MULTIPLE localization loops simultaneously
   across engines (Sweetie HD + a Softpal + an RPG Maker + a KiriKiri title), each a user-agent
   campaign, feeding practical bugs + PRs back — pushing quality and capability up through genuine
   at-scale usage. This is the endgame: the tool improved by really using it, broadly and in parallel.

## The user-agent operating model (why its bugs stay practical)

On a bug, triage into three buckets — the spine's guarantees make the sort clean:

- **Practical** (unhandled opcode, Gameexe quirk, render-fidelity detail, UI rough edge) → **fix +
  PR as a non-core extension**. This is the project growing; real usage generates the real backlog
  (the flywheel).
- **Operational** (budget cap, provider outage) → **resume** (the supervisor's resumable-pause path;
  not a bug).
- **Systemic** (smells mocked/core-broken) → **escalate to core dev (us)**. Per the spine these are
  RARE; one appearing is itself the signal that a spine gap slipped an audit.

## The boundary: the interface enforces "usage, not core dev"

The agent uses ONLY the CLI + dashboard. If it ever _needs_ to reach into core internals to make
localization work, that is not a practical bug — it is a systemic gap that routes back to core dev.
So the interface literally enforces the usage/core-dev line (the FE/BE-unification principle). The
spine's job is to make that line real; the user-agent lives above it and files/fixes everything
below the practical waterline.

## Resume vs from-scratch: resume, re-grounded

The paused Sweetie-HD campaign already has the env, extracted bytes, patch-version dir, and DAG
scaffolding (see the sweetie-hd campaign memory) — but it ran against the cosplay core. Do NOT
restart from zero: re-point that campaign at the **legitimate core** once Gate 2 passes, and
re-verify its first real run from a clean slate ("does one honest run produce a real playable
patch") before letting it iterate autonomously.

## Concrete next steps

1. Finish the spine (nodes 9–12).
2. Add one **bridge milestone node**: _"North-Star real-bytes proof on Sweetie HD via the real CLI +
   dashboard play/feedback"_ — Gates 2+3 as a single go/no-go acceptance for the user-agent. (This
   is node 11's real-game acceptance elevated to a first-class real-bytes milestone.)
3. On green, launch the user-agent with the triage → practical-fix → PR loop; it builds the project
   from genuine usage.

## Readiness checklist before launching the user-agent

- [ ] Spine 12/12 landed (no systemic/mocked-core paths remain — audits confirm).
- [ ] `itotori localize-game sweetie-hd` → real playable patch on real bytes (Gate 2).
- [ ] Dashboard: Play the patch (utsushi renders), submit feedback, refinement run → patch v2 (Gate 3).
- [ ] CLI + dashboard cover the full loop with no dead/orphaned surfaces (FE/BE unification).
- [ ] Bug triage buckets (practical / operational / systemic) documented for the agent.
