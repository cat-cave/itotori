# Softpal work-process protocol consumer inventory

## Scope and method

This is the rank-12 consumer-side reconstruction for the two staged Softpal
titles.  It uses the compact VM's real-corpus trace and its actual post-attach
script control-flow graph.  It records offsets, counts, and field shapes only;
no private dialogue, speaker, or choice payload is retained here.

The inventory deliberately separates three evidence levels:

1. a field the compact VM actually reads after attachment;
2. a native-layout claim described by the external reference; and
3. a field whose meaning has a read-before-write witness in this title's
   callback path.

Only level 3 may seed a deterministic callback protocol.  In particular, a
pointer passed to an attach function is not itself a readable selector.

## Real-corpus result

The ordinary `SCRIPT.SRC` control-flow slice treats every native syscall as an
opaque normal return, forks both conditional successors, preserves script call
returns, and never invents a successor for `end` or a root `return`.

| Corpus | CFG states | CFG edges | Reachable message calls | Reachable choice calls | Post-attach root returns | Post-attach ends |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 622 | 646 | 0 | 0 | 1 | 0 |
| 2 | 826 | 857 | 0 | 0 | 1 | 0 |

The root returns are the existing visible stops at script offsets 576 and 696.
They have no operands.  Therefore there is no script-visible read after the
ordinary terminus from which to infer a native task field, and no normal
script-only route to any static message call.

The compact compatibility layer has **zero root-task-data fields**: its only
post-attach state is the boolean `work_process_attached`, which produces the
named `work_process_callback_unavailable` diagnostic at the root return.  It
does not contain an untyped root-task byte buffer, a selector, a scheduler
queue, or a callback dispatcher.  Consequently, the exhaustive consumer
inventory for the current executed path is empty:

| Field offset | Type | Lifetime | Branch/message influence | Read-before-write witness |
| --- | --- | --- | --- | --- |
| _none_ | — | — | — | — |

## `+824` disposition

The comparable reference documents the attach call as passing
`PalTaskGetTaskData(0) + 824` to the PAL work-process attachment API.  On the
evidence available to this repository, that establishes only an **address
passed at attachment time**:

| Candidate offset | Observed operation | Type | Lifetime | Branch/message influence | Read-before-write witness | Disposition |
| ---: | --- | --- | --- | --- | --- | --- |
| +824 | attach argument / pointer derivation | pointer to unknown native state | native work-process attachment | none observed in script | no | must not be populated or named as a selector |

There is no reader of `+824` in the compact VM, no recovered title callback
body that reads it, and no writer-before-reader path from it to a branch or a
message syscall.  The field is therefore excluded from any callback data
schema.  Supplying zeroes or a guessed selector would violate the VM's
explicit-failure rule and could fabricate plausible dialogue.

## What the experiment establishes

The script-only route is eliminated for this boot entry, but native **body
extraction** is not yet proven necessary.  What is proven necessary is an
external resumption protocol: after the work attachment, ordinary script
control flow returns to the root without visiting a message syscall.  A future
implementation must first recover either a title-owned event/queue record with
a read-before-write witness, or another evidenced callback entry.  Until then
the correct runtime result remains the named
`work_process_callback_unavailable` failure and zero executed text.

## Deliberately not inferred

- No semantic meaning is assigned to `+824`.
- No selector, task-data buffer, event, callback target, speaker, choice, or
  message text is defaulted.
- The statically decoded dialogue is not claimed to be route-reachable from
  this boot entry; the CFG result proves the opposite for ordinary script
  successors.
- The callback is not claimed to be the sole cause of zero dialogue.  It is
  the first missing external resumption boundary; the slice separately proves
  that the ordinary script graph has no message route after it.
