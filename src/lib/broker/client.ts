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

function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function normalizeBrokerEvent(value: unknown): BrokerEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<BrokerEvent> & { kind?: unknown };
  const type = typeof candidate.type === 'string'
    ? candidate.type
    : typeof candidate.kind === 'string'
      ? candidate.kind
      : null;

  if (typeof candidate.id !== 'number' || type === null) {
    return null;
  }

  const event: BrokerEvent = {
    id: candidate.id,
    type,
  };

  if (typeof candidate.taskId === 'string') event.taskId = candidate.taskId;
  if (typeof candidate.threadId === 'string') event.threadId = candidate.threadId;
  if (typeof candidate.createdAt === 'string') event.createdAt = candidate.createdAt;
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
      this.requestList<unknown>('/events/replay?after=0', 'items'),
      this.loadPendingApprovals(projectName),
    ]);

    return {
      health,
      participants: mergeParticipantsWithPresence(participants, presence),
      workStates,
      events: normalizeBrokerEvents(events),
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
      this.requestList<unknown>('/events/replay?after=0', 'items'),
    ]);

    return {
      health,
      participants: mergeParticipantsWithPresence(participants, presence),
      workStates,
      events: normalizeBrokerEvents(events),
      approvals: [],
    };
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
    if (isTauriEnvironment()) {
      return () => undefined;
    }

    if (this.realtimeCleanup) {
      return this.realtimeCleanup;
    }

    const socket = this.websocketFactory(this.brokerUrl.replace(/^http/, 'ws'));

    const handleMessage = (message: MessageEvent<string>) => {
      let parsed: unknown;

      try {
        parsed = JSON.parse(String(message.data));
      } catch {
        return;
      }

      const event = normalizeBrokerEvent(parsed);
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
