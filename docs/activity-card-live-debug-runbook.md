# Activity Card Live Debug Runbook

This note records the checks needed when validating the floating activity-card window with real broker traffic. It exists because the same mistakes are easy to repeat: looking only at Tauri logs, using a fake/local preview card, forgetting that Tauri reads `dist`, and placing the popup on the wrong monitor.

## Rules

- For height regressions, print the measurements inside the activity-card window itself. The useful comparison is the on-window line containing `shell`, `card`, `target`, `inner`, `outer`, and `scale`.
- Do not rely on Tauri stderr alone for height debugging. Logs can prove `set_size` ran, but they do not prove the user-facing card and shell are visually aligned.
- For "real" activity-card testing, send an actual `request_approval` from the current Codex participant through intent-broker. Do not use `preview=approval` or another project's backlog as a substitute.
- Force the debug card to the intended project with `project=hexdeck`; otherwise the All Agents fallback can select a different project participant first.
- `tauri.conf.json` currently has no `devUrl`. Even in `npm run tauri:dev`, `WebviewUrl::App(...)` reads from `dist`. After changing React/CSS that affects the activity-card window, run `npm run build` before restarting the Tauri debug window.
- The debug popup should use the built-in/notch display. Prefer the monitor whose work-area origin is `(0, 0)` and account for monitor `scaleFactor` when converting the 680px logical window width to physical positioning.
- When taking evidence screenshots on a busy desktop, capture the activity-card window itself via its CoreGraphics window id. Full-screen screenshots can be misleading when meeting overlays or browser chrome sit under the transparent window.

## Live Debug Flow

1. Build the frontend assets:

```bash
npm run build
```

2. Start the Tauri activity-card debug window:

```bash
HEXDECK_ACTIVITY_CARD_PREVIEW='&debugLive=1&project=hexdeck' npm run tauri:dev
```

3. Send a real broker approval from the active Codex participant:

```bash
curl -sS -X POST http://127.0.0.1:4318/intents \
  -H 'content-type: application/json' \
  -d '{"intentId":"intent-activity-card-real-codex-debug-YYYYMMDD-HHMMSS","kind":"request_approval","fromParticipantId":"codex-session-019d7b93","taskId":"task-activity-card-real-codex-debug-YYYYMMDD-HHMMSS","threadId":"thread-activity-card-real-codex-debug-YYYYMMDD-HHMMSS","to":{"mode":"participant","participants":["human.local"]},"payload":{"approvalId":"approval-activity-card-real-codex-debug-YYYYMMDD-HHMMSS","approvalScope":"run_command","body":{"summary":"真实 Codex 确认项：活动卡 live debug 验证","detailText":"这条确认项来自当前 Codex participant，经 intent-broker 传给 hexdeck 活动卡。窗体底部应显示 shell/card/target/inner/outer/scale 与 project/cards/active/latest。","commandTitle":"Codex","commandLine":"codex verifies the real activity-card broker flow","commandPreview":"activity-card broker live verification"},"actions":[{"label":"允许","decisionMode":"yes"},{"label":"始终允许","decisionMode":"always"},{"label":"拒绝","decisionMode":"no"}]}}'
```

4. Verify broker replay has the real request:

```bash
curl -sS 'http://127.0.0.1:4318/events/replay?after=<previous-event-id>'
```

The request should have:

- `kind: "request_approval"`
- `fromParticipantId` equal to the current Codex participant
- `fromProjectName: "hexdeck"`
- `payload.participantId` equal to the same Codex participant

5. Verify the window behavior:

- Empty/debug state is 680x152 logical.
- Real approval content state expands to the measured card height, for example 680x238 logical on a 2x display when logs show `inner/outer` height `476`.
- After the user clicks an action, broker replay should contain `respond_approval` for the same `approvalId`, and the window should return to 680x152.

6. Capture the window itself when visual proof is needed:

```bash
swift -e 'import CoreGraphics; let opts = CGWindowListOption(arrayLiteral: .optionAll); let infos = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] ?? []; for info in infos { let owner = info[kCGWindowOwnerName as String] as? String ?? ""; if owner.lowercased().contains("hexdeck"), let name = info[kCGWindowName as String] { print(info[kCGWindowNumber as String] ?? "", name, info[kCGWindowBounds as String] ?? "") } }'
screencapture -x -l <window-id> /tmp/hexdeck-activity-card-live-debug.png
```

Do not conclude the popup is blank from a full-screen screenshot until the window-only screenshot has been checked.
