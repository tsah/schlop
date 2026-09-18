# Neovim flavor tmux QA plan

## Purpose and release gate

Validate the packaged `--ui nvim` experience as a human-operated Neovim workflow using interactive tmux control. This plan specifically verifies that Schlop launches the selected Neovim with its normal user configuration, retains TypeScript-owned annotation semantics, keeps inspected content immutable, owns the controlling TTY correctly, and restores the terminal after every outcome.

A run fails its release gate if any P0 scenario fails. P1 failures must be recorded as usability or compatibility defects rather than hidden by passing unit tests.

## Harness and evidence

- Build and use `dist/schlop`, never only the Bun source entry point.
- Create an isolated fixture root and session store under `/tmp/schlop-nvim-tmux-qa`.
- Use a named tmux session with explicit wide, medium, and narrow dimensions.
- Drive all user interaction with `tmux send-keys`; do not invoke Neovim APIs from outside the pane.
- Capture panes before and after important transitions.
- Record result JSON, session JSON, exit status, config-load markers, source SHA-256 hashes, temporary-directory residue, and remaining child processes.
- Use a deterministic QA Neovim config for repeatability, plus one smoke run with the operator's actual normal config.

## Fixtures

1. Markdown document with ATX headings, Unicode, a long line, and at least 20 addressable lines.
2. Plain-text document in a path containing spaces.
3. Git repository containing one deletion, one addition, multiple context lines, and a spaced path.
4. Piped Markdown input.
5. Versioned request JSON with a matching content SHA-256 and private result path.

Hash every inspected source before and after the run.

## Scenario matrix

| ID    | Priority | Scenario                         | Interactive actions                                                       | Pass evidence                                                                             |
| ----- | -------- | -------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| NV-01 | P0       | Dependency and TTY diagnostics   | Run `schlop doctor` in tmux                                               | Selected executable/version/runtime; controlling TTY available                            |
| NV-02 | P0       | Normal config loading            | Launch with deterministic config and separately with operator config      | Config marker exists; configured UI option visible; Schlop opens                          |
| NV-03 | P0       | Immutable Markdown surface       | Inspect buffer options, attempt `:write`                                  | `nofile`, readonly, nonmodifiable, no swap/modeline; source hash unchanged; warning shown |
| NV-04 | P0       | Create and submit annotation     | Move, select range, open composer, enter body, save, submit               | Submitted result, exit 0, semantic text target and fingerprint                            |
| NV-05 | P1       | Edit and delete                  | Create note, select in sidebar, edit body, delete with confirmation       | Updated body appears, deletion requires confirmation, final result reflects deletion      |
| NV-06 | P0       | Diff old/new targeting           | Annotate deletion and addition, submit                                    | Two diff targets with exact hunk and `old`/`new` sides                                    |
| NV-07 | P1       | Navigation and help              | Open help, move headings/hunks/documents/annotations, switch panes        | Mappings work and focus/content remain coherent                                           |
| NV-08 | P1       | Responsive layout                | Capture wide, resize to medium and narrow, continue navigation            | No corruption; narrow mode remains usable                                                 |
| NV-09 | P0       | Piped stdin with interactive TTY | Pipe Markdown, interact, approve                                          | UI remains interactive; approved result; exit 0                                           |
| NV-10 | P0       | Request protocol                 | Launch `--request`, approve                                               | Matching request ID/snapshot; atomic approved result                                      |
| NV-11 | P0       | Cancellation                     | Add an annotation, cancel, confirm                                        | Cancelled result; exit 20; terminal restored                                              |
| NV-12 | P0       | Interrupt cleanup                | Send Ctrl-C while reviewing                                               | Exit 130; shell usable; no orphan controller/Neovim; no launch temp residue               |
| NV-13 | P1       | Conventional plugin mode         | Start normal Neovim with Schlop on runtimepath; run `:SchlopFile`; submit | User remains inside Neovim after submit; plugin marker written                            |
| NV-14 | P0       | Source and package safety        | Compare hashes; inspect package and processes                             | No source mutation; no Neovim binary packaged; no orphan process                          |

## Detailed interaction assertions

### Content and composition

- `c` opens a floating composer for the current/selected semantic line range.
- `C` creates a document target and `A` creates a whole-surface target.
- `Ctrl-s` saves a non-empty annotation; empty input remains rejected.
- `Ctrl-i` cycles all four intents without changing body text.
- Extmark/virtual-text markers appear after persistence.

### Diff semantics

- Deleted lines persist `side: old`; additions persist `side: new`.
- Context-side selection changes only context-line targeting.
- Hunk headers and presentation rows never appear as persisted coordinates.
- A cross-side or cross-hunk range is rejected visibly.

### Terminal lifecycle

After submit, approval, cancellation, startup failure, and Ctrl-C:

- tmux returns to a usable shell prompt;
- echo, cursor, and line discipline behave normally;
- no `dist/schlop __controller` or child Neovim remains;
- private launch directories are removed unless debug preservation was requested.

## Execution sequence

1. Run formatting, typecheck, lint, unit/integration tests, build, and package inspection.
2. Create fixtures and deterministic Neovim config.
3. Start tmux at 120×36 and execute NV-01 through NV-07.
4. Resize the same client for NV-08.
5. Execute piped input, request, cancellation, and interrupt scenarios.
6. Execute conventional plugin mode and actual-user-config smoke tests.
7. Validate all JSON with scripts, compare source hashes, inspect processes and temporary files.
8. Write `docs/qa/runs/2026-08-03-nvim-tmux.md` with exact pass/fail results and evidence paths.

## Reporting

The run report must distinguish automated checks from tmux-controlled interaction, list every scenario as pass/partial/fail/not run, include discovered defects with severity and reproduction steps, and avoid claiming visual or lifecycle behavior that was not captured.
