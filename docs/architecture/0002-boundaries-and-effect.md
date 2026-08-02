# ADR 0002: Ports, renderers, and Effect orchestration

Status: accepted (2026-07-30)

## Decision

Dependencies point from protocols/core toward surface implementations, then providers/renderers/storage, then the CLI. Surface providers return protocol values. OpenTUI renderers translate rows to targets and dispatch core operations; React state is not authoritative.

Effect TS is the executable composition boundary. `apps/cli` wraps asynchronous provider, storage, renderer, export, and completion work in an `Effect` program and has one runtime edge (`Effect.runPromise`). Domain reducers stay plain synchronous functions so they are deterministic and usable without an Effect runtime.

Guided Diff is a snapshot-bound overlay that references actual diff document and hunk IDs. It does not replace or excerpt the diff. Host adapters belong under `integrations/` and can only invoke the CLI/protocol; none are part of the MVP.

## Security consequences

Git is spawned with an argument vector, external diffs and pagers disabled, and output-writing options rejected. File input rejects symlinks, non-files, invalid UTF-8, NULs, and oversized input. Inspected content is never written.
