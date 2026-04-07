import type {
  BrokerApprovalItem,
  BrokerApprovalResponseInput,
  BrokerEvent,
  BrokerHealth,
  BrokerParticipant,
  BrokerWorkState,
  ProjectSeed
} from './types';

interface BrokerClientOptions {
  brokerUrl: string;
  participantId?: string;
  fetchImpl?: typeof fetch;
  websocketFactory?: (url: string) => WebSocket;
}

type BrokerEventListener = (event: BrokerEvent) => void;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function extractCollection(value: unknown, keys: string[]): unknown[] {
  const direct = asArray(value);
  if (direct) {
    return direct;
  }

  const record = asRecord(value);
  if (!record) {
    return [];
  }

  for (const key of keys) {
    const candidate = asArray(record[key]);
    if (candidate) {
      return candidate;
    }
  }

  return [];
}

function normalizeHealth(value: unknown): BrokerHealth {
  const record = asRecord(value);
  if (!record) {
    return { ok: false, status: 'degraded' };
  }

  const statusValue = typeof record.status === 'string' ? record.status : undefined;
  const okValue =
    typeof record.ok === 'boolean'
      ? record.ok
      : statusValue === 'healthy' || statusValue === 'ok' || statusValue === 'live';

  return {
    ok: okValue,
    status: okValue ? 'healthy' : 'degraded',
  };
}

function normalizeParticipant(value: unknown): BrokerParticipant | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const nestedContext = asRecord(record.context);
  const nestedMetadata = asRecord(record.metadata);
  const participantId =
    (typeof record.participantId === 'string' && record.participantId) ||
    (typeof record.participant_id === 'string' && record.participant_id) ||
    (typeof record.id === 'string' && record.id) ||
    (typeof record.sessionId === 'string' && record.sessionId) ||
    (typeof record.session_id === 'string' && record.session_id);

  if (!participantId) {
    return null;
  }

  const projectName =
    (typeof nestedContext?.projectName === 'string' && nestedContext.projectName) ||
    (typeof record.projectName === 'string' && record.projectName) ||
    (typeof record.project === 'string' && record.project) ||
    (typeof nestedMetadata?.projectName === 'string' && nestedMetadata.projectName);

  return {
    participantId,
    alias:
      (typeof record.alias === 'string' && record.alias) ||
      (typeof record.name === 'string' && record.name) ||
      (typeof record.handle === 'string' && record.handle) ||
      (typeof record.displayName === 'string' && record.displayName) ||
      participantId,
    kind: typeof record.kind === 'string' ? record.kind : undefined,
    tool:
      (typeof record.tool === 'string' && record.tool) ||
      (typeof record.toolLabel === 'string' && record.toolLabel) ||
      undefined,
    metadata: nestedMetadata ?? undefined,
    context: projectName ? { projectName } : undefined,
  };
}

function normalizeWorkState(value: unknown): BrokerWorkState | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const participantId =
    (typeof record.participantId === 'string' && record.participantId) ||
    (typeof record.participant_id === 'string' && record.participant_id) ||
    (typeof record.id === 'string' && record.id);
  const status =
    (typeof record.status === 'string' && record.status) ||
    (typeof record.state === 'string' && record.state) ||
    (typeof record.workState === 'string' && record.workState) ||
    (typeof record.work_state === 'string' && record.work_state);

  if (!participantId || !status) {
    return null;
  }

  return {
    participantId,
    status,
    taskId:
      (typeof record.taskId === 'string' && record.taskId) ||
      (typeof record.task_id === 'string' && record.task_id) ||
      undefined,
    threadId:
      (typeof record.threadId === 'string' && record.threadId) ||
      (typeof record.thread_id === 'string' && record.thread_id) ||
      undefined,
    summary:
      (typeof record.summary === 'string' && record.summary) ||
      (typeof record.message === 'string' && record.message) ||
      (typeof record.taskSummary === 'string' && record.taskSummary) ||
      undefined,
    updatedAt:
      (typeof record.updatedAt === 'string' && record.updatedAt) ||
      (typeof record.updated_at === 'string' && record.updated_at) ||
      (typeof record.timestamp === 'string' && record.timestamp) ||
      undefined,
  };
}

function normalizeEvent(value: unknown): BrokerEvent | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const idValue = record.id;
  const id =
    typeof idValue === 'number'
      ? idValue
      : typeof idValue === 'string' && Number.isFinite(Number(idValue))
        ? Number(idValue)
        : null;
  const type =
    (typeof record.type === 'string' && record.type) ||
    (typeof record.event === 'string' && record.event) ||
    (typeof record.name === 'string' && record.name);

  if (id === null || !type) {
    return null;
  }

  return {
    id,
    type,
    taskId:
      (typeof record.taskId === 'string' && record.taskId) ||
      (typeof record.task_id === 'string' && record.task_id) ||
      undefined,
    threadId:
      (typeof record.threadId === 'string' && record.threadId) ||
      (typeof record.thread_id === 'string' && record.thread_id) ||
      undefined,
    createdAt:
      (typeof record.createdAt === 'string' && record.createdAt) ||
      (typeof record.created_at === 'string' && record.created_at) ||
      undefined,
    payload: asRecord(record.payload) ?? undefined,
  };
}

function normalizeApproval(value: unknown): BrokerApprovalItem | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const approvalId =
    (typeof record.approvalId === 'string' && record.approvalId) ||
    (typeof record.approval_id === 'string' && record.approval_id) ||
    (typeof record.id === 'string' && record.id);
  const taskId =
    (typeof record.taskId === 'string' && record.taskId) ||
    (typeof record.task_id === 'string' && record.task_id);

  if (!approvalId || !taskId) {
    return null;
  }

  return {
    approvalId,
    taskId,
    threadId:
      (typeof record.threadId === 'string' && record.threadId) ||
      (typeof record.thread_id === 'string' && record.thread_id) ||
      undefined,
    summary:
      (typeof record.summary === 'string' && record.summary) ||
      (typeof record.message === 'string' && record.message) ||
      undefined,
    decision:
      record.decision === 'approved' || record.decision === 'denied' || record.decision === 'pending'
        ? record.decision
        : record.status === 'approved' || record.status === 'denied' || record.status === 'pending'
          ? record.status
          : undefined,
  };
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
  private readonly participantId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly websocketFactory: (url: string) => WebSocket;
  private readonly listeners = new Set<BrokerEventListener>();
  private realtimeCleanup: (() => void) | null = null;

  constructor(options: BrokerClientOptions) {
    this.brokerUrl = options.brokerUrl.replace(/\/$/, '');
    this.participantId = options.participantId?.trim() || 'hexdeck.desktop';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.websocketFactory = options.websocketFactory ?? ((url) => new WebSocket(url));
  }

  async loadProjectSeed(projectName?: string | null): Promise<ProjectSeed> {
    const normalizedProject = projectName?.trim() ?? '';
    const [health, participants] = await Promise.all([
      this.loadHealth(),
      this.loadParticipants(normalizedProject || null),
    ]);
    const projectNames = Array.from(
      new Set(
        participants
          .map((participant) => participant.context?.projectName?.trim())
          .filter((value): value is string => Boolean(value))
      )
    );
    const [workStates, events, approvals] = await Promise.all([
      this.loadWorkStates(normalizedProject || null, participants.map((participant) => participant.participantId)),
      this.loadEvents(),
      normalizedProject ? this.loadPendingApprovals(normalizedProject) : this.loadPendingApprovalsForProjects(projectNames),
    ]);

    return {
      health,
      participants,
      workStates,
      events,
      approvals,
    };
  }

  async loadPendingApprovals(projectName: string): Promise<BrokerApprovalItem[]> {
    const encodedProjectName = encodeURIComponent(projectName);
    const approvals =
      (await this.tryCollectionRequest(
        [`/projects/${encodedProjectName}/approvals?status=pending`],
        ['items', 'approvals', 'data'],
        normalizeApproval
      )) ?? [];

    return approvals;
  }

  async loadPendingApprovalsForProjects(projectNames: string[]): Promise<BrokerApprovalItem[]> {
    if (projectNames.length === 0) {
      return [];
    }

    const approvals = await Promise.all(projectNames.map((projectName) => this.loadPendingApprovals(projectName)));
    const deduped = new Map<string, BrokerApprovalItem>();

    for (const group of approvals) {
      for (const approval of group) {
        deduped.set(approval.approvalId, approval);
      }
    }

    return Array.from(deduped.values());
  }

  async respondToApproval(input: BrokerApprovalResponseInput): Promise<void> {
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
    if (this.realtimeCleanup) {
      return this.realtimeCleanup;
    }

    let socket: WebSocket;
    try {
      socket = this.websocketFactory(
        `${this.brokerUrl.replace(/^http/, 'ws')}/ws?participantId=${encodeURIComponent(this.participantId)}`
      );
    } catch {
      return () => undefined;
    }

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

  private async loadHealth(): Promise<BrokerHealth> {
    const payload = await this.request<unknown>('/health');
    return normalizeHealth(payload);
  }

  private async loadParticipants(projectName?: string | null): Promise<BrokerParticipant[]> {
    if (!projectName) {
      return (
        (await this.tryCollectionRequest(['/participants', '/agents'], ['participants', 'items', 'data'], normalizeParticipant)) ?? []
      );
    }

    const encodedProjectName = encodeURIComponent(projectName);
    const scoped =
      (await this.tryCollectionRequest(
        [
          `/participants?projectName=${encodedProjectName}`,
          `/participants?project=${encodedProjectName}`,
        ],
        ['participants', 'items', 'data'],
        normalizeParticipant
      )) ?? [];

    if (scoped.length > 0) {
      return scoped;
    }

    const unscoped =
      (await this.tryCollectionRequest(['/participants', '/agents'], ['participants', 'items', 'data'], normalizeParticipant)) ?? [];

    const filtered = unscoped.filter((participant) => participant.context?.projectName === projectName);
    return filtered.length > 0 ? filtered : scoped.length > 0 ? scoped : unscoped;
  }

  private async loadWorkStates(projectName: string | null, participantIds: string[]): Promise<BrokerWorkState[]> {
    if (!projectName) {
      return (
        (await this.tryCollectionRequest(['/work-state', '/workstates'], ['workStates', 'items', 'data'], normalizeWorkState)) ?? []
      );
    }

    const encodedProjectName = encodeURIComponent(projectName);
    const scoped =
      (await this.tryCollectionRequest(
        [
          `/work-state?projectName=${encodedProjectName}`,
          `/work-state?project=${encodedProjectName}`,
          `/workstates?projectName=${encodedProjectName}`,
        ],
        ['workStates', 'items', 'data'],
        normalizeWorkState
      )) ?? [];

    if (scoped.length > 0) {
      return scoped;
    }

    const unscoped =
      (await this.tryCollectionRequest(['/work-state', '/workstates'], ['workStates', 'items', 'data'], normalizeWorkState)) ?? [];

    const filtered = unscoped.filter((workState) => participantIds.includes(workState.participantId));
    return filtered.length > 0 ? filtered : scoped.length > 0 ? scoped : unscoped;
  }

  private async loadEvents(): Promise<BrokerEvent[]> {
    return (
      (await this.tryCollectionRequest(
        ['/events/replay?after=0', '/events?after=0', '/events'],
        ['events', 'items', 'data'],
        normalizeEvent
      )) ?? []
    );
  }

  private async tryCollectionRequest<T>(
    paths: string[],
    collectionKeys: string[],
    normalizeItem: (value: unknown) => T | null
  ): Promise<T[] | null> {
    let lastError: Error | null = null;

    for (const path of paths) {
      try {
        const payload = await this.request<unknown>(path);
        const items = extractCollection(payload, collectionKeys).map(normalizeItem).filter((item): item is T => item !== null);
        return items;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('broker_request_failed 404') || message.includes('broker_request_failed 400')) {
          lastError = error instanceof Error ? error : new Error(message);
          continue;
        }

        throw error;
      }
    }

    if (lastError) {
      return null;
    }

    return [];
  }
}
