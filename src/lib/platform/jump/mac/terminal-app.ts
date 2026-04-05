import type { JumpResult, JumpTarget } from '../../../jump/types';
import { invokeJumpCommand } from './transport';

export async function jumpWithTerminalApp(target: JumpTarget): Promise<JumpResult> {
  return invokeJumpCommand('jump_with_terminal_app', target);
}
