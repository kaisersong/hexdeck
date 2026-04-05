import type {
  BrokerEvent,
  BrokerHealth,
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
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.websocketFactory = options.websocketFactory ?? ((url) => new WebSocket(url));
  }

  async loadProjectSeed(projectName: string): Promise<ProjectSeed> {
    const encodedProjectName = encodeURIComponent(projectName);
    const [health, participants, workStates, events] = await Promise.all([
      this.request<BrokerHealth>('/health'),
      this.request<BrokerParticipant[]>(`/participants?projectName=${encodedProjectName}`),
      this.request<BrokerWorkState[]>(`/work-state?projectName=${encodedProjectName}`),
      this.request<BrokerEvent[]>('/events/replay?after=0')
    ]);

    return {
      health,
      participants,
      workStates,
      events
    };
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
}
