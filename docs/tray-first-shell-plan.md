# HexDeck Tray-First Shell Plan

## Goal

HexDeck should behave as a lightweight desktop utility instead of a persistent desktop app window.

- macOS entrypoint: menu bar icon
- Windows entrypoint: system tray icon
- Default state: no visible main window
- Primary interaction: click tray icon to show a compact panel
- Secondary interaction: open a larger detail window only when needed

## Product Shape

### Core behavior

- App launch creates tray/menu bar presence immediately
- Main panel stays hidden until invoked from tray
- Panel closes on blur, Escape, or second tray click
- App does not keep a regular desktop window open by default
- Dock visibility on macOS should be hidden for the tray-first experience
- Taskbar presence on Windows should be suppressed for the compact panel

### Window model

#### `panel`

- Purpose: fast glance + quick action surface
- Approx size: `340 x 460`
- Characteristics:
  - undecorated
  - always on top
  - hidden by default
  - excluded from taskbar
  - invoked from tray/menu bar icon

#### `expanded`

- Purpose: logs, richer settings, larger activity or agent detail
- Approx size: `860 x 640`
- Characteristics:
  - optional
  - opens only from explicit user action
  - not required for initial launch flow

## UI Direction

The panel should follow the supplied compact dropdown direction instead of the current dashboard-like page layout.

### Panel information priority

1. critical approval or urgent activity
2. active agents grouped by project
3. broker health summary
4. quick actions

### Panel layout

- Header:
  - HexDeck label
  - live / disconnected status
  - settings affordance
- Priority card:
  - top urgent item only
  - approve / deny / jump actions
- Agent groups:
  - compact rows
  - grouped by project
  - max visible rows before scroll
- Footer:
  - logs
  - expand
  - quit

### Explicit UI constraints

- Do not optimize for a full-page desktop app layout
- Do not keep overview, now, attention, and recent as separate page sections in the compact panel
- Do not use the current main window as the primary product mental model
- Keep the compact panel dense, single-column, and tray-popover-oriented

## Technical Direction

### Tauri shell

- Use Tauri as the desktop shell directly
- Do not wrap Tauri inside a separate native app
- Create tray/menu bar entry with left-click toggle behavior
- Build the compact panel as a hidden webview window
- Hide panel on blur and intercept close requests to hide instead of destroying
- Add macOS-only activation policy and Dock visibility behavior
- Keep platform-specific behavior isolated in the shell layer

### Frontend structure

- Reuse broker client and projection logic
- Rebuild the top-level app composition around the compact panel
- Convert activity card into the first card inside the panel body
- Move large settings flows and logs into the future `expanded` window

## Phased Implementation

### Phase 1: shell baseline

- convert startup to tray-first
- create hidden `panel` window
- add tray icon with open / quit actions
- toggle panel from tray click
- hide panel on blur

### Phase 2: compact panel UI

- replace current panel route with dropdown-style single-column layout
- compress activity, agents, broker status, and actions into compact sections
- reduce settings entry in compact panel to a secondary view or route

### Phase 3: expanded window

- introduce optional larger detail window
- route logs, richer settings, and larger lists there

### Phase 4: polish

- tray-anchor positioning
- Escape-to-close
- platform-specific shortcuts
- autostart
- notification and update UX cleanup

## Working Agreement

All future desktop-shell changes should preserve these rules unless the product shape is intentionally changed:

- tray/menu bar first
- no always-open main app window
- compact panel as the default surface
- expanded window only for overflow use cases
