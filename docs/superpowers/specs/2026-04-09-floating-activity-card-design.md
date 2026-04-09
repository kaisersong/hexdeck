# Floating Activity Card Design

Date: 2026-04-09
Project: HexDeck
Status: Draft for review

## Summary

HexDeck will add a dedicated floating activity card surface that appears at the
top of the screen independently from the main panel window. This surface is not
part of the existing panel layout. It must still appear when the main panel is
hidden.

The first version only supports three card types:

- `approval`
- `question` with single-select options only
- `completion`

The surface shows one card at a time and uses a queue ordered by priority:

1. `approval`
2. `question`
3. `completion`

Within the same priority, cards are shown FIFO by arrival time.

## Goals

- Show urgent activity without requiring the user to open the main panel.
- Keep the main panel focused on overview and browsing.
- Allow direct jump-to-agent from the floating card.
- Support lightweight, time-bounded interaction for approvals, questions, and
  completions.

## Non-Goals

- Reworking the existing panel attention list into the floating surface
- Supporting multi-select questions
- Supporting free-text question input
- Creating a persistent inbox or notification history
- Defining a generic "important alert" card bucket

## Window Model

HexDeck currently creates a compact `panel` window in Tauri. The floating
activity card will be implemented as a separate Tauri webview window named
`activity-card`, with its own rendering surface and lifecycle.

Responsibilities:

- `panel` window: overview, browsing, settings, project navigation
- `activity-card` window: temporary top-of-screen interactive notification card

Expected behavior:

- The floating card window can appear even when the panel is hidden.
- The floating card window is responsible only for the currently active card.
- The main panel does not need to open before the user can act on a card.

## Card Types

### Approval Card

Required fields:

- `cardId`
- `summary`
- `actorLabel`
- `jumpTarget`
- `approvalId`
- `taskId?`
- `actions`

First version action set is fixed to:

- `yes`
- `always`
- `no`

Approval cards support keyboard confirmation in the floating surface. The first
version only adds keyboard shortcuts for approval cards, not for question or
completion cards.

### Question Card

Required fields:

- `cardId`
- `summary`
- `actorLabel`
- `jumpTarget`
- `questionId`
- `options`

Constraints:

- `options` is a single-select list only
- Clicking an option submits immediately
- There is no separate confirm step

### Completion Card

Required fields:

- `cardId`
- `summary`
- `actorLabel`
- `jumpTarget`
- `completedAt`

Completion cards have no confirmation action. They exist to summarize the
result and support direct jump-to-agent.

## Interaction Model

- Only one floating card is visible at a time.
- New cards are queued behind the active card.
- The user can directly jump to the agent from the floating card without going
  through the main panel.
- Hover pauses the dismissal timer.
- When hover ends, the timer resumes.

Dismissal durations:

- `approval`: 6 seconds
- `question`: 6 seconds
- `completion`: 3 seconds

Card completion behavior:

- `approval`: closes after a successful response, or dismisses the current
  presentation when its timer expires without action
- `question`: closes immediately after a successful answer submit
- `completion`: closes when the timer expires

If an `approval` or `question` card times out without user action, it does not
auto-requeue itself. The unresolved work remains discoverable through other
surfaces or future fresh events, but the dismissed card instance is considered
finished for queue purposes.

## Event Routing And Lifecycle

The floating surface must not be derived by simply re-rendering the existing
panel attention list. It needs a dedicated event-to-card pipeline.

Recommended pipeline:

1. Broker events arrive.
2. A dedicated projection function determines whether the event maps to
   `approval`, `question`, or `completion`.
3. If it maps cleanly, produce an `ActivityCardProjection`.
4. Insert the projection into the queue with priority ordering and FIFO tiebreak.
5. If no card is currently active, display the queue head immediately and show
   the `activity-card` window.
6. When the current card completes or dismisses, pop it and show the next valid
   card.

Deduplication rules:

- The queue may only contain one instance of the same `approvalId`.
- The queue may only contain one instance of the same `questionId`.
- Completion cards use a stable projection signature so replayed or refreshed
  events do not re-open the same completion card repeatedly.

Invalidation rules:

- Before showing a queued card, re-check whether it is still actionable.
- If an approval was already resolved elsewhere, discard the queued card.
- If a question was already answered elsewhere, discard the queued card.

## Component Boundaries

The implementation is split into four layers.

### 1. Projection Layer

Converts broker events into `ActivityCardProjection`.

Responsibilities:

- identify supported card-worthy events
- normalize event payloads
- exclude unsupported event shapes

### 2. Queue And State Layer

Owns queue ordering and card runtime state.

Responsibilities:

- priority ordering
- FIFO ordering within equal priority
- de-duplication
- current active card
- countdown timing
- hover pause and resume
- explicit dismiss and completion transitions

### 3. Floating Window Shell

Owns top-level Tauri window behavior.

Responsibilities:

- create or restore the floating window
- show and hide the window
- position it at the top of the screen
- keep the window visually separate from the panel
- forward user actions back into application state

### 4. Card UI Layer

Renders the active card only.

Responsibilities:

- approval actions
- question option rendering
- completion summary rendering
- jump affordance
- keyboard affordance for approval cards

## Error Handling

### Question Submit Failure

- Do not dismiss the card.
- Show a compact error state.
- Allow retry.

### Approval Response Failure

- Do not dismiss the card.
- Restore button interactivity after failure.
- Show a compact error state.

### Jump Failure

- Do not dismiss the card.
- Show a lightweight jump failure message.

### Window Absence

- If the floating window is missing unexpectedly, preserve queue state.
- On the next display attempt, recreate the window and restore the current card.

## Testing Scope

Minimum required coverage:

- projection tests for event-to-card mapping
- queue tests for priority ordering, FIFO, and de-duplication
- lifecycle tests for timing, hover pause, and dismiss transitions
- interaction tests for question click-to-submit behavior
- approval shortcut tests for `yes`, `always`, and `no`
- jump tests proving the card can jump directly to the agent
- integration coverage showing the floating card still appears when the panel is
  hidden
- regression coverage proving the old panel activity host is not used as the new
  floating card surface

## Implementation Notes

- The existing panel projection types remain independent from the new
  floating card projection model.
- The current `AttentionItemProjection` type is not a good long-term contract
  for this surface because the floating surface has different card semantics,
  interaction rules, and lifecycle state.
- The first version optimizes for getting the dedicated surface working
  end-to-end, while keeping the queue and projection boundaries clean enough to
  move more control into Rust later if needed.
