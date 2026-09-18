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

The existing OpenTUI remains the default for backward compatibility. Select the Neovim frontend with `--ui nvim` or `SCHLOP_UI=nvim`:

```bash
schlop --ui nvim diff
schlop --ui nvim file README.md
command | schlop --ui nvim annotate --stdin --type markdown
schlop --request /tmp/request.json
schlop doctor
```

When stdin is piped, Schlop materializes all content in a private temporary location, then opens `/dev/tty` for Neovim interaction and reserves stdout for the result. A controlling terminal is required; Schlop fails without waiting if one is unavailable.

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
| approved  |    0 |
| error     |    1 |
| cancelled |   20 |

Without `--result-file`, submitted annotations are written as Markdown to stdout. `source-label` is opaque metadata and activates no host behavior.

## Neovim frontend

Schlop launches a new process using your existing Neovim executable, normal configuration, plugins, keybindings, colorscheme, and ShaDa behavior. It injects Schlop's packaged Lua runtime before startup and opens Schlop after your configuration has loaded. Schlop does not bundle, download, install, or upgrade Neovim, and it does not require installation through your plugin manager. It requires **Neovim 0.9.0 or newer**, based on the buffer, extmark, job, JSON, and Lua APIs used. Installation documentation: <https://neovim.io/doc/user/install.html>.

Executable precedence is `--nvim`, the `nvim` property in `$SCHLOP_CONFIG` or the platform Schlop config, `SCHLOP_NVIM`, then `nvim` on `PATH`. `schlop doctor` reports the selected executable/version, Lua runtime, session storage, and controlling TTY. It returns nonzero when a required capability is missing.

The launched process intentionally loads your normal Neovim configuration and plugins. Schlop surfaces themselves remain immutable `nofile` scratch buffers with swap, undo persistence, writes, and modelines disabled. Because your configuration is trusted and runs normally, its startup code and autocommands may execute; use conventional plugin mode if you prefer to control exactly when Schlop opens. Linux and macOS terminal ownership are supported; Windows launch mode currently fails clearly because its console lifecycle has not been tested.

### Request and result files

`schlop --request request.json` accepts schema version 1:

```json
{
  "schemaVersion": 1,
  "requestId": "request-id",
  "surface": {
    "kind": "markdown",
    "title": "Document",
    "contentPath": "/private/tmp/content.md",
    "snapshotId": "sha256:<content-sha256>"
  },
  "source": { "label": "host" },
  "resultPath": "/private/tmp/result.json",
  "options": { "readOnly": true }
}
```

Content must be a regular non-symlink file, valid UTF-8, NUL-free, at most 10 MiB, and match the supplied SHA-256. Metadata is display-only and restricted to safe scalar values. Result parents must already exist. Results are atomically renamed into place and validated before the launcher accepts them:

```json
{
  "schemaVersion": 1,
  "requestId": "request-id",
  "outcome": "submitted",
  "sessionId": "session-id",
  "surfaceSnapshotId": "sha256:...",
  "annotations": [],
  "formattedFeedback": "# Schlop annotations\n..."
}
```

Outcomes are `submitted`, `approved`, `cancelled`, and `error`. Approval does not invent formatted feedback. Exit status is separate: submitted/approved `0`, error `1`, cancelled `20`, and interruption `130` where available. A missing, partial, mismatched, or invalid result is an error.

### Conventional plugin mode

Add `nvim/` to `runtimepath` using your preferred plugin mechanism. Plugin and CLI-launched modes use the same Lua renderer and TypeScript controller semantics. The `schlop` executable must be on `PATH`, or configure it with `require("schlop").setup({ executable = "/path/to/schlop" })`.

```vim
:SchlopDiff
:SchlopDiff --cached
:SchlopFile README.md
:SchlopRequest /tmp/request.json
:SchlopResume
:SchlopSubmit
:SchlopApprove
:SchlopCancel
```

The content header always identifies the current document and its position in the review. Use `]f` and `[f` to move to the next and previous documents; the persistent footer shows these and the primary annotation shortcuts, while `?` opens the complete help window.

Lua APIs include `require("schlop").open_request(path)` and `require("schlop").annotate({ kind = "markdown", title = "Document", content = "...", result_path = "..." })`. Mappings are buffer-local and configurable. `Ctrl-c` interrupts CLI-launched Schlop with exit 130; in plugin mode it closes only the Schlop UI. Plugin-mode completion does not exit Neovim.

### Host TUI lifecycle

A terminal host in raw mode must suspend its renderer, restore ordinary terminal settings, launch Schlop, wait, restore raw mode, redraw, and then read the result. This is host integration behavior, not annotation-core behavior. Alternatively, launch Schlop in a tmux pane/window and consume the result asynchronously.

Build output contains `dist/schlop` and `dist/share/schlop/nvim/`; a system-prefix installation places these as `bin/schlop` and `share/schlop/nvim/`. The packaged runtime contains Schlop Lua only, not Neovim or its distribution runtime.

Troubleshooting starts with `schlop doctor`. Use `--nvim /path/to/nvim` or `SCHLOP_NVIM`; `SCHLOP_RUNTIME` is a development/debug override. `--keep-temporary` preserves launcher files for debugging. Schlop never executes inspected content or modelines, edits sources, applies patches, fetches content, or automatically sends feedback. Your own Neovim startup configuration remains responsible for any code it chooses to run.

## Pi extension

`integrations/pi` is a Pi coding agent package. It adds `/schlop-last`, which opens the last assistant message of the active branch in Schlop's Neovim frontend. Annotate, press `s` to submit, and the annotations are sent back to Pi as a user message that quotes each annotated passage. Approving (`S`), cancelling (`q`), or submitting without annotations sends nothing.

Install it from a checkout, then build Schlop so the executable exists:

```bash
pi install /path/to/schlop/integrations/pi
bun run build
```

The extension resolves the executable from `SCHLOP_BIN`, then `schlop` on `PATH`, then this checkout's `dist/schlop`. It follows the host TUI lifecycle below: Pi's renderer is suspended while Neovim owns the terminal and redrawn afterwards, so it requires Pi's interactive TUI mode. Try it without installing using `pi -e integrations/pi/index.ts`.

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
