import type { JumpResult, JumpTarget } from '../../../jump/types';
import { invokeJumpCommand } from './transport';

export async function jumpWithIterm(target: JumpTarget): Promise<JumpResult> {
  return invokeJumpCommand('jump_with_iterm', target);
}
