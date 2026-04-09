# Terminal Jump Contract

This document is the consumer-side contract for homepage agent click-to-terminal jump behavior.

## Exact Locator Rules

- Ghostty exact jump must use `terminalSessionID`.
- Terminal.app exact jump must use `terminalTTY`.
- iTerm exact jump may use `sessionHint` or `terminalTTY`.
- `sessionHint` is not a primary Ghostty locator. For Ghostty it is compatibility metadata only.

## UI Rules

- Homepage agent rows are clickable only when `buildJumpTarget` resolves to `exact` or `best_effort`.
- Ghostty rows must not be treated as `exact` unless `terminalSessionID` is present.
- If Ghostty only has `projectPath`, the row may still be clickable as `best_effort`.
- `alias` is display-only. Do not derive terminal focus from alias or title matching.

## Tauri Jump Rules

- `jump_with_ghostty` must try `terminalSessionID` first.
- If no `terminalSessionID` exists, Ghostty may fall back to `projectPath`, but only as `best_effort`.
- `jump_with_terminal_app` must focus by `terminalTTY`.
- `open_project_path` is the last fallback when no supported exact locator exists.

## Regression Checklist

- Do not reintroduce alias or title matching as the main Ghostty jump path.
- Do not map Ghostty `sessionHint` back into `terminalSessionID`.
- Do not mark Ghostty rows as exact from `sessionHint` alone.
- If broker metadata becomes ambiguous, prefer degrading to `best_effort` over jumping to the wrong terminal.
