import type { BrokerParticipant } from './types';

function readMetadataString(
  participant: BrokerParticipant,
  key: 'projectPath' | 'terminalApp' | 'sessionHint' | 'terminalTTY' | 'terminalSessionID'
): string | null {
  const value = participant.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hasUsableTerminalLocator(participant: BrokerParticipant): boolean {
  const terminalApp = readMetadataString(participant, 'terminalApp');
  if (!terminalApp || terminalApp.toLowerCase() === 'unknown') {
    return false;
  }

  return Boolean(
    readMetadataString(participant, 'terminalSessionID')
      || readMetadataString(participant, 'terminalTTY')
      || readMetadataString(participant, 'sessionHint')
  );
}

function isRegistrationOnlyPresence(participant: BrokerParticipant): boolean {
  if (participant.presence !== 'online') {
    return false;
  }

  const presenceMetadata = participant.presenceMetadata ?? {};
  return presenceMetadata.source === 'registration' && presenceMetadata.transport !== 'websocket';
}

function participantFamily(participant: BrokerParticipant): string {
  const sessionMarker = participant.participantId.indexOf('-session-');
  if (sessionMarker > 0) {
    return participant.participantId.slice(0, sessionMarker);
  }

  return participant.participantId;
}

function registrationDedupLocator(participant: BrokerParticipant): string | null {
  const terminalApp = readMetadataString(participant, 'terminalApp');
  if (!terminalApp || terminalApp.toLowerCase() === 'unknown') {
    return null;
  }

  const terminalSessionId = readMetadataString(participant, 'terminalSessionID');
  if (terminalSessionId) {
    return `session:${terminalSessionId}`;
  }

  const terminalTty = readMetadataString(participant, 'terminalTTY');
  if (terminalTty) {
    return `tty:${terminalTty}`;
  }

  const sessionHint = readMetadataString(participant, 'sessionHint');
  if (!sessionHint || terminalApp === 'Ghostty') {
    return null;
  }

  return `hint:${sessionHint}`;
}

function registrationDedupKey(participant: BrokerParticipant): string | null {
  const locator = registrationDedupLocator(participant);
  if (!locator) {
    return null;
  }

  const terminalApp = readMetadataString(participant, 'terminalApp') ?? 'unknown';
  const projectPath = readMetadataString(participant, 'projectPath');
  const projectName = participant.context?.projectName?.trim() || '';
  return [
    participantFamily(participant),
    terminalApp,
    projectPath || projectName,
    locator,
  ].join('\u0000');
}

function locatorStrength(participant: BrokerParticipant): number {
  if (readMetadataString(participant, 'terminalSessionID')) {
    return 3;
  }

  if (readMetadataString(participant, 'terminalTTY')) {
    return 2;
  }

  if (readMetadataString(participant, 'sessionHint')) {
    return 1;
  }

  return 0;
}

function shouldPreferParticipant(next: BrokerParticipant, current: BrokerParticipant): boolean {
  const nextStrength = locatorStrength(next);
  const currentStrength = locatorStrength(current);
  if (nextStrength !== currentStrength) {
    return nextStrength > currentStrength;
  }

  return next.participantId.localeCompare(current.participantId) > 0;
}

export function isParticipantActivelyPresent(
  participant: BrokerParticipant,
  activeWorkStateParticipantIds: ReadonlySet<string> = new Set()
): boolean {
  if (participant.presence === 'offline') {
    return false;
  }

  if (activeWorkStateParticipantIds.has(participant.participantId)) {
    return true;
  }

  if (participant.presence !== 'online') {
    return false;
  }

  const presenceMetadata = participant.presenceMetadata ?? {};
  const transport = typeof presenceMetadata.transport === 'string' ? presenceMetadata.transport : null;
  if (transport === 'websocket') {
    const connectionCount = presenceMetadata.connectionCount;
    return typeof connectionCount === 'number' ? connectionCount > 0 : true;
  }

  const source = typeof presenceMetadata.source === 'string' ? presenceMetadata.source : null;
  if (source === 'work-state') {
    return true;
  }

  return hasUsableTerminalLocator(participant);
}

export function dedupeActivelyPresentParticipants(
  participants: BrokerParticipant[],
  activeWorkStateParticipantIds: ReadonlySet<string> = new Set()
): BrokerParticipant[] {
  const keptIds = new Set<string>();
  const weakestByLocator = new Map<string, BrokerParticipant>();

  for (const participant of participants) {
    const hasActiveWorkState = activeWorkStateParticipantIds.has(participant.participantId);
    const dedupKey =
      !hasActiveWorkState && isRegistrationOnlyPresence(participant)
        ? registrationDedupKey(participant)
        : null;

    if (!dedupKey) {
      keptIds.add(participant.participantId);
      continue;
    }

    const current = weakestByLocator.get(dedupKey);
    if (!current || shouldPreferParticipant(participant, current)) {
      weakestByLocator.set(dedupKey, participant);
    }
  }

  for (const participant of weakestByLocator.values()) {
    keptIds.add(participant.participantId);
  }

  return participants.filter((participant) => keptIds.has(participant.participantId));
}
