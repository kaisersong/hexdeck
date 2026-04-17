import { describe, expect, it } from 'vitest';
import { buildActivityCardsFromSeed } from '../../../src/lib/activity-card/projections';

describe('buildActivityCardsFromSeed', () => {
  it('builds approval, question, and completion cards in priority order', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [
        {
          participantId: 'agent-1',
          alias: 'codex4',
          kind: 'agent',
          tool: 'Claude Code',
          metadata: {
            terminalApp: 'Ghostty',
            terminalSessionID: 'session-1',
            projectPath: '/Users/song/projects/hexdeck',
          },
          context: {
            projectName: 'HexDeck',
          },
        },
      ],
      workStates: [],
      events: [
        {
          id: 101,
          type: 'ask_clarification',
          payload: {
            participantId: 'agent-1',
            summary: 'Which layout should I use?',
            selectionMode: 'single-select',
            options: [
              { value: 'compact', label: 'Compact' },
              { value: 'expanded', label: 'Expanded' },
            ],
          },
        },
        {
          id: 102,
          type: 'report_progress',
          payload: {
            participantId: 'agent-1',
            summary: 'Implementation is complete',
            stage: 'completed',
          },
        },
      ],
      approvals: [
        {
          approvalId: 'approval-1',
          taskId: 'task-1',
          summary: 'Deploy approval needed',
          decision: 'pending',
        },
      ],
    });

    expect(cards.map((card) => card.kind)).toEqual(['approval', 'question', 'completion']);
    expect(cards[0]).toMatchObject({
      kind: 'approval',
      approvalId: 'approval-1',
      actionMode: 'action',
      cardId: 'approval:approval-1',
      actions: [
        { label: 'Yes', decisionMode: 'yes' },
        { label: 'Always', decisionMode: 'always' },
        { label: 'No', decisionMode: 'no' },
      ],
    });
    const questionCard = cards[1];
    if (questionCard.kind !== 'question') {
      throw new Error(`expected question card, got ${questionCard.kind}`);
    }

    expect(questionCard).toMatchObject({
      kind: 'question',
      selectionMode: 'single-select',
      prompt: 'Which layout should I use?',
      cardId: 'question:101',
      questionId: 'question:101',
    });
    expect(questionCard.options).toEqual([
      { value: 'compact', label: 'Compact' },
      { value: 'expanded', label: 'Expanded' },
    ]);
    expect(questionCard.actorLabel).toBe('@codex4');
    expect(questionCard.projectLabel).toBe('HexDeck');
    expect(questionCard.toolLabel).toBe('Claude Code');
    expect(questionCard.terminalLabel).toBe('Ghostty');
    expect(questionCard.jumpTarget?.participantId).toBe('agent-1');
    expect(cards[2]).toMatchObject({
      kind: 'completion',
      stage: 'completed',
      summary: 'Implementation is complete',
      cardId: 'completion:102',
    });
    expect(cards[2].jumpTarget?.participantId).toBe('agent-1');
  });

  it('reads question prompt, detail, options, and sender identity from payload body', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [
        {
          participantId: 'agent-1',
          alias: 'claude2',
          kind: 'agent',
          tool: 'Claude Code',
          metadata: {
            terminalApp: 'Terminal.app',
          },
          context: {
            projectName: 'projects',
          },
        },
      ],
      workStates: [],
      events: [
        {
          id: 111,
          type: 'ask_clarification',
          fromParticipantId: 'agent-1',
          payload: {
            body: {
              summary: '删除文件',
              prompt: '是否确认永久删除此文件？',
              detailText: '目标文件：aws-freeflow-demo.svg',
              selectionMode: 'single-select',
              options: [
                { value: 'yes', label: '确认删除', description: '执行 rm /tmp/example.txt' },
                { value: 'no', label: '取消', description: '保留文件，不执行任何操作' },
              ],
            },
          },
        },
      ],
      approvals: [],
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: 'question',
      summary: '删除文件',
      prompt: '是否确认永久删除此文件？',
      detailText: '目标文件：aws-freeflow-demo.svg',
      actorLabel: '@claude2',
      projectLabel: 'projects',
      terminalLabel: 'Terminal.app',
    });
    if (cards[0].kind !== 'question') {
      throw new Error(`expected question card, got ${cards[0].kind}`);
    }
    expect(cards[0].options).toEqual([
      { value: 'yes', label: '确认删除', description: '执行 rm /tmp/example.txt' },
      { value: 'no', label: '取消', description: '保留文件，不执行任何操作' },
    ]);
  });

  it('keeps approval, question, and completion grouped even when completion appears before question', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [],
      workStates: [],
      events: [
        {
          id: 302,
          type: 'report_progress',
          payload: {
            summary: 'Implementation is complete',
            stage: 'completed',
          },
        },
        {
          id: 301,
          type: 'ask_clarification',
          payload: {
            summary: 'Which option should I use?',
            selectionMode: 'single-select',
            options: [{ value: 'a', label: 'A' }],
          },
        },
      ],
      approvals: [
        {
          approvalId: 'approval-2',
          taskId: 'task-2',
          summary: 'Deploy approval needed',
          decision: 'pending',
        },
      ],
    });

    expect(cards.map((card) => card.kind)).toEqual(['approval', 'question', 'completion']);
    expect(cards[0].cardId).toBe('approval:approval-2');
    expect(cards[1].cardId).toBe('question:301');
    expect(cards[1]).toMatchObject({
      kind: 'question',
      questionId: 'question:301',
      selectionMode: 'single-select',
    });
    expect(cards[2].cardId).toBe('completion:302');
  });

  it('builds a completion card from broker progress events that carry summary text in payload.body', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [
        {
          participantId: 'agent-1',
          alias: 'claude5',
          kind: 'agent',
          context: {
            projectName: 'projects',
          },
        },
      ],
      workStates: [],
      events: [
        {
          id: 900,
          type: 'report_progress',
          taskId: 'task-1',
          payload: {
            participantId: 'agent-1',
            stage: 'completed',
            body: {
              summary: 'Task complete and ready for review',
            },
          },
        },
      ],
      approvals: [],
    });

    expect(cards).toContainEqual(expect.objectContaining({
      kind: 'completion',
      summary: 'Task complete and ready for review',
      taskId: 'task-1',
      actorLabel: '@claude5',
      projectLabel: 'projects',
    }));
  });

  it('preserves distinct question summary and prompt text when both are present', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [],
      workStates: [],
      events: [
        {
          id: 401,
          type: 'ask_clarification',
          payload: {
            summary: 'Which layout should I use?',
            prompt: 'Choose the compact layout',
            selectionMode: 'single-select',
            options: [{ value: 'compact', label: 'Compact' }],
          },
        },
      ],
      approvals: [],
    });

    const questionCard = cards[0];
    if (questionCard.kind !== 'question') {
      throw new Error(`expected question card, got ${questionCard.kind}`);
    }

    expect(questionCard.summary).toBe('Which layout should I use?');
    expect(questionCard.prompt).toBe('Choose the compact layout');
  });

  it('skips clarification questions that are not single-select and progress events that are not completed', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [],
      workStates: [],
      events: [
        {
          id: 201,
          type: 'ask_clarification',
          payload: {
            summary: 'Choose one or more options',
            selectionMode: 'multi-select',
            options: [{ value: 'a', label: 'A' }],
          },
        },
        {
          id: 202,
          type: 'report_progress',
          payload: {
            summary: 'Still working',
            stage: 'in_progress',
          },
        },
      ],
      approvals: [],
    });

    expect(cards).toEqual([]);
  });

  it('derives a pending approval card from replay request_approval events', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [
        {
          participantId: 'agent-1',
          alias: 'codex4',
          kind: 'agent',
          tool: 'Claude Code',
          metadata: {
            terminalApp: 'Ghostty',
            terminalSessionID: 'session-1',
            projectPath: '/Users/song/projects/hexdeck',
          },
          context: {
            projectName: 'HexDeck',
          },
        },
      ],
      workStates: [],
      events: [
        {
          id: 501,
          type: 'request_approval',
          taskId: 'task-approval-1',
          threadId: 'thread-approval-1',
          payload: {
            approvalId: 'approval-event-1',
            participantId: 'agent-1',
            body: {
              summary: 'Ship the result?',
            },
          },
        },
      ],
      approvals: [],
    });

    expect(cards).toContainEqual(expect.objectContaining({
      kind: 'approval',
      approvalId: 'approval-event-1',
      taskId: 'task-approval-1',
      summary: 'Ship the result?',
      actorLabel: '@codex4',
      projectLabel: 'HexDeck',
      toolLabel: 'Claude Code',
      terminalLabel: 'Ghostty',
    }));
  });

  it('uses approval action labels provided by the agent payload', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [],
      workStates: [],
      events: [
        {
          id: 551,
          type: 'request_approval',
          taskId: 'task-approval-3',
          payload: {
            approvalId: 'approval-event-3',
            actions: [
              { label: 'Run Bash', decisionMode: 'yes' },
              { label: 'Always allow Bash', decisionMode: 'always' },
              { label: 'Deny', decisionMode: 'no' },
            ],
            body: {
              summary: 'Claude wants to run Bash.',
            },
          },
        },
      ],
      approvals: [],
    });

    expect(cards).toContainEqual(expect.objectContaining({
      kind: 'approval',
      approvalId: 'approval-event-3',
      actions: [
        { label: 'Run Bash', decisionMode: 'yes' },
        { label: 'Always allow Bash', decisionMode: 'always' },
        { label: 'Deny', decisionMode: 'no' },
      ],
    }));
  });

  it('uses real approval actions and presentation fields from pending approval items', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [
        {
          participantId: 'agent-1',
          alias: 'claude2',
          kind: 'agent',
          tool: 'Claude Code',
          context: {
            projectName: 'projects',
          },
        },
      ],
      workStates: [],
      events: [],
      approvals: [
        {
          approvalId: 'approval-pending-1',
          taskId: 'task-pending-1',
          participantId: 'agent-1',
          decision: 'pending',
          summary: '删除文件',
          actions: [
            { label: '确认删除', decisionMode: 'yes' },
            { label: '取消', decisionMode: 'no' },
          ],
          body: {
            detailText: '即将删除最新文件\\n此操作不可逆',
            commandTitle: 'Delete',
            commandLine: 'rm /tmp/example.txt',
          },
        },
      ],
    });

    expect(cards).toContainEqual(expect.objectContaining({
      kind: 'approval',
      approvalId: 'approval-pending-1',
      summary: '删除文件',
      actorLabel: '@claude2',
      projectLabel: 'projects',
      actions: [
        { label: '确认删除', decisionMode: 'yes' },
        { label: '取消', decisionMode: 'no' },
      ],
      detailText: '即将删除最新文件\n此操作不可逆',
      commandTitle: 'Delete',
      commandLine: 'rm /tmp/example.txt',
    }));
  });

  it('suppresses generic codex hook approval cards from request_approval events', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [
        {
          participantId: 'agent-1',
          alias: 'codex3',
          kind: 'agent',
          tool: 'Codex',
          context: {
            projectName: 'xiaok-cli',
          },
        },
      ],
      workStates: [],
      events: [
        {
          id: 552,
          type: 'request_approval',
          taskId: 'task-approval-codex',
          payload: {
            approvalId: 'approval-codex-noise',
            participantId: 'agent-1',
            delivery: {
              semantic: 'actionable',
              source: 'codex-hook-approval',
            },
            nativeHookApproval: {
              agentTool: 'codex',
            },
            body: {
              summary: 'Codex needs approval to run Bash.',
            },
          },
        },
      ],
      approvals: [],
    });

    expect(cards).toEqual([]);
  });

  it('suppresses pending approval items that are codex test noise by summary', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [],
      workStates: [],
      events: [],
      approvals: [
        {
          approvalId: 'approval-codex-summary-noise',
          taskId: 'task-codex-summary-noise',
          summary: 'Codex needs approval to run Bash.',
          decision: 'pending',
        },
      ],
    });

    expect(cards).toEqual([]);
  });

  it('suppresses pending approval items when the generic codex noise only exists in body.summary', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [],
      workStates: [],
      events: [],
      approvals: [
        {
          approvalId: 'approval-codex-body-noise',
          taskId: 'task-codex-body-noise',
          summary: '',
          decision: 'pending',
          body: {
            summary: 'Codex needs approval to run Bash.',
          },
        },
      ],
    });

    expect(cards).toEqual([]);
  });

  it('keeps codex approval cards when the summary is a real user-facing confirmation', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [
        {
          participantId: 'agent-9',
          alias: 'codex3',
          kind: 'agent',
          tool: 'Codex',
          context: {
            projectName: 'xiaok-cli',
          },
        },
      ],
      workStates: [],
      events: [
        {
          id: 553,
          type: 'request_approval',
          taskId: 'task-codex-real',
          payload: {
            approvalId: 'approval-codex-real',
            participantId: 'agent-9',
            delivery: {
              semantic: 'actionable',
              source: 'codex-hook-approval',
            },
            nativeHookApproval: {
              agentTool: 'codex',
            },
            body: {
              summary: '删除最新文件',
              detailText: '即将删除 workspace 目录下最新文件',
            },
            actions: [
              { label: '确认删除', decisionMode: 'yes' },
              { label: '取消', decisionMode: 'no' },
            ],
          },
        },
      ],
      approvals: [],
    });

    expect(cards).toContainEqual(expect.objectContaining({
      kind: 'approval',
      approvalId: 'approval-codex-real',
      summary: '删除最新文件',
      detailText: '即将删除 workspace 目录下最新文件',
      actions: [
        { label: '确认删除', decisionMode: 'yes' },
        { label: '取消', decisionMode: 'no' },
      ],
      actorLabel: '@codex3',
      projectLabel: 'xiaok-cli',
    }));
  });

  it('extracts optional approval detail and command preview fields from the payload body', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [],
      workStates: [],
      events: [
        {
          id: 560,
          type: 'request_approval',
          taskId: 'task-approval-4',
          payload: {
            approvalId: 'approval-event-4',
            approvalScope: 'run_command',
            body: {
              summary: 'Claude wants to run Bash.',
              detail: '需要创建 skill 目录并进入 scripts 子目录。',
              commandLine: '$ mkdir -p /Users/song/.claude/skills/kai-export-ppt-lite/scripts',
            },
          },
        },
      ],
      approvals: [],
    });

    expect(cards).toContainEqual(expect.objectContaining({
      kind: 'approval',
      approvalId: 'approval-event-4',
      detailText: '需要创建 skill 目录并进入 scripts 子目录。',
      commandTitle: 'Bash',
      commandLine: '$ mkdir -p /Users/song/.claude/skills/kai-export-ppt-lite/scripts',
      commandPreview: 'mkdir -p /Users/song/.claude/skills/kai-export-ppt-lite/scripts',
    }));
  });

  it('drops derived approval cards after a respond_approval event arrives', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [],
      workStates: [],
      events: [
        {
          id: 601,
          type: 'request_approval',
          taskId: 'task-approval-2',
          payload: {
            approvalId: 'approval-event-2',
            body: {
              summary: 'Approve deploy?',
            },
          },
        },
        {
          id: 602,
          type: 'respond_approval',
          taskId: 'task-approval-2',
          payload: {
            approvalId: 'approval-event-2',
            decision: 'approved',
          },
        },
      ],
      approvals: [],
    });

    expect(cards.find((card) => card.kind === 'approval')).toBeUndefined();
  });
});
