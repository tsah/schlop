# Schlop

> **Check the schlop before you ship.**

Schlop is an open-source, terminal-native annotation engine. It freezes supplied content into an addressable surface, lets a human attach structured feedback, and exports reusable Markdown or JSON. It is deliberately not an agent-review tool: hosts and agents are external producers and consumers.

## Install and develop

Requires Bun 1.3+.

```bash
bun install
bun run build
./dist/schlop --help
```

The production build is a standalone `dist/schlop` executable. During development use `bun run dev -- <arguments>`.

## Commands

```text
schlop
schlop diff [git-diff arguments]
schlop file <path> [--type text|markdown]
schlop annotate --stdin [--type text|markdown|diff]
schlop resume [session-id]
schlop sessions [--delete ID | --archive ID]
schlop export [session-id] --format markdown|json [--output FILE]
schlop overlay add guide.json [--session ID]
```

Useful examples:

```bash
schlop diff --cached
schlop diff main...HEAD -- src/auth.ts
schlop file README.md
printf '# Plan\n\nDo the thing.\n' | schlop annotate --stdin --type markdown
some-command | schlop annotate --stdin --type text --title 'Output' --source-label tool
```

When stdin is piped, Schlop opens `/dev/tty` (or the Windows console) for interaction and reserves stdout for the result.

### Keys

Schlop shows the file selected in its compact navigator as a semantic review surface with fixed old/new gutters and inline annotations. It uses explicit document, content, annotation, composer, command, help, and confirmation modes. The footer's mode badge and contextual legend show what the keys mean now; an empty annotation state consumes no pane.

`j/k` or arrows move, `Ctrl-d/u` page, `gg/G` jump, and `Tab/Shift-Tab` change focus. Use `]d/[d` for documents, `]h/[h` for diff hunks or Markdown headings, and `]a/[a` for annotations. `v` selects a range; `c`, `C`, and `A` annotate a range, document, or surface. In diffs, `h/l` choose the old/new context side and `w` toggles wrapping. The composer is multiline: Enter inserts a line and `Ctrl-s` saves the annotation. In the annotation pane, `e` edits the selected annotation and `d` opens deletion confirmation. `s` saves the session; `r` opens the finish screen; `:` searches available commands; `?` opens generated help; `q` opens safe-exit confirmation.

## Completion protocol

Wrappers can request an atomic, versioned result file:

```bash
schlop annotate --stdin --type markdown \
  --title 'Last response' --source-label pi \
  --result-file /tmp/schlop-result.json
```

Exit codes are:

| Outcome   | Code |
| --------- | ---: |
| submitted |    0 |
| error     |    1 |
| cancelled |   20 |

Without `--result-file`, submitted annotations are written as Markdown to stdout. `source-label` is opaque metadata and activates no host behavior.

## Architecture

```text
surface-protocol ← annotation-core
       ↑                 ↑
surface-text / surface-markdown / surface-diff
       ↑
provider-stdin / provider-file / provider-git
       ↑
annotation-storage / annotation-export / overlay-protocol / OpenTUI renderer
       ↑
Effect TS CLI composition
```

Core reducers validate snapshot identity, documents, text coordinates, diff hunk/side coordinates, ranges, and optional context fingerprints. Stable IDs and snapshots use SHA-256 over normalized semantic content. Renderer rows are ephemeral and never persisted as targets.

Sessions are atomically stored with restrictive permissions under `$SCHLOP_DATA_DIR`, `$XDG_DATA_HOME/schlop`, or the platform application-data directory. Resume preserves frozen content. File and Git sessions are refreshed only for staleness comparison; changed content is never remapped.

See [`docs/architecture`](docs/architecture) for decisions.

## Security and current limitations

Schlop never edits inspected files, applies patches, runs project code, commits, fetches remotes, or submits feedback. File input has a 10 MiB limit and rejects symlinks, binaries, and invalid UTF-8. Git uses structured process arguments and rejects output/external-diff options.

Current limitations: Markdown is source-only; diff is unified-only; there is no mouse or side-by-side view, heuristic remapping, remote provider, AI guide generation, host integration, clipboard export, or rendered Markdown. Generic non-Git unified diffs should use Git-style `diff --git` file boundaries.

## License

MIT. This revision is a clean implementation; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
