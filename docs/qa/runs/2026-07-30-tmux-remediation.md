# QA run: TUI remediation

Date: 2026-07-30  
Harness: packaged `dist/schlop`, tmux 3.6a window `43:schlop-qa`, live widths 173, 85, 64, and 50 columns  
Automated PTY harness: `tests/e2e/pty_smoke.py`

## Result

The thirteen usability defects from the initial run were addressed and re-exercised. No inspected source changed and every packaged PTY path restored the alternate screen.

| Initial defect               | Remediation                                                                                         | Evidence                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Cosmetic pane model          | Visible focused border; pane-specific movement/activation/actions; one-pane narrow mode             | Tab and Shift-Tab exercised at medium/narrow widths                           |
| No annotation selection      | Dedicated annotation cursor, locations, bodies, jump and `]a/[a` navigation                         | Multiline annotation appeared selected at its exact location                  |
| Ambiguous immediate deletion | `d` is annotation-pane-only and opens confirmation naming intent, target, and body                  | `n` retained; `y` deleted the selected annotation                             |
| Unsafe single-line editing   | Multiline textarea, wrapping, Enter newline, Ctrl-s save, existing body preselected for replacement | Two-line body persisted; typing during edit replaced rather than concatenated |
| Broken live resize           | Renderer resize subscription and reactive wide/medium/narrow/minimum layouts                        | 64×24 switched to one-pane tabs; 50×12 showed minimum-size screen             |
| Invisible stale state        | Staleness passed into renderer, amber header/status, finish-screen warning                          | Packaged stale-resume PTY assertion found `STALE` inside screen output        |
| Missing diff context         | Hunk headers and file status/addition/deletion summaries                                            | Packaged diff output contained the exact `@@` header                          |
| No finish confirmation       | Separate save and finish commands; annotation-summary preflight with staleness warning              | `r` preflight exercised; explicit `s` submitted                               |
| Empty Markdown outline       | Heading hierarchy shown and `]h/[h` navigation                                                      | Generated QA document displayed all three headings                            |
| Poor discovery               | Contextual fitted footer, generated help, searchable `:` command palette                            | Palette filtered `finish` to the finish action                                |
| Color-only range state       | Footer reports line or explicit selection start/end                                                 | Selection displayed as `selection 3-5`                                        |
| Flattened annotations        | Two-line navigator entries with selected intent/location/body plus inline `◆` markers               | Captured selected range and multiline body without one-line flattening        |
| Wasteful/clipped layout      | Three-pane wide, annotation drawer medium, one-pane narrow, exact hint fitting and truncation       | No border overwrite after row-height/content-budget fix                       |

## Regression coverage added

The packaged PTY suite now covers:

- Markdown stdin to multiline annotation and exact lines 3–5.
- Finish summary and submitted completion.
- Safe-exit confirmation and cancelled completion.
- Stale file resume with visible in-TUI warning.
- Live narrow resize and minimum-terminal fallback.
- Git diff hunk-header rendering.
- Source hash preservation.
- Alternate-screen restoration in every path.

Pure tests cover safe chord resolution, contextual action hints from the action registry, explicit annotation navigation, Enter aliases, hint fitting, selection, panes, and responsive breakpoint selection.

## Remaining non-goals

Mouse input, side-by-side diff, rendered Markdown, remote providers, AI overlays, and host integrations remain deliberate post-MVP work rather than usability defects in the base annotation loop.
