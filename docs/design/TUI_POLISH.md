# Schlop TUI polish direction

Status: implemented (2026-08-02)

## What the reference screens get right

The supplied Hunk and tuicr screens feel cleaner because they prioritize the review artifact rather than the application chrome:

1. **The diff owns the screen.** File navigation is compact; the main pane receives almost all remaining width and height.
2. **Diff semantics are visual.** Added/deleted blocks have full-row background color, separate line-number gutters, file separators, and unmistakable hunk headers.
3. **Hierarchy is shallow.** Thin dividers and whitespace replace nested boxes. There is one strong focus border rather than a border around every region.
4. **The footer teaches the current mode.** A high-contrast mode badge is followed by a short, contextual key legend.
5. **Density is deliberate.** File status, counts, paths, line numbers, and shortcuts align into predictable columns.
6. **Inactive UI disappears.** Empty comment/annotation areas do not permanently consume review space.

Schlop currently has the interaction machinery but still looks like a collection of bordered widgets. The next pass should be a visual-system and diff-rendering redesign, not another feature pass.

## Target composition

### Review mode

```text
 SCHLOP  Working tree                         3 files  +4 -1  1/3 inspected
 ┌ Files ──────────────────┬ tracked.txt [M] ───────────────────────────────
 │ M tracked.txt      +3 -1│ @@ -1,3 +1,5 @@ parseConfig
 │ B image.bin             │   1   1   alpha
 │ A new file.txt      +1  │   2     - beta
 │                         │       2 + beta changed
 │                         │   3   3   gamma
 │                         │       4 + delta
 │                         │
 │                         │ ◆ Change request · new:2
 │                         │   Explain why this value changes here.
 └─────────────────────────┴────────────────────────────────────────────────
 NORMAL  j/k move · ]d/[d file · ]h/[h hunk · v select · c comment · ? help
```

### Visual selection

```text
 VISUAL  new:2-4 · j/k extend · h/l side · c annotate · Esc cancel
```

### Annotation navigation

```text
 COMMENTS  2/4 · j/k choose · Enter jump · e edit · d delete · Esc content
```

### Composer

The composer is an inline drawer attached visually to its target, not a detached full-width form:

```text
 ┃ CHANGE REQUEST · tracked.txt new:2-4
 ┃ Explain why this value changes here.
 ┃ _
 COMPOSE  Enter newline · Ctrl-s save · Ctrl-i intent · Esc keep draft/back
```

## Visual rules

### Chrome

- One top scope bar and one bottom mode/shortcut bar.
- A single vertical separator between navigator and content.
- No box around the annotation list when it is empty.
- No persistent annotation drawer in normal review mode.
- Use thin file/hunk separators inside the content stream.
- Reserve bright cyan for focus/current mode, not every border.

### Theme tokens

Create one renderer-independent theme contract:

```ts
interface TuiTheme {
  background: string;
  surface: string;
  surfaceRaised: string;
  text: string;
  textMuted: string;
  accent: string;
  focus: string;
  additionText: string;
  additionBackground: string;
  deletionText: string;
  deletionBackground: string;
  selectionBackground: string;
  hunkText: string;
  border: string;
  warning: string;
  error: string;
  intents: Record<AnnotationIntent, string>;
}
```

Start with a restrained dark theme matching the references. All state must remain legible without color through signs, labels, and mode text.

### Diff rows

- Fixed old/new number gutters.
- Full-width backgrounds for addition/deletion rows.
- Muted context rows.
- Hunk headers rendered as dedicated rows with function/section context.
- File headers show status, additions/deletions, rename paths, binary/empty state, and inspected state.
- Cursor is a full-row treatment, not only a leading glyph.
- Selection is a full-row treatment with an explicit textual range in the footer.
- Annotation markers occupy a stable gutter column.
- Inline annotations render directly after their target range.
- Add syntax highlighting only after semantic colors and gutters are correct; syntax must not overpower diff state.

### Navigator

- Compact rows with status in a fixed column and counts right-aligned.
- Collapse shared path prefixes into a real tree when useful.
- Current file gets a full-row selection background.
- Inspected state uses both a glyph and subdued styling.
- Toggle navigator visibility; content becomes full width.
- Markdown replaces file statistics with a compact heading outline.

### Footer

The footer is one line whenever the terminal permits:

1. Fixed-width, high-contrast mode badge.
2. Selection or progress summary only when contextually important.
3. Key legend generated from the action registry.
4. Transient save/error messages appear as a toast/status segment and do not permanently displace shortcuts.

Do not show implementation state such as `saved` continuously when nothing needs attention.

## Layout behavior

- **Wide ≥120:** compact navigator plus content. Annotation outline opens only on demand.
- **Medium 80–119:** narrower navigator plus content; annotation mode replaces navigator.
- **Narrow 60–79:** one pane at a time with a compact tab/mode header.
- **Below 60×16:** minimum-size message.
- Resize must preserve semantic cursor, selected target, and scroll position.

## Implementation status

Implemented:

1. **Theme and frame:** central tokens, scope bar, mode footer, redundant chrome removal, and no persistent empty annotation drawer.
2. **Semantic diff rows:** fixed gutters, full-row backgrounds, hunk/file headers, cursor, and visual selection.
3. **Active-file review stream:** the navigator is authoritative; the main viewport shows only its selected file and that file's hunks.
4. **Inline annotations:** target markers and intent-colored comment cards; comments mode replaces the navigator.
5. **Compact navigator:** aligned status/count rows, heading outline, responsive show/replace behavior.
6. **Visual regression suite:** character-frame snapshots at 60, 80, 120, and 180 columns, semantic color-span assertions, inline-comment/mode assertions, and packaged PTY checks.

Deferred refinement: tree-sitter syntax color and word-level changed-span emphasis. Diff semantics deliberately dominate source syntax in the current theme.

## Polish acceptance criteria

- At least 75% of a typical 120×35 terminal is content/diff, not chrome or empty UI.
- An empty annotation state consumes no dedicated pane height.
- Added and deleted lines are distinguishable instantly by sign, gutter, and full-row treatment.
- Current file, current row, selected range, focused mode, and stale state are each recognizable without opening help.
- Every interactive mode has a short, accurate legend generated from the action registry.
- No footer hint is clipped mid-command.
- No border intersects or overwrites content at supported dimensions.
- Long paths and lines truncate or wrap intentionally.
- Screens at all four reference widths have reviewed ANSI snapshots.
- Source safety, stable targets, and renderer independence remain unchanged.
