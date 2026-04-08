import { invoke } from '@tauri-apps/api/core';
import type {
  BrokerApprovalItem,
  BrokerApprovalResponseInput,
  BrokerEvent,
  BrokerHealth,
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

function isBrokerEvent(value: unknown): value is BrokerEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<BrokerEvent>;
  return typeof candidate.id === 'number' && typeof candidate.type === 'string';
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
      return invoke<ProjectSeed>('load_broker_project_seed', {
        brokerUrl: this.brokerUrl,
        projectName,
      });
    }

    const encodedProjectName = encodeURIComponent(projectName);
    const [health, participants, workStates, presence, events, approvals] = await Promise.all([
      this.request<BrokerHealth>('/health'),
      this.requestList<BrokerParticipant>(`/participants?projectName=${encodedProjectName}`, 'participants'),
      this.requestList<BrokerWorkState>(`/work-state?projectName=${encodedProjectName}`, 'items'),
      this.loadPresence(),
      this.requestList<BrokerEvent>('/events/replay?after=0', 'items'),
      this.loadPendingApprovals(projectName),
    ]);

    return {
      health,
      participants: mergeParticipantsWithPresence(participants, presence),
      workStates,
      events,
      approvals,
    };
  }

  async loadServiceSeed(): Promise<ProjectSeed> {
    if (isTauriEnvironment()) {
      return invoke<ProjectSeed>('load_broker_service_seed', {
        brokerUrl: this.brokerUrl,
      });
    }

    const [health, participants, workStates, presence, events] = await Promise.all([
      this.request<BrokerHealth>('/health'),
      this.requestList<BrokerParticipant>('/participants', 'participants'),
      this.requestList<BrokerWorkState>('/work-state', 'items'),
      this.loadPresence(),
      this.requestList<BrokerEvent>('/events/replay?after=0', 'items'),
    ]);

    return {
      health,
      participants: mergeParticipantsWithPresence(participants, presence),
      workStates,
      events,
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
    const payload = await this.request<{ items: BrokerApprovalItem[] }>(
      `/projects/${encodedProjectName}/approvals?status=pending`
    );
    return payload.items;
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
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`broker_approval_failed ${response.status}`);
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

      if (!isBrokerEvent(parsed)) {
        return;
      }

      const event = parsed;
      for (const listener of this.listeners) {
        listener(event);
      }
    };

    socket.addEventListener('message', handleMessage);

    let disposed = false;
    const cleanup = () => {
      if (disposed) {
        return;
      }

      disposed = true;
      socket.removeEventListener('message', handleMessage);
      socket.close();

      if (this.realtimeCleanup === cleanup) {
        this.realtimeCleanup = null;
      }
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
    const payload = await this.request<T[] | Record<string, unknown>>(path);

    if (Array.isArray(payload)) {
      return payload;
    }

    const items = payload[key];
    return Array.isArray(items) ? (items as T[]) : [];
  }

  private async loadPresence(): Promise<BrokerPresence[]> {
    try {
      return await this.requestList<BrokerPresence>('/presence', 'participants');
    } catch {
      return [];
    }
  }
}
