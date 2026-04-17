import type { JumpResult, JumpTarget } from '../../../jump/types';
import { invokeJumpCommand } from './transport';

export async function jumpWithAliasFallback(target: JumpTarget): Promise<JumpResult> {
  return invokeJumpCommand('jump_by_alias', target);
}
