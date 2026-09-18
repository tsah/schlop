# ADR 0004: Neovim is a protocol-driven renderer

Status: accepted (2026-08-02)

## Context

Schlop's authoritative annotation reducers, snapshot validation, persistence, and exports are TypeScript. Reimplementing them in Lua would create incompatible domain semantics.

## Decision

CLI-launched and conventional-plugin Neovim modes use the same packaged Lua renderer. The CLI starts a fresh Neovim process with the user's normal configuration and injects Schlop's runtime before startup. It starts a private Schlop controller subprocess and exchanges newline-delimited JSON over stdio. The controller owns the current `AnnotationSession`, calls `packages/annotation-core` for every mutation and validation, calls `annotation-storage` for persistence, and calls `annotation-export` for completion results.

Lua owns only transient window, buffer, cursor, selection, composer, and extmark state. It sends semantic targets containing snapshot, document, hunk, side, and line coordinates. Extmarks and presentation rows are never persisted.

The public request/result files are versioned integration protocols. The JSON-lines controller protocol and launch file are private implementation details and may evolve with the packaged frontend.

## Consequences

There is one annotation implementation. Both Neovim entry points share UI and protocol code, while the existing OpenTUI remains backward compatible. A conventional plugin installation also needs an accessible Schlop executable; CLI launch does not require Schlop to be installed through a plugin manager.
