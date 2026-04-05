import type { JumpResult, JumpTarget } from '../../../jump/types';
import { invokeJumpCommand } from './transport';

export async function jumpWithGhostty(target: JumpTarget): Promise<JumpResult> {
  return invokeJumpCommand('jump_with_ghostty', target);
}
