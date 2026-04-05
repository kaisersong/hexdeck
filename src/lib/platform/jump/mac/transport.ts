import type { JumpResult, JumpTarget } from '../../../jump/types';

export async function invokeJumpCommand(command: string, target: JumpTarget): Promise<JumpResult> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<JumpResult>(command, { target });
  } catch {
    return {
      ok: false,
      precision: 'unsupported',
      reason: 'platform_unavailable',
    };
  }
}
