export type JumpPrecision = 'exact' | 'best_effort' | 'unsupported';

export interface JumpTarget {
  participantId: string;
  alias: string;
  terminalApp: string;
  precision: JumpPrecision;
  sessionHint: string | null;
  terminalTTY: string | null;
  terminalSessionID: string | null;
  projectPath: string | null;
}

export interface JumpResult {
  ok: boolean;
  precision: JumpPrecision;
  reason?: string;
}
