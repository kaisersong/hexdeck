import { invoke } from '@tauri-apps/api/core';
import type {
  BrokerApprovalItem,
  BrokerApprovalResponseInput,
  BrokerEvent,
  BrokerHealth,
  BrokerClarificationAnswerInput,
  BrokerPresence,
  BrokerParticipant,
  BrokerWorkState,
  ProjectSeed
} from './types';

interface BrokerClientOptions {
  brokerUrl: string;
  fetchImpl?: typeof fetch;
  websocketFactory?: (url: string) => WebSocket;
}

type BrokerEventListener = (event: BrokerEvent) => void;
const REPLAY_PAGE_SIZE = 100;
const BROKER_UI_PARTICIPANT_ID = 'human.local';
const BROKER_UI_PARTICIPANT = {
  participantId: BROKER_UI_PARTICIPANT_ID,
  alias: 'human',
  kind: 'human',
  roles: ['approver'],
  capabilities: ['activity-card'],
  metadata: {
    source: 'hexdeck',
  },
};

function mergeParticipantsWithPresence(
  participants: BrokerParticipant[],
  presence: BrokerPresence[]
): BrokerParticipant[] {
  if (presence.length === 0) {
    return participants;
  }

  const presenceByParticipant = new Map(presence.map((item) => [item.participantId, item]));
  return participants.map((participant) => ({
    ...participant,
    presence: presenceByParticipant.get(participant.participantId)?.status ?? participant.presence,
    presenceMetadata:
      presenceByParticipant.get(participant.participantId)?.metadata ?? participant.presenceMetadata,
  }));
}

function filterEventsForProjectParticipants(
  events: BrokerEvent[],
  participants: BrokerParticipant[]
): BrokerEvent[] {
  const participantIds = new Set(participants.map((participant) => participant.participantId));
  const projectApprovalIds = new Set<string>();
  const projectApprovalTaskIds = new Set<string>();

  for (const event of events) {
    const participantId = typeof event.payload?.participantId === 'string'
      ? event.payload.participantId
      : event.fromParticipantId;
    if (event.type !== 'request_approval' || typeof participantId !== 'string' || !participantIds.has(participantId)) {
      continue;
    }

    const approvalId = event.payload?.approvalId;
    if (typeof approvalId === 'string') {
      projectApprovalIds.add(approvalId);
    }

    if (typeof event.taskId === 'string') {
      projectApprovalTaskIds.add(event.taskId);
    }
  }

  return events.filter((event) => {
    const participantId = typeof event.payload?.participantId === 'string'
      ? event.payload.participantId
      : event.fromParticipantId;
    if (typeof participantId === 'string' && participantIds.has(participantId)) {
      return true;
    }

    if (event.type !== 'respond_approval') {
      return false;
    }

    const approvalId = event.payload?.approvalId;
    return (typeof approvalId === 'string' && projectApprovalIds.has(approvalId))
      || (typeof event.taskId === 'string' && projectApprovalTaskIds.has(event.taskId));
  });
}

function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function normalizeBrokerEvent(value: unknown): BrokerEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<BrokerEvent> & { kind?: unknown; eventId?: unknown };
  const type = typeof candidate.type === 'string'
    ? candidate.type
    : typeof candidate.kind === 'string'
      ? candidate.kind
      : null;
  const id = typeof candidate.id === 'number'
    ? candidate.id
    : typeof candidate.eventId === 'number'
      ? candidate.eventId
      : null;

  if (id === null || type === null) {
    return null;
  }

  const event: BrokerEvent = {
    id,
    type,
  };

  if (typeof candidate.taskId === 'string') event.taskId = candidate.taskId;
  if (typeof candidate.threadId === 'string') event.threadId = candidate.threadId;
  if (typeof candidate.createdAt === 'string') event.createdAt = candidate.createdAt;
  if (typeof candidate.fromParticipantId === 'string') event.fromParticipantId = candidate.fromParticipantId;
  if (typeof candidate.fromAlias === 'string') event.fromAlias = candidate.fromAlias;
  if (typeof candidate.fromProjectName === 'string') event.fromProjectName = candidate.fromProjectName;
  if (candidate.payload && typeof candidate.payload === 'object' && !Array.isArray(candidate.payload)) {
    event.payload = candidate.payload as Record<string, unknown>;
  }

  return event;
}

function normalizeBrokerEvents(values: unknown): BrokerEvent[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => normalizeBrokerEvent(value))
    .filter((value): value is BrokerEvent => value !== null);
}

function extractReplayCursor(values: unknown[]): number {
  let cursor = 0;

  for (const value of values) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue;
    }

    const candidate = value as { id?: unknown; eventId?: unknown };
    const id = typeof candidate.id === 'number'
      ? candidate.id
      : typeof candidate.eventId === 'number'
        ? candidate.eventId
        : null;

    if (typeof id === 'number') {
      cursor = Math.max(cursor, id);
    }
  }

  return cursor;
}

function buildBrokerWebSocketUrl(brokerUrl: string): string {
  const url = new URL(`${brokerUrl.replace(/^http/, 'ws')}/ws`);
  url.searchParams.set('participantId', BROKER_UI_PARTICIPANT_ID);
  return url.toString();
}

function normalizeProjectSeed(seed: ProjectSeed): ProjectSeed {
  return {
    ...seed,
    events: normalizeBrokerEvents(seed.events),
  };
}

function createIntentId(prefix: string): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return `${prefix}:${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

function isUnavailableBrokerError(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof Error && error.message.startsWith('broker_request_failed'));
}

function isMalformedBrokerResponseError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('broker_response_malformed');
}

export class BrokerClient {
  private readonly brokerUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly websocketFactory: (url: string) => WebSocket;
  private readonly listeners = new Set<BrokerEventListener>();
  private realtimeCleanup: (() => void) | null = null;

  constructor(options: BrokerClientOptions) {
    this.brokerUrl = options.brokerUrl.replace(/\/$/, '');
    this.fetchImpl =
      options.fetchImpl ??
      ((input, init) => {
        if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
          return window.fetch.call(window, input, init);
        }

        return globalThis.fetch(input, init);
      });
    this.websocketFactory = options.websocketFactory ?? ((url) => new WebSocket(url));
  }

  async loadProjectSeed(projectName: string): Promise<ProjectSeed> {
    if (isTauriEnvironment()) {
      return normalizeProjectSeed(await invoke<ProjectSeed>('load_broker_project_seed', {
        brokerUrl: this.brokerUrl,
        projectName,
      }));
    }

    const encodedProjectName = encodeURIComponent(projectName);
    const [health, participants, workStates, presence, events, approvals] = await Promise.all([
      this.request<BrokerHealth>('/health'),
      this.requestList<BrokerParticipant>(`/participants?projectName=${encodedProjectName}`, 'participants'),
      this.requestList<BrokerWorkState>(`/work-state?projectName=${encodedProjectName}`, 'items'),
      this.loadPresence(),
      this.loadReplayEvents(),
      this.loadPendingApprovals(projectName),
    ]);

    const mergedParticipants = mergeParticipantsWithPresence(participants, presence);

    return {
      health,
      participants: mergedParticipants,
      workStates,
      events: filterEventsForProjectParticipants(normalizeBrokerEvents(events), mergedParticipants),
      approvals,
    };
  }

  async loadServiceSeed(): Promise<ProjectSeed> {
    if (isTauriEnvironment()) {
      return normalizeProjectSeed(await invoke<ProjectSeed>('load_broker_service_seed', {
        brokerUrl: this.brokerUrl,
      }));
    }

    const [health, participants, workStates, presence, events] = await Promise.all([
      this.request<BrokerHealth>('/health'),
      this.requestList<BrokerParticipant>('/participants', 'participants'),
      this.requestList<BrokerWorkState>('/work-state', 'items'),
      this.loadPresence(),
      this.loadReplayEvents(),
    ]);

    return {
      health,
      participants: mergeParticipantsWithPresence(participants, presence),
      workStates,
      events: normalizeBrokerEvents(events),
      approvals: [],
    };
  }

  private async loadReplayEvents(): Promise<BrokerEvent[]> {
    const events: BrokerEvent[] = [];
    let after = 0;

    while (true) {
      const page = await this.requestList<unknown>(`/events/replay?after=${after}`, 'items');
      events.push(...normalizeBrokerEvents(page));

      if (page.length < REPLAY_PAGE_SIZE) {
        break;
      }

      const nextAfter = extractReplayCursor(page);
      if (nextAfter <= after) {
        break;
      }

      after = nextAfter;
    }

    return events;
  }

  async loadPendingApprovals(projectName: string): Promise<BrokerApprovalItem[]> {
    if (isTauriEnvironment()) {
      return invoke<BrokerApprovalItem[]>('load_broker_pending_approvals', {
        brokerUrl: this.brokerUrl,
        projectName,
      });
    }

    const encodedProjectName = encodeURIComponent(projectName);
    return this.requestList<BrokerApprovalItem>(
      `/projects/${encodedProjectName}/approvals?status=pending`,
      'items'
    );
  }

  async respondToApproval(input: BrokerApprovalResponseInput): Promise<void> {
    if (isTauriEnvironment()) {
      await invoke('respond_to_broker_approval', {
        brokerUrl: this.brokerUrl,
        input,
      });
      return;
    }

    const response = await this.fetchImpl(
      `${this.brokerUrl}/approvals/${encodeURIComponent(input.approvalId)}/respond`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId: input.taskId,
          fromParticipantId: input.fromParticipantId,
          decision: input.decision,
          decisionMode: input.decisionMode,
          nativeDecision: input.nativeDecision,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`broker_approval_failed ${response.status}`);
    }
  }

  async answerClarification(input: BrokerClarificationAnswerInput): Promise<void> {
    const response = await this.fetchImpl(`${this.brokerUrl}/intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intentId: input.intentId ?? createIntentId('clarification'),
        kind: 'answer_clarification',
        fromParticipantId: input.fromParticipantId,
        taskId: input.taskId,
        threadId: input.threadId,
        to: {
          mode: 'participant',
          participants: [input.toParticipantId],
        },
        payload: {
          body: { summary: input.summary },
          delivery: {
            semantic: 'informational',
            source: 'default',
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`broker_intent_failed ${response.status}`);
    }
  }

  subscribe(listener: BrokerEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  connectRealtime(): () => void {
    if (this.realtimeCleanup) {
      return this.realtimeCleanup;
    }

    this.registerRealtimeParticipant();
    const socket = this.websocketFactory(buildBrokerWebSocketUrl(this.brokerUrl));

    const handleMessage = (message: MessageEvent<string>) => {
      let parsed: unknown;

      try {
        parsed = JSON.parse(String(message.data));
      } catch {
        return;
      }

      const event = normalizeBrokerEvent(parsed)
        ?? (
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? normalizeBrokerEvent((parsed as { event?: unknown }).event)
            : null
        );
      if (!event) {
        return;
      }

      for (const listener of this.listeners) {
        listener(event);
      }
    };

    let cleanup: () => void = () => undefined;
    let disposed = false;
    const cleanupInternal = () => {
      if (disposed) {
        return;
      }

      disposed = true;
      socket.removeEventListener('message', handleMessage);
      socket.removeEventListener('close', handleSocketTerminalEvent);
      socket.removeEventListener('error', handleSocketTerminalEvent);

      if (this.realtimeCleanup === cleanup) {
        this.realtimeCleanup = null;
      }
    };

    const handleSocketTerminalEvent = () => {
      cleanupInternal();
    };

    socket.addEventListener('message', handleMessage);
    socket.addEventListener('close', handleSocketTerminalEvent);
    socket.addEventListener('error', handleSocketTerminalEvent);

    cleanup = () => {
      cleanupInternal();
      socket.close();
    };

    this.realtimeCleanup = cleanup;
    return cleanup;
  }

  private registerRealtimeParticipant(): void {
    if (isTauriEnvironment()) {
      void Promise.resolve(
        invoke('register_broker_ui_participant', {
          brokerUrl: this.brokerUrl,
        })
      ).catch(() => undefined);
      return;
    }

    void Promise.resolve(
      this.fetchImpl(`${this.brokerUrl}/participants/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BROKER_UI_PARTICIPANT),
      })
    )
      .then(() => undefined)
      .catch(() => undefined);
  }

  private async request<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.brokerUrl}${path}`);

    if (!response.ok) {
      throw new Error(`broker_request_failed ${response.status} ${path}`);
    }

    return response.json() as Promise<T>;
  }

  private async requestList<T>(path: string, key: string): Promise<T[]> {
    let payload: T[] | Record<string, unknown>;

    try {
      payload = await this.request<T[] | Record<string, unknown>>(path);
    } catch (error) {
      if (isUnavailableBrokerError(error)) {
        throw error;
      }

      throw new Error(`broker_response_malformed ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (Array.isArray(payload)) {
      return payload;
    }

    const items = payload[key];
    if (!Array.isArray(items)) {
      throw new Error(`broker_response_malformed ${path}: expected ${key} array`);
    }

    return items as T[];
  }

  private async loadPresence(): Promise<BrokerPresence[]> {
    try {
      return await this.requestList<BrokerPresence>('/presence', 'participants');
    } catch (error) {
      if (isMalformedBrokerResponseError(error)) {
        throw error;
      }

      return [];
    }
  }
}
