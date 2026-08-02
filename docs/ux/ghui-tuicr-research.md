# TUI UX research: ghui and tuicr

Research date: 2026-07-30. This is product research only; no source, themes, prompts, assets, or implementation were copied.

## Revisions

- [`kitlangton/ghui`](https://github.com/kitlangton/ghui) at [`9d66e2f5ea1c1cbe231ac0a66a1fb4928a610e67`](https://github.com/kitlangton/ghui/commit/9d66e2f5ea1c1cbe231ac0a66a1fb4928a610e67), v0.9.0, MIT © 2026 Kit Langton.
- [`agavra/tuicr`](https://github.com/agavra/tuicr) at [`567528413e2600c69579f8ec37330b1c0933cf52`](https://github.com/agavra/tuicr/commit/567528413e2600c69579f8ec37330b1c0933cf52), v0.19.1, MIT © 2025 tuicr contributors.

## Comparison

| Concern                  | ghui                                                                                      | tuicr                                                                                           | Schlop lesson                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Information architecture | Responsive list/detail; full-screen detail modes                                          | Continuous multi-file review with tree, diff, inline comments, comment navigator                | Keep one shell, but let content and comments become focused modes rather than static boxes |
| Responsive behavior      | Side-by-side at ≥100 columns, stacked below; explicit unusable fallback below 60×16       | Fixed 20/80 split; panels can be hidden manually                                                | Adopt tested breakpoints and a minimum-size screen; do not copy fixed percentages          |
| Modes                    | Layered list/detail/diff/input/modal keymaps                                              | Explicit normal, visual, comment, command, search, help, selector, resolver, confirmation modes | Model modes explicitly and scope every action to a mode                                    |
| Discoverability          | Contextual footer plus searchable command palette (`Ctrl-p`/`Cmd-k`/`?`)                  | Persistent mode label, contextual footer, `?` help, `:` completion                              | Generate footer, help, and dispatch from one action registry                               |
| Navigation               | Vim movement/counts, tabs, numeric tabs, surface chords                                   | Vim movement/counts; file/hunk/comment jumps; search and leader chords                          | Keep basic Vim/arrows; add direct file, hunk, heading, and annotation navigation           |
| Diff interaction         | `v` range, `Enter` comment, `n/p` threads, `[/]` files, `h/l` sides, wrapping/view toggle | Visual range, inline comments, file/hunk/comment movement, reviewed collapse                    | Show hunk headers, make side/selection explicit, render comments at their targets          |
| Comment workflow         | Selected threads and comment mode                                                         | `c` line, `C` file, visual ranges, multiline composer; edit/delete exact comment under cursor   | Annotation selection must be explicit; use multiline composition and exact operations      |
| Destructive actions      | Confirmation modals, local errors, retry                                                  | Confirmation mode and submit preflight, though a few dirty paths are inconsistent               | Confirm delete/finish and preserve draft/state on failure                                  |
| Persistence feedback     | Optimistic mutation with rollback                                                         | Atomic locking/merge; sticky errors and transient info                                          | Await saves and expose `saving`, `saved`, and sticky failure states                        |
| Testing                  | Terminal-frame/layout tests                                                               | 1197 tests across state, keybindings, wrapping, Unicode, persistence, VCS; no true PTY suite    | Add render snapshots plus a real packaged PTY/tmux suite                                   |

## Useful interaction patterns

### From ghui

- Footer hints contain only actions valid in the current context.
- A searchable action palette makes a large keyboard surface learnable.
- Keymaps are layered, preventing normal-mode commands from firing inside text input or a modal.
- Layout has explicit width thresholds and a minimum-size fallback.
- Disabled actions can explain what prerequisite is missing.
- Confirmations use Enter to commit and Esc to back out; failures remain local and retryable.

Potential ghui pitfall to avoid: moving complexity into one giant shell hook. Schlop should keep action routing and UI state in pure reducers/controllers.

### From tuicr

- Comments are visible inline at their target and also available through a dedicated navigator.
- Visual selection naturally becomes a multiline comment range.
- The composer is multiline, wraps Unicode correctly, supports paste and scroll, and keeps comment type visible.
- A persistent mode label plus contextual hints makes modal behavior understandable.
- Submit preflight reports stale/unmappable comments and failures without losing drafts.
- Reviewed files/hunks can collapse, reducing an already-inspected surface.

Potential tuicr pitfalls to avoid: fixed percentage layouts, duplicated shortcuts across dispatch/help/docs, swallowed save errors, and inconsistent dirty/confirmation paths.

## Proposed Schlop interaction model

This redesign was implemented in the 2026-07-30 TUI remediation. The model remains the reference for future interaction changes.

### Explicit modes

1. **Browse content** — content cursor and range selection.
2. **Browse documents/outline** — document or Markdown heading cursor.
3. **Browse annotations** — selected annotation with jump/edit/delete.
4. **Compose** — multiline editor, intent and target preview.
5. **Command/help/search** — searchable action registry.
6. **Confirm** — delete, finish annotation, discard/quit.

The focused pane and current mode must be visible in borders and footer text, not color alone.

### Layouts

- **Wide (≥110):** document/outline navigator, content, and a compact annotation navigator; selected annotations also appear inline.
- **Medium (70–109):** navigator + content, annotations as a toggleable lower drawer.
- **Narrow (60–69):** one full-screen pane at a time with obvious tabs and a two-line footer.
- **Unsupported (<60×16):** a clear minimum-size message; no clipped interactive shell.
- Recompute layout on every resize event and preserve semantic cursor/selection.

### Contextual keys

| Context     | Keys                                                                                  |
| ----------- | ------------------------------------------------------------------------------------- |
| Everywhere  | `?` help, `:`/`Ctrl-p` commands, `Tab`/`Shift-Tab` focus, `q` back                    |
| Content     | `j/k`, arrows, counts, `Ctrl-d/u`, `gg/G`, `v` range, `c` annotate                    |
| Diff        | `]d/[d` document, `]h/[h` hunk, `h/l` old/new context side, `w` wrap                  |
| Markdown    | `]h/[h` heading                                                                       |
| Annotations | `]a/[a` or `j/k` annotation, `Enter` jump, `e` edit, `d` confirm delete               |
| Composer    | multiline editing, `Esc` preserve/back, explicit save action, visible intent selector |
| Session     | `s` save, a separate finish action that opens annotation-summary confirmation         |

Never interpret a partially entered chord as another destructive command. Chords, help, footer hints, and documentation should all come from one typed action registry.

## Implemented remediation order

1. Action registry, explicit modes, focused-pane state, contextual footer.
2. Annotation navigator and inline annotation markers.
3. Multiline composer with target preview and reliable replace/edit.
4. Diff hunk rows and Markdown heading navigation.
5. Confirmations and submit preflight, including stale state inside the TUI.
6. Reactive responsive layouts and minimum-size fallback.
7. Render snapshots plus packaged PTY/tmux regression suite.
