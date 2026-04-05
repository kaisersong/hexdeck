export type JumpPrecision = 'exact' | 'best_effort' | 'unsupported';

export interface JumpTarget {
  participantId: string;
  terminalApp: string;
  precision: JumpPrecision;
  sessionHint: string | null;
  projectPath: string | null;
}

export interface JumpResult {
  ok: boolean;
  precision: JumpPrecision;
  reason?: string;
}
