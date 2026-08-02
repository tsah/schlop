# Schlop MVP QA plan

## Purpose and release gate

This plan validates Schlop as a human-operated terminal annotation tool, not merely as a schema library. A release candidate fails if any P0 scenario fails or if a P1 failure makes the main annotation loop confusing, destructive, inaccessible, or non-recoverable.

Priorities:

- **P0:** source safety, target correctness, terminal restoration, input-to-result vertical slices.
- **P1:** core usability, all supported commands and target types, persistence, staleness, exports.
- **P2:** edge cases, responsive presentation, discoverability, recovery, performance.

Every manual run records the build revision, terminal/emulator, dimensions, shell, fixture hash, result file, exit code, source hashes before/after, and terminal capture.

## Test environments

| Environment                 |       Dimensions | Purpose                                |
| --------------------------- | ---------------: | -------------------------------------- |
| tmux + current terminal     | 160×45 or larger | Wide workflow and visual review        |
| tmux                        |            90×30 | Medium layout                          |
| tmux                        |            64×24 | Narrow layout and truncation           |
| piped stdin plus `/dev/tty` |              all | Wrapper workflow and stdout separation |
| temporary Git repository    |              n/a | Deterministic Git safety and scope     |
| non-Git temporary directory |              n/a | File/stdin independence                |

Run once with light and dark terminal palettes where practical. Repeat keyboard tests with arrows and Vim bindings. Tests must use the packaged `dist/schlop`, not only source execution.

## Deterministic fixtures

- Text: empty, one line, 100+ lines, tabs, Unicode, very long line, CRLF, missing final newline.
- Markdown: ATX headings levels 1–6, no headings, duplicate headings, long document.
- Git: modified, added, deleted, renamed, binary, empty, untracked, staged, Unicode and spaced paths, multiple hunks, missing final newline.
- Sessions: valid v1, unsupported version, corrupt JSON, invalid target, stale file, stale Git snapshot.
- Overlays: valid guide, wrong snapshot, unknown document/hunk, oversized fields.

## Core test matrix

### P0 vertical slices

| ID    | Scenario                                                        | Expected evidence                                                           |
| ----- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| VS-01 | Pipe Markdown stdin, select 3 lines, add change request, submit | Correct `text-range`; result outcome `submitted`; Markdown feedback; exit 0 |
| VS-02 | Open working-tree diff, annotate deletion and addition          | Old/new `diff-range` targets reference exact hunk and lines                 |
| VS-03 | Cancel from viewer and composer                                 | Outcome `cancelled`; exit 20; no source mutation; terminal restored         |
| VS-04 | Finish without annotations                                      | Outcome `submitted`; empty annotation export; exit 0                        |
| VS-05 | Interrupt with SIGINT and SIGTERM during viewer/composer/save   | Atomic session/result; cursor, raw mode, mouse, alternate screen restored   |
| VS-06 | Hash every inspected file before/after all workflows            | Hashes unchanged, including error paths                                     |

### CLI and providers

| ID range  | Coverage                                                                               |
| --------- | -------------------------------------------------------------------------------------- |
| CLI-01–04 | `schlop`, `diff`, default Git detection, non-Git error                                 |
| CLI-05–10 | `--cached`, revision, range, pathspec, spaced arguments, rejected unsafe options       |
| CLI-11–14 | `file` inference/override, missing file, symlink, invalid UTF-8/binary/size limit      |
| CLI-15–18 | stdin text/Markdown/diff, title, opaque source label, no controlling TTY               |
| CLI-19–23 | help, unknown command/option, result output path, stdout purity, documented exit codes |

### Annotation behavior

| ID range  | Coverage                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| ANN-01–04 | change request, question, suggestion, note                                                                                                           |
| ANN-05–08 | single line, multiline, document, surface targets                                                                                                    |
| ANN-09–12 | diff old, diff new, context-side toggle, cross-side/hunk rejection                                                                                   |
| ANN-13–17 | edit selected annotation, delete selected annotation with confirmation, empty body rejection, Unicode/multiline body, external annotation validation |
| ANN-18–21 | visible selection anchor/range, selection cancellation, target preview, annotation-to-source navigation                                              |

### Navigation and terminal UX

| ID range   | Coverage                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| NAV-01–05  | arrows/Vim, page, top/bottom, next/previous document                                                                            |
| NAV-06–10  | pane focus is visible and functional; Tab/Shift-Tab; annotation next/previous; heading navigation                               |
| NAV-11–15  | help opens/closes from every mode; shortcut labels match behavior; destructive actions confirm; save/submit/cancel are distinct |
| LAY-01–05  | initial wide/medium/narrow; live resize across breakpoints; long line; long annotation/status wrapping                          |
| TERM-01–04 | success, cancel, signal, renderer error cleanup                                                                                 |
| A11Y-01–03 | state not conveyed only by color; Unicode width; low/no-color legibility                                                        |

### Persistence, staleness, and recovery

| ID range  | Coverage                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------- |
| SES-01–05 | autosave, resume ID, resume recent, list, archive/delete                                             |
| SES-06–09 | permissions, atomic replacement, concurrent save behavior, corrupt neighbor recovery                 |
| STL-01–04 | unchanged source, changed file, changed Git scope, deleted source                                    |
| STL-05–07 | stale warning remains visible in TUI; frozen content remains inspectable; new session does not remap |
| MIG-01–03 | valid v1, unsupported future version, safe migration fixture when v0/v2 exists                       |

### Export and wrapper completion

| ID range  | Coverage                                                                                  |
| --------- | ----------------------------------------------------------------------------------------- |
| EXP-01–04 | Markdown grouping/location, question semantics, JSON schema, no annotations               |
| EXP-05–07 | stdout, explicit file, write failure                                                      |
| RES-01–04 | submitted, cancelled, provider/TUI error result files and exit codes                      |
| RES-06–08 | atomic result, source label remains opaque, stdout contains no terminal control sequences |

### Diff and overlay edge cases

| ID range  | Coverage                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| DIF-01–10 | modified, added, deleted, renamed, binary, empty, untracked, Unicode, tabs/long lines, missing newline        |
| DIF-11–14 | multiple hunks/files, no changes, malformed stdin diff, stable IDs                                            |
| OVL-01–06 | valid attach, snapshot mismatch, document mismatch, hunk mismatch, size/version rejection, session round trip |

### Security and robustness

| ID range   | Coverage                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| SEC-01–06  | no source writes, no shell invocation, no external diff/textconv, no project execution, no symlink traversal, no remote fetch |
| SEC-07–10  | untrusted session/annotation/overlay input, path traversal in IDs/output, restrictive files, no unexpected secret retention   |
| PERF-01–03 | maximum text, maximum diff, rapid repeat keys without state corruption                                                        |

## Automation strategy

1. Pure reducer/schema/parser/export tests run with `bun test`.
2. Provider integration tests create isolated temporary repositories.
3. A PTY harness drives the packaged executable and asserts screen restoration and exit codes.
4. tmux scripts launch the real app, send keys with human-scale delays, capture ANSI screens, and inspect persisted targets/results.
5. Visual QA remains mandatory for hierarchy, discoverability, focus, truncation, and confirmation behavior.

## Release checklist

```bash
bun run format:check
bun run typecheck
bun run lint
bun test
bun run build
bun run test:e2e
# Run tmux manual scenarios VS-01 through VS-06.
# Verify source hashes and inspect every captured wide/medium/narrow screen.
```

A run report must list failures honestly; passing domain tests does not override failed human workflow tests.
