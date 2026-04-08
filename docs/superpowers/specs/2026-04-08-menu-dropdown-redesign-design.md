# HexDeck Menu Dropdown Redesign

Date: 2026-04-08
Status: Proposed and approved at the approach level (`C`: full panel redraw)

## Goal

Replace the current tray dropdown panel with a visually intentional compact control surface that matches the supplied `updated_menu_dropdown` prototype much more closely.

The current implementation already has the right data and broad information architecture, but it fails visually because the presentational layer is largely disconnected from the markup. The redesign should treat the panel as a new compact product surface rather than a lightly restyled list.

## Scope

In scope:

- Redraw the tray dropdown panel UI in [`src/app/routes/panel.tsx`](../../../src/app/routes/panel.tsx)
- Rebuild the dropdown-specific stylesheet in [`src/styles/panel.css`](../../../src/styles/panel.css)
- Preserve existing broker-backed content:
  - project grouping
  - per-agent state pills
  - open main panel action
  - settings/logs entry point
  - attention banner
- Preserve current empty-state behavior, but redesign its presentation
- Rebuild the macOS bundle used for manual testing

Out of scope:

- Changing broker data fetch paths
- Changing project grouping semantics
- Adding new broker endpoints
- Reworking the expanded/main panel
- Adding new routes or settings surfaces

## Product Intent

The dropdown should feel like a dense, high-signal command surface for local multi-agent work. It is not a generic preferences popover and not a mini dashboard card grid. The visual impression should be:

- compact
- dark and glassy
- high hierarchy
- operational, not decorative
- legible at a glance

The primary user action is still to inspect project groups quickly and jump to the main panel when deeper control is needed.

## Architecture

The panel will remain a single route component fed by existing projection data. The change is architectural only at the view-composition layer:

1. Keep `buildProjectGroups()` as the source of grouped agent data.
2. Replace the current dropdown DOM with a new structure optimized for the prototype layout.
3. Keep all behavioral callbacks (`onJump`, `onOpenExpanded`, `onOpenSettings`, `onMinimize`, `onClose`) intact.
4. Keep styling local to the existing panel stylesheet, but treat the dropdown section as its own complete visual system.

This preserves data and behavior while allowing a near-total re-layout of the tray surface.

## Component Design

### 1. Shell

The dropdown becomes a compact card with:

- ~320px width target
- deep dark layered background
- subtle translucent border
- strong outer shadow
- soft blue glow behind the shell
- tighter vertical rhythm than the current implementation

### 2. Header

Header contains:

- left: `HEXDECK PRO`
- right: live status chip plus settings button

The live chip is real status, driven from `brokerLive || snapshot.overview.brokerHealthy`. If broker is not healthy, the chip should shift to a degraded visual state rather than disappearing.

### 3. Project Groups

Each project group is rendered as a thin section, not a nested card. It contains:

- uppercase project label
- right-aligned meta (`x Active` or `x Agents`)
- dense list of agent rows

Groups should be visually separated by very light dividers and spacing, not heavy borders.

### 4. Agent Rows

Each row is the dominant repeating pattern. Requirements:

- single compact horizontal row
- left status dot + alias
- right state pill
- hover and focus feedback for jumpable rows
- disabled appearance for rows without jump targets

Tone mapping:

- `working`: blue, visually active
- `blocked`: warm/orange warning tone
- `idle`: low-contrast gray

### 5. Attention Surface

The attention banner remains supported but should be visually integrated between the group list and primary action. It should read as a compact operational notice, not a full warning block.

### 6. Primary Action

The bottom CTA remains `Open Main Panel`, but is redesigned as:

- full-width gradient button
- left icon + label
- right arrow affordance
- slightly raised visual hierarchy over the rest of the card

### 7. Footer

Footer becomes a low-profile status strip:

- left: `Agents` metric and `Broker` metric
- right: `Logs` action
- compressed typography
- subtle divider treatment

## Data Flow

No data-flow changes are required.

- The route continues receiving `snapshot`, `participants`, `currentProject`, and `brokerLive`.
- Grouping still comes from `buildProjectGroups()`.
- Agent state labels still derive from `snapshot.now`.
- The footer metrics still derive from `snapshot.overview`.

The redesign is intentionally view-only so that current broker fixes remain stable.

## Error Handling and Edge Cases

- If there are no groups, show a styled empty-state section using the current project name.
- If broker status is degraded, reflect that in the live chip and footer.
- Long project names and aliases should truncate cleanly instead of wrapping the panel wide.
- If an agent row has no jump target, it must still render with clear disabled styling and no misleading hover affordance.
- Attention banner should collapse entirely when there are no attention items.

## Testing Plan

Automated:

- Keep existing broker client/runtime tests green
- Run UI/unit test suite (`npm test`)
- Run Rust compile validation (`cargo check`)

Manual:

- Rebuild the bundle at `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/HexDeck.app`
- Verify in the dropdown that:
  - live chip matches broker health
  - multiple project groups render correctly
  - idle/working/blocked tones are visually distinct
  - footer metrics are readable
  - empty state still looks intentional

## Implementation Notes

- Prioritize a full redraw of the dropdown markup over incremental patching.
- Avoid introducing a separate component tree unless the existing file becomes materially clearer by extracting one or two subcomponents.
- Preserve current event wiring.
- Keep the solution ASCII-only.

## Success Criteria

The redesign is successful if all of the following are true:

- the dropdown no longer looks like fallback/raw HTML
- the visual hierarchy clearly matches the supplied prototype direction
- the agent list remains compact and readable with multiple groups
- all current broker-backed content still appears correctly
- the chosen test bundle launches with the new UI
