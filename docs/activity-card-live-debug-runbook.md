# Activity Card Live Debug Runbook

This note records the checks needed when validating the floating activity-card window with real broker traffic. It focuses on the only three popup kinds defined by the current design:

- `request_approval -> approval`
- `ask_clarification (single-select) -> question`
- `report_progress(stage="completed") -> completion`

Anything else is not a real popup for HexDeck and should not be used as evidence of completion.

## Rules

- For height regressions, print the measurements inside the activity-card window itself. The useful comparison is the on-window line containing `shell`, `card`, `target`, `inner`, `outer`, and `scale`.
- Do not rely on Tauri stderr alone for height debugging. Logs can prove `set_size` ran, but they do not prove the user-facing card and shell are visually aligned.
- For "real" activity-card testing, use actual broker traffic from the current participant. Do not use `preview=approval`, `preview=question`, `preview=completion`, or another project's backlog as a substitute.
- Force the debug card to the intended project with `project=hexdeck`; otherwise the All Agents fallback can select a different project participant first.
- `tauri.conf.json` currently has no `devUrl`. Even in `npm run tauri:dev`, `WebviewUrl::App(...)` reads from `dist`. After changing React/CSS that affects the activity-card window, run `npm run build` before restarting the Tauri debug window.
- Keep Codex `PreToolUse` noise filtered. Do not treat internal hook approvals as evidence that the approval popup path works.

## Completion Definition

Each popup kind counts as complete only when all three checks pass:

1. The source event is real, not preview or fixture-only.
2. Broker replay contains the designed structured event shape.
3. HexDeck actually renders the matching popup kind.

If any of the three checks fails, the popup is not complete.

## Three Real Popup Checks

### 1. Approval popup

Replay must contain a structured `request_approval` event. HexDeck should render an `approval` card with the real summary and actions.

Expected replay shape:

```json
{
  "kind": "request_approval",
  "payload": {
    "approvalId": "approval-...",
    "participantId": "claude.main",
    "body": {
      "summary": "Claude wants to run Bash."
    }
  }
}
```

### 2. Question popup

Replay must contain a structured `ask_clarification` event whose payload is single-select. HexDeck should render a `question` card, not silently drop it.

Expected replay shape:

```json
{
  "kind": "ask_clarification",
  "payload": {
    "participantId": "claude.main",
    "body": {
      "summary": "Delete file",
      "prompt": "Do you want to permanently delete this file?",
      "selectionMode": "single-select",
      "options": [
        { "value": "yes", "label": "Delete" },
        { "value": "no", "label": "Cancel" }
      ]
    }
  }
}
```

### 3. Completion popup

Replay must contain `report_progress` with `stage: "completed"`. HexDeck should render a `completion` card. `in_progress` does not count.

Expected replay shape:

```json
{
  "kind": "report_progress",
  "payload": {
    "participantId": "claude.main",
    "stage": "completed",
    "body": {
      "summary": "Claude completed the task"
    }
  }
}
```

## Live Debug Flow

1. Build the frontend assets:

```bash
npm run build
```

2. Start the Tauri activity-card debug window:

```bash
HEXDECK_ACTIVITY_CARD_PREVIEW='&debugLive=1&project=hexdeck' npm run tauri:dev
```

3. Trigger a real popup from the current participant through broker traffic.

Approval example:

```bash
curl -sS -X POST http://127.0.0.1:4318/intents \
  -H 'content-type: application/json' \
  -d '{"intentId":"intent-activity-card-real-approval-YYYYMMDD-HHMMSS","kind":"request_approval","fromParticipantId":"claude.main","taskId":"task-activity-card-real-approval-YYYYMMDD-HHMMSS","threadId":"thread-activity-card-real-approval-YYYYMMDD-HHMMSS","to":{"mode":"participant","participants":["human.local"]},"payload":{"approvalId":"approval-activity-card-real-approval-YYYYMMDD-HHMMSS","participantId":"claude.main","approvalScope":"run_command","body":{"summary":"Claude wants to run Bash."},"actions":[{"label":"Yes","decisionMode":"yes"},{"label":"Always","decisionMode":"always"},{"label":"No","decisionMode":"no"}]}}'
```

4. Verify replay before looking at UI.

Read the latest replay slice:

```bash
curl -sS 'http://127.0.0.1:4318/events/replay?after=<previous-event-id>'
```

Check approval events:

```bash
curl -sS 'http://127.0.0.1:4318/events/replay?after=<previous-event-id>' | jq '.items[]? | select(.kind=="request_approval") | {eventId, kind, taskId, threadId, payload}'
```

Check question events:

```bash
curl -sS 'http://127.0.0.1:4318/events/replay?after=<previous-event-id>' | jq '.items[]? | select(.kind=="ask_clarification") | {eventId, kind, taskId, threadId, payload}'
```

Check completion events:

```bash
curl -sS 'http://127.0.0.1:4318/events/replay?after=<previous-event-id>' | jq '.items[]? | select(.kind=="report_progress" and .payload.stage=="completed") | {eventId, kind, taskId, threadId, payload}'
```

5. Verify the popup behavior in HexDeck.

- Approval: the window shows the approval summary and action buttons.
- Question: the window shows the single-select prompt and options.
- Completion: the window shows the completed summary and does not get replaced by `in_progress`.
- If the window is blank while replay already has the structured event, the bug is in HexDeck projection or routing.
- If the window is blank and replay has no structured event, the bug is upstream in hooks, adapter, or broker mirroring.

## Capture Evidence

When visual proof is needed, capture the activity-card window itself instead of a full-screen desktop screenshot:

```bash
swift -e 'import CoreGraphics; let opts = CGWindowListOption(arrayLiteral: .optionAll); let infos = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] ?? []; for info in infos { let owner = info[kCGWindowOwnerName as String] as? String ?? ""; if owner.lowercased().contains("hexdeck"), let name = info[kCGWindowName as String] { print(info[kCGWindowNumber as String] ?? "", name, info[kCGWindowBounds as String] ?? "") } }'
screencapture -x -l <window-id> /tmp/hexdeck-activity-card-live-debug.png
```

Do not conclude the popup is blank from a full-screen screenshot until the window-only screenshot has been checked.
