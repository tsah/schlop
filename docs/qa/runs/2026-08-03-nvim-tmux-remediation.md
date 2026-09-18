# QA run: Neovim tmux remediation

Date: 2026-08-03  
Build: local uncommitted remediation, packaged with `bun run build`  
Harness: tmux 3.6a, session `schlop-nvim-remediation`, 120×36 with live resize to 64×24  
Evidence: `/tmp/schlop-nvim-tmux-remediation`

## Summary

The four actionable Schlop defects from `2026-08-03-nvim-tmux.md` were fixed and retested through real tmux keys. Composer save now restores Normal mode, edit input replaces the selected body, live resize removes/recreates the sidebar, narrow help wraps fully, and terminal Ctrl-C exits 130 without orphaned processes or temporary files.

The separate operator-config treesitter failure was not suppressed: loading and executing the user's normal configuration remains intentional. Schlop cannot make a user plugin's missing external dependency succeed without isolating or disabling that configuration.

| Remediation                     | Result | Evidence                                                                         |
| ------------------------------- | ------ | -------------------------------------------------------------------------------- |
| Composer leaves Insert mode     | Pass   | `captures/composer-after-save.ansi`; direct `s` submitted with exit 0            |
| Edit replacement                | Pass   | `captures/edit-selected.ansi`; result body exactly `Edited note only`            |
| Live responsive layout          | Pass   | `captures/resize-narrow.ansi`, `captures/resize-wide-restored.ansi`              |
| Narrow help wrapping            | Pass   | `captures/help-narrow.ansi`; all descriptions visible without truncation markers |
| Interactive terminal Ctrl-C     | Pass   | `captures/interrupt-shell.ansi`; exit 130 and `TERMINAL_RESTORED`                |
| Child/temp cleanup after Ctrl-C | Pass   | `results/orphans` empty; pre/post temporary-directory lists identical            |

## Test-first evidence

### Ctrl-C

The PTY test was changed from sending `SIGINT` directly to the launcher PID to writing the real terminal Ctrl-C byte. It timed out before the fix, reproducing the tmux failure. A buffer-local configurable interrupt mapping now records cancellation, closes controller/UI state, and exits CLI-launched Neovim with status 130.

### Composer mode

The Neovim integration test now asserts Normal mode after `Ctrl-s` before sending `s`. Composer save and escape explicitly leave Insert mode before restoring the immutable content window.

### Edit replacement

The integration test opens the annotation from the sidebar, requires Select mode, types replacement text through normal keys, saves, and validates the final result body. Existing content is selected in Select mode so typing replaces it.

### Resize and help

A headless integration test opens at wide width, crosses to narrow and back through `VimResized`, and asserts the Schlop-owned window count changes from two to one to two. It also starts with wrapping disabled globally and verifies the narrow help window enables wrapping and line breaking itself.

## Interactive results

### Composer

A real tmux sequence selected Markdown lines 3–5, opened `c`, entered `Composer now returns to Normal mode.`, and pressed Ctrl-S. The capture had no Insert-mode indicator. Pressing `s` immediately submitted; no E21 occurred. The result retained exact lines 3–5 and context fingerprint.

### Edit

A note was created, selected in the sidebar, and opened with `e`. Typing `Edited note only` replaced `Original note`; the submitted result contained only the replacement.

### Resize

A session opened at 120 columns and was resized live to 64. The sidebar was removed and the short status line remained readable. Resizing back to 120 recreated the sidebar without line numbers; action labels fit on one line.

### Ctrl-C

A tmux `send-keys C-c` returned directly to the shell:

```text
INTERRUPT_EXIT:130
TERMINAL_RESTORED
```

No Schlop, controller, or Neovim child remained, and no new `schlop-*` or `schlop-result-*` directory remained.

## Verification

- Formatting passed.
- TypeScript typecheck passed.
- ESLint passed.
- 42 unit/Neovim integration tests passed.
- Existing OpenTUI PTY smoke passed.
- Updated CLI-launched Neovim PTY smoke passed using an actual Ctrl-C byte.
- Packaged executable was used for tmux remediation.

## Release assessment

The actionable Schlop failures from the initial tmux run are resolved. The Neovim flavor passes the remediation gate on the exercised Linux/tmux/Neovim 0.12.3 environment. The known compatibility boundary is that normal user configuration and plugins execute normally and may emit their own errors or require external tools.
