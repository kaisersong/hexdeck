# HexDeck

HexDeck is a tray-first Tauri desktop shell for supervising multiple local coding agents on one machine. Its primary user-facing surface is the native `activity-card` popup: a lightweight, top-of-screen card for the small number of agent events that need immediate human attention.

## Real Popup Contract

HexDeck only surfaces real native activity cards for these structured broker message types:

- `request_approval` -> `approval` card
- single-select `ask_clarification` -> `question` card
- `report_progress(stage="completed")` -> `completion` card

Popup eligibility depends on message type only. It must not depend on project name, panel project filter, or a `project=...` query parameter. Project is display metadata, not a routing gate.

## Current Behavior

- Live popups are passive by default. First show should not steal keyboard ownership from the host terminal.
- Approval and question cards are handled by explicit UI clicks, not global `y/a/n` shortcuts.
- The close affordance and native window close path dismiss the current card without leaving an empty shell behind.
- Card body text supports a safe Markdown subset: paragraphs, lists, emphasis, inline code, fenced code blocks, links, and blockquotes.

## AskUserQuestion Boundary

HexDeck currently renders one popup question card at a time.

- Supported popup shape: one structured single-select question.
- Upstream adapters may flatten `AskUserQuestion.questions[]` batches to the first supported single-select question before HexDeck sees them.
- If a terminal shows raw JSON or a native numbered menu instead of a popup card, the upstream adapter mirror or pre-tool suppression failed. That is not a HexDeck rendering success.

## Development

```bash
npm install
npm test
npm run build
npm run tauri:dev
```

## Key Docs

- [Activity Card Live Debug Runbook](docs/activity-card-live-debug-runbook.md)
- [Real Popup Completion Definition](docs/superpowers/specs/2026-04-16-real-popup-completion-definition-design.md)
- [2026-04-21 Real Popup Release Status](docs/plans/2026-04-21-real-popup-release-status.md)

## Version

Current release target: `0.2.6`
