# Runtime Web Review

Vite runtime evidence dashboard for Utsushi reports ingested by Itotori.

The current app renders `/runtime/evidence/:runtimeRunId` and reads
`/api/runtime/v0.2/status`. It shows the selected runtime run/report ids,
runtime status, fidelity and evidence tiers, text events, frame captures,
screenshot and recording artifacts, validation findings, and artifact links.

This package is still intentionally small, but it is no longer only a future
browser shell: it is the current review surface for runtime evidence produced by
the fixture path and shared v0.2 runtime API.
