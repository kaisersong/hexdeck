#!/bin/bash
# Automated test for HexDeck approval detection
# Uses python3 for proper JSON parsing

python3 - << 'PYEOF'
import json, os, glob, re
from pathlib import Path

# Step 1: Check runtime state
runtime_files = sorted(glob.glob(os.path.expanduser("~/.intent-broker/codex/*.runtime.json")), key=os.path.getmtime, reverse=True)
if not runtime_files:
    print("ERROR: No runtime.json files found")
    exit(1)

runtime_file = runtime_files[0]
print(f"Runtime file: {runtime_file}")

with open(runtime_file) as f:
    runtime = json.load(f)

status = runtime.get("status", "")
session_id = runtime.get("sessionId", "")
terminal_app = runtime.get("terminalApp", "")
terminal_session_id = runtime.get("terminalSessionID", "")
updated_at = runtime.get("updatedAt", "")
project_path = runtime.get("projectPath", "")

print(f"  status: {status}")
print(f"  sessionId: {session_id}")
print(f"  terminalApp: {terminal_app}")
print(f"  terminalSessionID: {terminal_session_id}")
print(f"  updatedAt: {updated_at}")
print(f"  projectPath: {project_path}")
print()

# Step 2: Check runtime conditions
conditions_met = True
checks = {
    "status running": status == "running",
    "has sessionId": bool(session_id and session_id.strip()),
    "terminalApp contains ghostty": "ghostty" in terminal_app.lower() if terminal_app else False,
    "has terminalSessionID": bool(terminal_session_id and terminal_session_id.strip())
}

for check_name, result in checks.items():
    status_str = "PASS" if result else "FAIL"
    if not result:
        conditions_met = False
    print(f"  [{status_str}] {check_name}")

print()

# Step 3: Find transcript file
if session_id:
    codex_sessions = Path.home() / ".codex" / "sessions"
    print(f"Searching for transcript in: {codex_sessions}")

    transcript_files = list(codex_sessions.rglob(f"*{session_id}*.jsonl"))
    transcript_file = transcript_files[0] if transcript_files else None

    if transcript_file:
        print(f"Transcript file: {transcript_file}")
        print(f"  Size: {transcript_file.stat().st_size} bytes")

        # Step 4: Check for approval calls
        approval_calls = []
        with open(transcript_file) as tf:
            for line in tf:
                if "require_escalated" in line:
                    try:
                        entry = json.loads(line)
                        payload = entry.get("payload", {})
                        if payload.get("name") == "exec_command":
                            args = json.loads(payload.get("arguments", "{}"))
                            if args.get("sandbox_permissions") == "require_escalated":
                                approval_calls.append({
                                    "call_id": payload.get("call_id"),
                                    "command": args.get("cmd"),
                                    "justification": args.get("justification"),
                                    "timestamp": entry.get("timestamp")
                                })
                    except Exception:
                        pass

        print(f"  Approval calls found: {len(approval_calls)}")
        for i, call in enumerate(approval_calls):
            print(f"    [{i+1}] call_id: {call['call_id']}")
            print(f"        command: {call['command']}")
            print(f"        justification: {call['justification']}")
            print(f"        timestamp: {call['timestamp']}")

        checks["has approval calls"] = len(approval_calls) > 0
    else:
        print("ERROR: No transcript file found")

print()

# Step 5: Check HexDeck diagnostics
diag_path = None
for root, dirs, files in os.walk("/var/folders"):
    if "hexdeck-activity-card-diagnostics.log" in files:
        diag_path = os.path.join(root, "hexdeck-activity-card-diagnostics.log")
        break

if diag_path:
    print(f"Diagnostics log: {diag_path}")
    print(f"  Size: {os.path.getsize(diag_path)} bytes")

    with open(diag_path) as log:
        lines = log.readlines()
        watcher_alive = any("watcher/loop/alive" in line for line in lines[-200:])
        approval_detected = any("broker/local-approvals" in line and "total=1" in line for line in lines[-500:])
        approval_shown = any("show=ok" in line for line in lines[-500:])

        print(f"  [{'PASS' if watcher_alive else 'FAIL'}] Watcher running")
        print(f"  [{'PASS' if approval_detected else 'WARN'}] Approval detected in history")
        print(f"  [{'PASS' if approval_shown else 'WARN'}] Window shown")

        # Show recent approval detection status
        print("  Recent approval detection:")
        for line in reversed(lines[-100:]):
            if "broker/local-approvals" in line:
                match = re.search(r"total=(\d+)", line)
                if match:
                    print(f"    {match.group(0)}")
                    break
else:
    print("Diagnostics log not found - HexDeck watcher may not be running")

print()

# Summary
print("=" * 50)
all_checks = list(checks.items()) + [
    ("watcher running", any("watcher/loop/alive" in line for line in lines[-200:])),
]
all_passed = all(r for _, r in all_checks)

if all_passed:
    print("RESULT: PASS - All conditions met")
else:
    print("RESULT: FAIL - Some conditions not met")
    for name, result in all_checks:
        if not result:
            print(f"  - {name}")
PYEOF
