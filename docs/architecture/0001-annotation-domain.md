# ADR 0001: Frozen surfaces and pure annotation state

Status: accepted (2026-07-30)

## Context

Annotations must remain meaningful across terminal layouts and must not silently move when source content changes. Git and host integrations are inputs, not the domain.

## Decision

`AnnotationSession` is authoritative. It owns one immutable, versioned `AnnotationSurface`, annotations, inspection progress, and overlays. Targets carry the surface snapshot ID and semantic coordinates; fingerprints derive from normalized content, never screen rows. Changes create a new snapshot. Resume preserves the frozen snapshot and reports provider staleness without remapping.

Operations in `packages/annotation-core` are pure reducers/controllers. The core imports only the surface protocol and schema/hash utilities; it does not import React, OpenTUI, Git, Effect, browser APIs, models, or host SDKs.

## Consequences

Sessions retain normalized source content needed to inspect their frozen snapshot. Storage is private application data rather than repository state. Provider refresh is explicit. Future remapping requires a separate, opt-in protocol.
