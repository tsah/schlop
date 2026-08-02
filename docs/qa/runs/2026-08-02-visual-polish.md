# QA run: visual polish

Date: 2026-08-02  
Reference: supplied Hunk and tuicr screenshots  
Manual harness: tmux window `schlop:schlop-polish`, 173×45  
Automated harnesses: OpenTUI test renderer plus packaged PTY executable

## Implemented visual changes

- Central semantic dark theme.
- One-line scope bar with file, diff, and inspection totals.
- One-line high-contrast mode badge and contextual action-registry legend.
- Active-file review stream controlled by the file navigator.
- Compact navigator with fixed status and diff-count fields.
- File and hunk header rows.
- Fixed old/new line-number gutters.
- Full-row addition, deletion, cursor, and visual-selection treatments.
- No permanent empty annotation pane.
- Intent-colored inline annotation cards and stable gutter markers.
- Comments mode replaces the navigator rather than shrinking the diff further.
- Inline multiline composer drawer.
- Responsive single-pane narrow mode retained.

## Self-verification

### Character-frame snapshots

OpenTUI `testRender()` snapshots cover widths 60, 80, 120, and 180 at 30 rows. They assert the full frame, including scope bar, active-file navigator behavior, hunk ordering, gutters, and footer legends.

Snapshot: `tests/__snapshots__/tui-visual.test.tsx.snap`

### Semantic color verification

`captureSpans()` asserts that addition and deletion content have distinct backgrounds. The packaged PTY test additionally verifies the emitted 24-bit ANSI backgrounds:

- Addition: `48;2;16;53;30`
- Deletion: `48;2;58;25;27`

### Annotation behavior

Render tests verify:

- Inline annotation text remains in the active file's review stream.
- Normal mode retains the file navigator after creating a comment.
- Comments mode replaces the navigator and retains the inline card.
- Empty annotation state reserves no pane.
- Visual and compose modes render their correct footer badges.

Manual tmux QA created an annotation on a real packaged diff, confirmed it remained inline in `NORMAL`, then used `]a` to open the selected annotation in `COMMENTS` mode.

### File navigation

The fixture contains binary, added, and modified files. The file legend remains visible while the content viewport renders only the selected file. `]d` and `[d` change that selection; `G` remains scoped to the active file.

### Safety and restoration

- Source hashes before and after manual navigation/commenting matched.
- The packaged PTY suite passed multiline composition, exact targets, stale resume, resizing, minimum-size fallback, diff rendering, cancellation, annotation completion, source safety, and alternate-screen cleanup.

## Results

- Formatting: passed.
- Type checking: passed.
- Linting: passed.
- Automated suite: 32 tests passed with 107 assertions.
- Character snapshots: 4 passed.
- Packaged PTY smoke: passed.
- Manual 173×45 inspection: passed.

## Deferred refinement

Tree-sitter syntax highlighting and word-level changed-span emphasis remain optional refinement. Current rendering intentionally prioritizes diff semantics, matching tuicr's strong added/deleted blocks. These refinements must not weaken semantic contrast or terminal performance.
