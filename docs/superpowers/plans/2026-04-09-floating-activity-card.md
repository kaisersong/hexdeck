# Floating Activity Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dedicated top-of-screen floating activity-card window that can surface queued approval, single-select question, and completion cards even when the main panel is hidden.

**Architecture:** Normalize broker replay data into a dedicated `ActivityCardProjection` queue, store the active card and its timer state in app state, and render the queue head inside a separate Tauri `activity-card` window. Route `approval` actions back through the existing approval response path, route `question` answers through broker `answer_clarification` intents, and keep the panel snapshot types independent from the floating-card types. This plan also closes two existing contract gaps: broker replay events must tolerate `kind` as well as `type`, and the current Tauri window API surface referenced by `App.tsx` must be made real before adding the new floating window.

**Tech Stack:** React 19, TypeScript, Vitest, Tauri 2, Rust, intent-broker HTTP API

---

## File Structure

- Create: `src/lib/activity-card/types.ts` - standalone floating-card contracts and helper literals
- Create: `src/lib/activity-card/projections.ts` - broker replay to `ActivityCardProjection[]` mapping
- Create: `src/lib/activity-card/store.ts` - queue ordering, de-duplication, timers, hover pause, active-card lifecycle
- Create: `src/app/routes/activity-card.tsx` - top-level route for the floating `activity-card` window
- Create: `src/features/activity-card/FloatingActivityCard.tsx` - visual card shell with per-kind rendering and timers
- Create: `tests/lib/activity-card/projections.test.ts` - projection behavior coverage
- Create: `tests/lib/activity-card/store.test.ts` - queue/timer/de-duplication coverage
- Create: `tests/features/activity-card/activity-card.test.tsx` - UI behavior coverage
- Modify: `src/lib/broker/types.ts` - enrich broker event/approval/clarification transport contracts
- Modify: `src/lib/broker/client.ts` - normalize replay events and add clarification answer transport
- Modify: `src/lib/store/app-store.ts` - store floating-card queue state alongside current snapshot state
- Modify: `src/lib/store/use-app-store.ts` - no API change, but verify it still creates the richer store once
- Modify: `src/app/App.tsx` - route `view=activity-card`, wire store updates, refresh queue from broker data
- Modify: `src/features/activity-card/ActivityCardHost.tsx` - reduce this panel host to legacy/panel-only behavior or remove its top-priority responsibilities
- Modify: `tests/lib/broker/client.test.ts` - broker normalization and clarification transport tests
- Modify: `src-tauri/src/main.rs` - add concrete window commands and create/show/hide the floating window
- Modify: `src-tauri/tauri.conf.json` - keep app window list empty, but verify config still matches runtime-created windows

## Task 1: Normalize Broker Replay And Add Floating-Card Projection Types

**Files:**
- Create: `src/lib/activity-card/types.ts`
- Create: `src/lib/activity-card/projections.ts`
- Modify: `src/lib/broker/types.ts`
- Modify: `src/lib/broker/client.ts`
- Test: `tests/lib/activity-card/projections.test.ts`
- Test: `tests/lib/broker/client.test.ts`

- [ ] **Step 1: Write the failing tests for replay normalization and projection mapping**

```ts
import { describe, expect, it } from 'vitest';
import { buildActivityCardsFromSeed } from '../../../src/lib/activity-card/projections';

describe('buildActivityCardsFromSeed', () => {
  it('maps pending approvals, single-select clarifications, and completed progress into cards', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [
        {
          participantId: 'agent-1',
          alias: 'codex3',
          kind: 'agent',
          tool: 'codex',
          metadata: { terminalApp: 'Ghostty', terminalSessionID: 'ghostty-1', projectPath: '/tmp/hexdeck' },
          context: { projectName: 'HexDeck' },
        },
      ],
      workStates: [],
      approvals: [
        { approvalId: 'approval-1', taskId: 'task-1', summary: 'Ship the patch?', decision: 'pending' },
      ],
      events: [
        {
          id: 10,
          type: 'ask_clarification',
          taskId: 'task-2',
          threadId: 'thread-2',
          payload: {
            participantId: 'agent-1',
            body: { summary: 'Which target?' },
            question: {
              questionId: 'question-1',
              options: [
                { label: 'staging', value: 'staging' },
                { label: 'prod', value: 'prod' },
              ],
              multiSelect: false,
            },
          },
        },
        {
          id: 11,
          type: 'report_progress',
          taskId: 'task-3',
          payload: {
            participantId: 'agent-1',
            stage: 'completed',
            body: { summary: 'Finished rollout tracking slice.' },
          },
        },
      ],
    });

    expect(cards.map((card) => card.kind)).toEqual(['approval', 'question', 'completion']);
    expect(cards[1]).toMatchObject({
      kind: 'question',
      questionId: 'question-1',
      options: [
        { label: 'staging', value: 'staging' },
        { label: 'prod', value: 'prod' },
      ],
    });
  });
});
```

```ts
it('normalizes replay items that arrive with kind instead of type', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ participants: [] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ participants: [] }), { status: 200 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [{ id: 7, kind: 'ask_clarification', payload: { body: { summary: 'Need input' } } }] }), {
        status: 200,
      })
    );

  const client = new BrokerClient({ brokerUrl: 'http://127.0.0.1:4318', fetchImpl: fetchMock as typeof fetch });
  const snapshot = await client.loadServiceSeed();

  expect(snapshot.events).toEqual([
    { id: 7, type: 'ask_clarification', payload: { body: { summary: 'Need input' } } },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/activity-card/projections.test.ts tests/lib/broker/client.test.ts`

Expected: FAIL with missing `buildActivityCardsFromSeed`, missing `ActivityCardProjection` types, and replay normalization assertions failing.

- [ ] **Step 3: Implement the broker and floating-card contracts**

```ts
// src/lib/broker/types.ts
export interface BrokerQuestionOption {
  label: string;
  value: string;
}

export interface BrokerQuestionPayload {
  questionId: string;
  options: BrokerQuestionOption[];
  multiSelect?: boolean;
}

export interface BrokerEvent {
  id: number;
  type: string;
  taskId?: string;
  threadId?: string;
  createdAt?: string;
  payload?: Record<string, unknown> & {
    participantId?: string;
    stage?: string;
    body?: { summary?: string };
    question?: BrokerQuestionPayload;
  };
}
```

```ts
// src/lib/activity-card/types.ts
import type { JumpTarget } from '../jump/types';

export type ActivityCardKind = 'approval' | 'question' | 'completion';
export type ActivityCardPriority = 3 | 2 | 1;
export type ApprovalActionMode = 'yes' | 'always' | 'no';

export interface ActivityCardBase {
  cardId: string;
  kind: ActivityCardKind;
  priority: ActivityCardPriority;
  summary: string;
  actorLabel?: string;
  jumpTarget?: JumpTarget | null;
  taskId?: string;
  threadId?: string;
  createdAtMs: number;
}

export interface ApprovalActivityCard extends ActivityCardBase {
  kind: 'approval';
  approvalId: string;
  actions: ApprovalActionMode[];
}

export interface QuestionActivityCard extends ActivityCardBase {
  kind: 'question';
  questionId: string;
  options: Array<{ label: string; value: string }>;
}

export interface CompletionActivityCard extends ActivityCardBase {
  kind: 'completion';
  completedAt: string;
  eventId: number;
}

export type ActivityCardProjection =
  | ApprovalActivityCard
  | QuestionActivityCard
  | CompletionActivityCard;
```

```ts
// src/lib/broker/client.ts
function normalizeBrokerEvent(value: unknown): BrokerEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === 'number' ? candidate.id : null;
  const type = typeof candidate.type === 'string'
    ? candidate.type
    : typeof candidate.kind === 'string'
      ? candidate.kind
      : null;

  if (!id || !type) {
    return null;
  }

  return {
    id,
    type,
    taskId: typeof candidate.taskId === 'string' ? candidate.taskId : undefined,
    threadId: typeof candidate.threadId === 'string' ? candidate.threadId : undefined,
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : undefined,
    payload: typeof candidate.payload === 'object' && candidate.payload !== null ? candidate.payload as BrokerEvent['payload'] : undefined,
  };
}
```

```ts
// src/lib/activity-card/projections.ts
export function buildActivityCardsFromSeed(seed: ProjectSeed): ActivityCardProjection[] {
  const cards: ActivityCardProjection[] = [];

  for (const approval of seed.approvals) {
    if ((approval.decision ?? 'pending') !== 'pending') continue;
    cards.push({
      cardId: `approval:${approval.approvalId}`,
      kind: 'approval',
      priority: 3,
      summary: approval.summary ?? 'Approval requested',
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      createdAtMs: 0,
      actions: ['yes', 'always', 'no'],
    });
  }

  for (const event of seed.events) {
    if (event.type === 'ask_clarification') {
      const question = event.payload?.question;
      if (!question || question.multiSelect || !Array.isArray(question.options) || question.options.length === 0) continue;
      cards.push({
        cardId: `question:${question.questionId}`,
        kind: 'question',
        priority: 2,
        summary: event.payload?.body?.summary ?? 'Answer needed',
        questionId: question.questionId,
        options: question.options,
        taskId: event.taskId,
        threadId: event.threadId,
        createdAtMs: Number(event.id),
      });
      continue;
    }

    if (event.type === 'report_progress' && event.payload?.stage === 'completed') {
      cards.push({
        cardId: `completion:${event.id}`,
        kind: 'completion',
        priority: 1,
        summary: event.payload?.body?.summary ?? 'Task completed',
        eventId: event.id,
        taskId: event.taskId,
        threadId: event.threadId,
        completedAt: event.createdAt ?? String(event.id),
        createdAtMs: Number(event.id),
      });
    }
  }

  return cards;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/activity-card/projections.test.ts tests/lib/broker/client.test.ts`

Expected: PASS with projection order `approval -> question -> completion` and replay `kind -> type` normalization working.

- [ ] **Step 5: Commit**

```bash
git add src/lib/broker/types.ts src/lib/broker/client.ts src/lib/activity-card/types.ts src/lib/activity-card/projections.ts tests/lib/activity-card/projections.test.ts tests/lib/broker/client.test.ts
git commit -m "feat: add floating activity card projections"
```

## Task 2: Add Queue Store, Timer Rules, And De-Duplication

**Files:**
- Create: `src/lib/activity-card/store.ts`
- Modify: `src/lib/store/app-store.ts`
- Test: `tests/lib/activity-card/store.test.ts`
- Test: `tests/lib/store/app-store.test.ts`

- [ ] **Step 1: Write the failing tests for queue order, timeout, and hover pause**

```ts
import { describe, expect, it } from 'vitest';
import { createActivityCardStore } from '../../../src/lib/activity-card/store';

const approval = {
  cardId: 'approval:1',
  kind: 'approval',
  priority: 3,
  summary: 'Approval requested',
  approvalId: 'approval-1',
  actions: ['yes', 'always', 'no'],
  createdAtMs: 1,
};

const question = {
  cardId: 'question:1',
  kind: 'question',
  priority: 2,
  summary: 'Which target?',
  questionId: 'question-1',
  options: [{ label: 'staging', value: 'staging' }],
  createdAtMs: 2,
};

describe('createActivityCardStore', () => {
  it('keeps one active card and sorts queued cards by priority then FIFO', () => {
    const store = createActivityCardStore();

    store.replaceQueue([question, approval], 1_000);

    expect(store.getState().activeCard?.cardId).toBe('approval:1');
    expect(store.getState().queue.map((item) => item.cardId)).toEqual(['question:1']);
  });

  it('pauses timeout while hovering and dismisses after hover ends', () => {
    const store = createActivityCardStore();
    store.replaceQueue([approval], 0);

    store.setHovered(true, 5_500);
    store.tick(6_500);
    expect(store.getState().activeCard?.cardId).toBe('approval:1');

    store.setHovered(false, 6_500);
    store.tick(7_100);
    expect(store.getState().activeCard).toBeNull();
  });

  it('does not requeue a timed-out approval card automatically', () => {
    const store = createActivityCardStore();
    store.replaceQueue([approval], 0);
    store.tick(7_000);

    expect(store.getState().activeCard).toBeNull();
    expect(store.getState().queue).toEqual([]);
    expect(store.getState().dismissedCardIds.has('approval:1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/activity-card/store.test.ts tests/lib/store/app-store.test.ts`

Expected: FAIL with missing `createActivityCardStore`, missing queue state on `AppStore`, and missing hover/timer behavior.

- [ ] **Step 3: Implement the queue store and wire it into the app store**

```ts
// src/lib/activity-card/store.ts
const DURATION_MS = {
  approval: 6_000,
  question: 6_000,
  completion: 3_000,
} as const;

export interface ActivityCardRuntimeState {
  activeCard: ActivityCardProjection | null;
  queue: ActivityCardProjection[];
  activeSinceMs: number | null;
  hovered: boolean;
  pausedRemainingMs: number | null;
  dismissedCardIds: Set<string>;
}

export function createActivityCardStore() {
  const state: ActivityCardRuntimeState = {
    activeCard: null,
    queue: [],
    activeSinceMs: null,
    hovered: false,
    pausedRemainingMs: null,
    dismissedCardIds: new Set(),
  };

  function activateNext(nowMs: number) {
    state.activeCard = state.queue.shift() ?? null;
    state.activeSinceMs = state.activeCard ? nowMs : null;
    state.hovered = false;
    state.pausedRemainingMs = null;
  }

  return {
    getState: () => state,
    replaceQueue(cards: ActivityCardProjection[], nowMs: number) {
      const deduped = dedupeAndSort(cards.filter((card) => !state.dismissedCardIds.has(card.cardId)));
      state.queue = deduped;
      if (!state.activeCard) activateNext(nowMs);
    },
    setHovered(nextHovered: boolean, nowMs: number) {
      if (!state.activeCard) return;
      if (nextHovered && !state.hovered) {
        const elapsed = nowMs - (state.activeSinceMs ?? nowMs);
        state.pausedRemainingMs = Math.max(DURATION_MS[state.activeCard.kind] - elapsed, 0);
      }
      if (!nextHovered && state.hovered && state.pausedRemainingMs != null) {
        state.activeSinceMs = nowMs - (DURATION_MS[state.activeCard.kind] - state.pausedRemainingMs);
      }
      state.hovered = nextHovered;
    },
    tick(nowMs: number) {
      if (!state.activeCard || state.hovered) return;
      const elapsed = nowMs - (state.activeSinceMs ?? nowMs);
      if (elapsed < DURATION_MS[state.activeCard.kind]) return;
      state.dismissedCardIds.add(state.activeCard.cardId);
      activateNext(nowMs);
    },
    completeActiveCard(nowMs: number) {
      if (!state.activeCard) return;
      state.dismissedCardIds.add(state.activeCard.cardId);
      activateNext(nowMs);
    },
  };
}
```

```ts
// src/lib/store/app-store.ts
export interface AppState {
  snapshot: ProjectSnapshotProjection | null;
  pendingApprovalIds: Set<string>;
  activityCards: ReturnType<typeof createActivityCardStore>['getState'];
}

export interface AppStore {
  getState(): AppState;
  setSnapshot(snapshot: ProjectSnapshotProjection): void;
  replaceActivityCards(cards: ActivityCardProjection[], nowMs: number): void;
  tickActivityCards(nowMs: number): void;
  setActivityCardHovered(hovered: boolean, nowMs: number): void;
  completeActivityCard(nowMs: number): void;
  startApprovalAction(approvalId: string): void;
  finishApprovalAction(approvalId: string): void;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/activity-card/store.test.ts tests/lib/store/app-store.test.ts`

Expected: PASS with one-active-card behavior, hover pause, and timeout-without-auto-requeue covered.

- [ ] **Step 5: Commit**

```bash
git add src/lib/activity-card/store.ts src/lib/store/app-store.ts tests/lib/activity-card/store.test.ts tests/lib/store/app-store.test.ts
git commit -m "feat: add activity card queue store"
```

## Task 3: Add Broker Action Transport For Question Answers And Richer Approval Modes

**Files:**
- Modify: `src/lib/broker/types.ts`
- Modify: `src/lib/broker/client.ts`
- Modify: `src/app/App.tsx`
- Modify: `tests/lib/broker/client.test.ts`
- Test: `tests/features/activity-card/activity-card.test.tsx`

- [ ] **Step 1: Write the failing tests for clarification answers and approval action modes**

```ts
it('posts answer_clarification intents for question replies', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ eventId: 22 }), { status: 202 }));
  const client = new BrokerClient({ brokerUrl: 'http://127.0.0.1:4318', fetchImpl: fetchMock as typeof fetch });

  await client.answerClarification({
    questionId: 'question-1',
    taskId: 'task-2',
    threadId: 'thread-2',
    fromParticipantId: 'human.local',
    toParticipantId: 'agent-1',
    label: 'staging',
    value: 'staging',
  });

  expect(fetchMock).toHaveBeenCalledWith(
    'http://127.0.0.1:4318/intents',
    expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"kind":"answer_clarification"'),
    })
  );
});
```

```tsx
it('invokes the always approval mode separately from yes/no', () => {
  const onApprovalAction = vi.fn();
  render(
    <FloatingActivityCard
      card={{
        cardId: 'approval:1',
        kind: 'approval',
        priority: 3,
        summary: 'Ship it?',
        approvalId: 'approval-1',
        actions: ['yes', 'always', 'no'],
        createdAtMs: 1,
      }}
      onApprovalAction={onApprovalAction}
    />
  );

  fireEvent.click(screen.getByRole('button', { name: 'Always' }));
  expect(onApprovalAction).toHaveBeenCalledWith('approval-1', 'always');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/broker/client.test.ts tests/features/activity-card/activity-card.test.tsx`

Expected: FAIL with missing `answerClarification`, missing `Always` action mode, and missing card callbacks.

- [ ] **Step 3: Implement broker transport and app-level action handlers**

```ts
// src/lib/broker/types.ts
export interface BrokerClarificationAnswerInput {
  questionId: string;
  taskId: string;
  threadId?: string;
  fromParticipantId: string;
  toParticipantId: string;
  label: string;
  value: string;
}

export interface BrokerApprovalResponseInput {
  approvalId: string;
  taskId: string;
  fromParticipantId: string;
  decision: 'approved' | 'denied';
  decisionMode?: 'yes' | 'always' | 'no';
}
```

```ts
// src/lib/broker/client.ts
async answerClarification(input: BrokerClarificationAnswerInput): Promise<void> {
  const body = JSON.stringify({
    intentId: `answer-${input.questionId}-${Date.now()}`,
    kind: 'answer_clarification',
    fromParticipantId: input.fromParticipantId,
    taskId: input.taskId,
    threadId: input.threadId,
    to: { mode: 'participant', participants: [input.toParticipantId] },
    payload: {
      questionId: input.questionId,
      body: {
        summary: `Answered ${input.label}`,
        answer: input.value,
      },
    },
  });

  const response = await this.fetchImpl(`${this.brokerUrl}/intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  if (!response.ok) {
    throw new Error(`broker_clarification_failed ${response.status}`);
  }
}
```

```ts
// src/app/App.tsx
const respondToApproval = async (
  approvalId: string,
  taskId: string | undefined,
  mode: 'yes' | 'always' | 'no'
) => {
  if (!taskId) return;

  await client.respondToApproval({
    approvalId,
    taskId,
    fromParticipantId: 'human.local',
    decision: mode === 'no' ? 'denied' : 'approved',
    decisionMode: mode,
  });
};
```

Note: `decisionMode: 'always'` is intentionally transported as extra metadata now. `intent-broker` already accepts generic JSON payloads on `/intents`, but the `/approvals/{id}/respond` helper path currently only models `approved/denied`. HexDeck should ship the richer client-side contract now so the UI and shortcuts are stable, then align broker-side persistence of `always` semantics in the parallel broker repo work.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/broker/client.test.ts tests/features/activity-card/activity-card.test.tsx`

Expected: PASS with `answer_clarification` posting through `/intents` and `Always` treated as a distinct UI action mode.

- [ ] **Step 5: Commit**

```bash
git add src/lib/broker/types.ts src/lib/broker/client.ts src/app/App.tsx tests/lib/broker/client.test.ts tests/features/activity-card/activity-card.test.tsx
git commit -m "feat: add floating card action transport"
```

## Task 4: Build The React Floating Card Route And Integrate It Into App State

**Files:**
- Create: `src/app/routes/activity-card.tsx`
- Create: `src/features/activity-card/FloatingActivityCard.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/features/activity-card/ActivityCardHost.tsx`
- Modify: `src/styles/panel.css`
- Test: `tests/features/activity-card/activity-card.test.tsx`

- [ ] **Step 1: Write the failing route and UI tests**

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActivityCardRoute } from '../../../src/app/routes/activity-card';

describe('ActivityCardRoute', () => {
  it('renders approval cards with Yes, Always, and No actions', () => {
    render(
      <ActivityCardRoute
        card={{
          cardId: 'approval:1',
          kind: 'approval',
          priority: 3,
          summary: 'Ship it?',
          approvalId: 'approval-1',
          actions: ['yes', 'always', 'no'],
          createdAtMs: 1,
        }}
      />
    );

    expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Always' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No' })).toBeInTheDocument();
  });

  it('submits single-select question answers immediately', () => {
    const onQuestionAnswer = vi.fn();
    render(
      <ActivityCardRoute
        card={{
          cardId: 'question:1',
          kind: 'question',
          priority: 2,
          summary: 'Which target?',
          questionId: 'question-1',
          options: [{ label: 'staging', value: 'staging' }],
          createdAtMs: 1,
        }}
        onQuestionAnswer={onQuestionAnswer}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'staging' }));
    expect(onQuestionAnswer).toHaveBeenCalledWith('question-1', 'staging', 'staging');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/features/activity-card/activity-card.test.tsx`

Expected: FAIL because `ActivityCardRoute` and `FloatingActivityCard` do not exist yet.

- [ ] **Step 3: Implement the route and UI shell**

```tsx
// src/app/routes/activity-card.tsx
export function ActivityCardRoute(props: {
  card: ActivityCardProjection | null;
  pendingApprovalIds?: Set<string>;
  onApprovalAction?: (approvalId: string, mode: 'yes' | 'always' | 'no') => void;
  onQuestionAnswer?: (questionId: string, label: string, value: string) => void;
  onJump?: (target: JumpTarget) => void;
  onHoverChange?: (hovered: boolean) => void;
}) {
  if (!props.card) {
    return <main className="activity-card-shell activity-card-shell--empty" />;
  }

  return (
    <main className="activity-card-shell">
      <FloatingActivityCard {...props} />
    </main>
  );
}
```

```tsx
// src/features/activity-card/FloatingActivityCard.tsx
export function FloatingActivityCard({
  card,
  onApprovalAction,
  onQuestionAnswer,
  onJump,
  onHoverChange,
}: FloatingActivityCardProps) {
  return (
    <article
      className={`floating-card floating-card--${card.kind}`}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <p className="floating-card__eyebrow">{card.kind}</p>
      <h1 className="floating-card__summary">{card.summary}</h1>

      {card.kind === 'approval' ? (
        <div className="floating-card__actions">
          <button onClick={() => onApprovalAction?.(card.approvalId, 'yes')}>Yes</button>
          <button onClick={() => onApprovalAction?.(card.approvalId, 'always')}>Always</button>
          <button onClick={() => onApprovalAction?.(card.approvalId, 'no')}>No</button>
        </div>
      ) : null}

      {card.kind === 'question' ? (
        <div className="floating-card__actions">
          {card.options.map((option) => (
            <button key={option.value} onClick={() => onQuestionAnswer?.(card.questionId, option.label, option.value)}>
              {option.label}
            </button>
          ))}
        </div>
      ) : null}

      {card.jumpTarget ? (
        <button className="floating-card__jump" onClick={() => onJump?.(card.jumpTarget!)}>
          Jump to agent
        </button>
      ) : null}
    </article>
  );
}
```

```tsx
// src/app/App.tsx
function getWindowMode(): 'panel' | 'expanded' | 'drag-demo' | 'activity-card' {
  const mode = new URLSearchParams(window.location.search).get('view');
  if (mode === 'activity-card') return 'activity-card';
  // existing branches unchanged
}
```

Remove any panel-top “primary alert” responsibility from `ActivityCardHost.tsx`. The panel can still show a passive attention section if desired, but it must stop pretending to be the new top-level floating surface.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/features/activity-card/activity-card.test.tsx tests/features/panel/panel.test.tsx`

Expected: PASS with immediate question submit, three approval buttons, and no regression in panel rendering.

- [ ] **Step 5: Commit**

```bash
git add src/app/routes/activity-card.tsx src/features/activity-card/FloatingActivityCard.tsx src/app/App.tsx src/features/activity-card/ActivityCardHost.tsx src/styles/panel.css tests/features/activity-card/activity-card.test.tsx tests/features/panel/panel.test.tsx
git commit -m "feat: add floating activity card route"
```

## Task 5: Add The Tauri Floating Window And Wire Runtime Refresh Into It

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src/app/App.tsx`
- Modify: `tests/features/activity-card/activity-card.test.tsx`

- [ ] **Step 1: Write the failing tests for view routing and Tauri window helpers**

```ts
import { describe, expect, it } from 'vitest';
import { App } from '../../../src/app/App';

describe('activity-card window routing', () => {
  it('renders the floating-card route when view=activity-card', () => {
    window.history.replaceState({}, '', '/?view=activity-card');
    render(<App />);
    expect(document.querySelector('.activity-card-shell')).not.toBeNull();
  });
});
```

```rust
#[test]
fn activity_card_window_size_is_compact_and_non_resizable() {
    assert_eq!(activity_card_window_size(), (420.0, 120.0));
    assert!(!activity_card_window_resizable());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/features/activity-card/activity-card.test.tsx`

Run: `cargo test activity_card_window_size_is_compact_and_non_resizable`

Expected: FAIL because there is no `activity-card` route or window helpers yet.

- [ ] **Step 3: Implement the Tauri window creation and commands**

```rust
fn activity_card_window_size() -> (f64, f64) {
    (420.0, 120.0)
}

fn activity_card_window_resizable() -> bool {
    false
}

fn ensure_activity_card_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(window) = app.get_webview_window("activity-card") {
        return Ok(window);
    }

    let (width, height) = activity_card_window_size();
    WebviewWindowBuilder::new(
        app,
        "activity-card",
        WebviewUrl::App("index.html?view=activity-card".into()),
    )
    .title("HexDeck Activity Card")
    .inner_size(width, height)
    .resizable(activity_card_window_resizable())
    .visible(false)
    .always_on_top(true)
    .decorations(false)
    .transparent(true)
    .skip_taskbar(true)
    .build()
}
```

```rust
#[tauri::command]
fn show_activity_card_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = ensure_activity_card_window(&app).map_err(|err| err.to_string())?;
    window.show().map_err(|err| err.to_string())?;
    window.set_focus().map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_activity_card_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("activity-card") {
        window.hide().map_err(|err| err.to_string())?;
    }
    Ok(())
}
```

Also add the missing window-control commands already referenced by `App.tsx`:

```rust
#[tauri::command]
fn toggle_panel_command(app: tauri::AppHandle) -> Result<(), String> { /* show/hide panel */ }

#[tauri::command]
fn open_expanded_window(app: tauri::AppHandle, section: String) -> Result<(), String> { /* create expanded window */ }
```

This repo already calls those commands from [App.tsx](/Users/song/projects/hexdeck/src/app/App.tsx), but `src-tauri/src/main.rs` does not currently expose them. Close that gap in the same task so the multi-window model is coherent before layering the new floating window on top.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test activity_card_window_size_is_compact_and_non_resizable`

Run: `npx vitest run tests/features/activity-card/activity-card.test.tsx`

Expected: PASS with `view=activity-card` route rendering and Rust helper test passing.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/main.rs src/app/App.tsx tests/features/activity-card/activity-card.test.tsx
git commit -m "feat: add floating activity card window"
```

## Task 6: Wire Live Refresh, Shortcuts, And End-To-End Verification

**Files:**
- Modify: `src/app/App.tsx`
- Modify: `src/lib/store/app-store.ts`
- Modify: `src/features/activity-card/FloatingActivityCard.tsx`
- Modify: `tests/features/activity-card/activity-card.test.tsx`
- Modify: `tests/lib/projections/project-snapshot.test.ts`

- [ ] **Step 1: Write the failing tests for refresh wiring and approval shortcuts**

```tsx
it('refreshes the floating card queue when broker snapshot changes', async () => {
  const store = createAppStore();
  store.replaceActivityCards([
    {
      cardId: 'approval:1',
      kind: 'approval',
      priority: 3,
      summary: 'Approval requested',
      approvalId: 'approval-1',
      actions: ['yes', 'always', 'no'],
      createdAtMs: 1,
    },
  ], 0);

  expect(store.getState().activityCards.activeCard?.cardId).toBe('approval:1');
});

it('maps y/a/n keyboard shortcuts onto approval actions only', () => {
  const onApprovalAction = vi.fn();
  render(
    <FloatingActivityCard
      card={{
        cardId: 'approval:1',
        kind: 'approval',
        priority: 3,
        summary: 'Ship it?',
        approvalId: 'approval-1',
        actions: ['yes', 'always', 'no'],
        createdAtMs: 1,
      }}
      onApprovalAction={onApprovalAction}
    />
  );

  fireEvent.keyDown(window, { key: 'a' });
  expect(onApprovalAction).toHaveBeenCalledWith('approval-1', 'always');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/features/activity-card/activity-card.test.tsx tests/lib/store/app-store.test.ts`

Expected: FAIL with missing keydown behavior and missing live queue refresh wiring.

- [ ] **Step 3: Implement refresh wiring, window visibility, and keyboard shortcuts**

```tsx
// src/app/App.tsx
const nextCards = buildActivityCardsFromSeed(seed);
store.replaceActivityCards(nextCards, Date.now());

const runtime = store.getState().activityCards;
if (runtime.activeCard) {
  await invoke('show_activity_card_window');
} else {
  await invoke('hide_activity_card_window');
}
```

```tsx
// src/features/activity-card/FloatingActivityCard.tsx
useEffect(() => {
  if (card.kind !== 'approval') return;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() === 'y') onApprovalAction?.(card.approvalId, 'yes');
    if (event.key.toLowerCase() === 'a') onApprovalAction?.(card.approvalId, 'always');
    if (event.key.toLowerCase() === 'n') onApprovalAction?.(card.approvalId, 'no');
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}, [card, onApprovalAction]);
```

```tsx
// src/app/App.tsx
if (windowMode === 'activity-card') {
  const cardRuntime = store.getState().activityCards;
  return (
    <ActivityCardRoute
      card={cardRuntime.activeCard}
      pendingApprovalIds={pendingApprovalIds}
      onApprovalAction={(approvalId, mode) => void respondToApproval(approvalId, cardRuntime.activeCard?.taskId, mode)}
      onQuestionAnswer={(questionId, label, value) => void respondToQuestion(questionId, label, value)}
      onHoverChange={(hovered) => store.setActivityCardHovered(hovered, Date.now())}
      onJump={handleJump}
    />
  );
}
```

- [ ] **Step 4: Run the final verification suite**

Run: `npx vitest run tests/lib/activity-card/projections.test.ts tests/lib/activity-card/store.test.ts tests/lib/broker/client.test.ts tests/lib/store/app-store.test.ts tests/features/activity-card/activity-card.test.tsx tests/features/panel/panel.test.tsx`

Run: `npm run build`

Run: `cargo test activity_card_window_size_is_compact_and_non_resizable`

Expected: All Vitest suites PASS, `npm run build` succeeds, and the Rust window helper test passes.

- [ ] **Step 5: Commit**

```bash
git add src/app/App.tsx src/lib/store/app-store.ts src/features/activity-card/FloatingActivityCard.tsx tests/features/activity-card/activity-card.test.tsx tests/lib/store/app-store.test.ts tests/lib/activity-card/projections.test.ts tests/lib/activity-card/store.test.ts tests/lib/broker/client.test.ts tests/features/panel/panel.test.tsx src-tauri/src/main.rs
git commit -m "feat: wire floating activity cards end to end"
```

## Self-Review

### Spec Coverage

- Dedicated top-of-screen floating surface: covered by Task 5
- One-card queue with `approval > question > completion`: covered by Tasks 1 and 2
- Hover pause and `6s / 6s / 3s` dismissal: covered by Task 2
- Direct jump-to-agent: covered by Tasks 1, 4, and 6
- `question` single-select click-to-submit: covered by Tasks 1, 3, and 4
- Approval keyboard shortcuts for `Yes / Always / No`: covered by Tasks 3 and 6
- Panel remains separate from floating surface: covered by Task 4

### Placeholder Scan

- No `TODO` / `TBD`
- Each task names exact files
- Each test step includes concrete test code and run commands
- Each implementation step shows concrete function signatures and representative code

### Type Consistency

- Floating surface types use `ActivityCardProjection`
- Replay normalization still produces `BrokerEvent.type`
- Approval action mode names stay `yes | always | no`
- Question answer transport uses `answer_clarification`

## Notes

- `Always` approval semantics require parallel broker-side support if the action must persist beyond the current card interaction. This plan intentionally stabilizes the UI contract and client transport first so HexDeck can ship the window, queue, timers, shortcuts, and direct jump behavior without blocking on a separate repo.
