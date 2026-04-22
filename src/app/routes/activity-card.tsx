import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ActivityCardApprovalProjection, ActivityCardProjection, ActivityCardQuestionOption, ActivityCardQuestionProjection } from '../../lib/activity-card/types';
import type { BrokerApprovalDecisionMode } from '../../lib/broker/types';
import type { JumpTarget } from '../../lib/jump/types';
import { FloatingActivityCard } from '../../features/activity-card/FloatingActivityCard';

const ACTIVITY_CARD_WINDOW_WIDTH = 680;
const ACTIVITY_CARD_MIN_HEIGHTS = {
  approval: 336,
  question: 232,
  completion: 180,
} as const;
const ACTIVITY_CARD_MAX_HEIGHT = 520;
const ACTIVITY_CARD_WINDOW_HEIGHT_BUFFER = 2;
const ACTIVITY_CARD_SHELL_STYLE = {
  borderBottomLeftRadius: '10px',
  borderBottomRightRadius: '10px',
} satisfies CSSProperties;

interface ActivityCardMeasurement {
  shellHeight: number;
  cardHeight: number;
  targetWindowHeight: number;
  actualInnerHeight: number | null;
  actualOuterHeight: number | null;
  scaleFactor: number | null;
}

interface NativeActivityCardMeasurement {
  targetHeight: number;
  innerHeight: number;
  outerHeight: number;
  scaleFactor: number;
}

export interface ActivityCardDebugInfo {
  project: string;
  cardCount: number;
  activeCardId: string | null;
  latestEventId: number | null;
  connectionState: string;
  connectionMessage: string | null;
  error: string | null;
}

function getEstimatedWindowHeightForCard(card: ActivityCardProjection): number {
  return ACTIVITY_CARD_MIN_HEIGHTS[card.kind];
}

function clampActivityCardHeight(height: number, minHeight: number): number {
  return Math.min(Math.max(height, minHeight), ACTIVITY_CARD_MAX_HEIGHT);
}

function getMeasuredWindowHeight(shell: HTMLElement | null, card: ActivityCardProjection): ActivityCardMeasurement {
  const estimatedHeight = getEstimatedWindowHeightForCard(card);
  if (!shell) {
    return {
      shellHeight: 0,
      cardHeight: 0,
      targetWindowHeight: estimatedHeight,
      actualInnerHeight: null,
      actualOuterHeight: null,
      scaleFactor: null,
    };
  }

  const cardSurface = shell.querySelector<HTMLElement>('[data-activity-card-surface]');
  const measuredSurfaceHeight = cardSurface
    ? Math.max(cardSurface.scrollHeight, cardSurface.getBoundingClientRect().height)
    : 0;
  const measuredShellHeight = Math.max(shell.scrollHeight, shell.getBoundingClientRect().height);
  const measuredHeight = Math.ceil(Math.max(measuredSurfaceHeight, measuredShellHeight));

  if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) {
    return {
      shellHeight: Math.ceil(measuredShellHeight),
      cardHeight: Math.ceil(measuredSurfaceHeight),
      targetWindowHeight: estimatedHeight,
      actualInnerHeight: null,
      actualOuterHeight: null,
      scaleFactor: null,
    };
  }

  return {
    shellHeight: Math.ceil(measuredShellHeight),
    cardHeight: Math.ceil(measuredSurfaceHeight),
    targetWindowHeight: clampActivityCardHeight(measuredHeight + ACTIVITY_CARD_WINDOW_HEIGHT_BUFFER, 1),
    actualInnerHeight: null,
    actualOuterHeight: null,
    scaleFactor: null,
  };
}

async function readNativeWindowMeasurement(currentWindow: {
  innerSize?: () => Promise<{ height: number }>;
  outerSize?: () => Promise<{ height: number }>;
  scaleFactor?: () => Promise<number>;
}): Promise<Pick<ActivityCardMeasurement, 'actualInnerHeight' | 'actualOuterHeight' | 'scaleFactor'>> {
  if (!currentWindow.innerSize || !currentWindow.outerSize || !currentWindow.scaleFactor) {
    return {
      actualInnerHeight: null,
      actualOuterHeight: null,
      scaleFactor: null,
    };
  }

  const scaleFactor = await currentWindow.scaleFactor();
  const [innerSize, outerSize] = await Promise.all([
    currentWindow.innerSize(),
    currentWindow.outerSize(),
  ]);
  const safeScaleFactor = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;

  return {
    actualInnerHeight: Math.round(innerSize.height / safeScaleFactor),
    actualOuterHeight: Math.round(outerSize.height / safeScaleFactor),
    scaleFactor: safeScaleFactor,
  };
}

function parseNativeActivityCardMeasurement(value: unknown): NativeActivityCardMeasurement | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const measurement = value as Partial<NativeActivityCardMeasurement>;
  if (
    typeof measurement.targetHeight !== 'number' ||
    typeof measurement.innerHeight !== 'number' ||
    typeof measurement.outerHeight !== 'number' ||
    typeof measurement.scaleFactor !== 'number'
  ) {
    return null;
  }

  return {
    targetHeight: measurement.targetHeight,
    innerHeight: measurement.innerHeight,
    outerHeight: measurement.outerHeight,
    scaleFactor: measurement.scaleFactor,
  };
}

function getPreviewCard(): ActivityCardProjection | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const preview = new URLSearchParams(window.location.search).get('preview');
  if (!preview) {
    return null;
  }

  if (preview === 'question') {
    return {
      cardId: 'preview:question',
      resolutionKey: 'question:preview-question',
      kind: 'question',
      priority: 'attention',
      summary: 'Which target should I use?',
      actorLabel: '@codex3',
      projectLabel: 'hexdeck',
      terminalLabel: 'Ghostty',
      questionId: 'preview-question',
      prompt: 'Choose a target',
      selectionMode: 'single-select',
      options: [
        { label: 'Staging', value: 'staging' },
        { label: 'Production', value: 'production' },
      ],
      participantId: 'preview-agent',
      taskId: 'preview-task',
      threadId: 'preview-thread',
    };
  }

  if (preview === 'completion') {
    return {
      cardId: 'preview:completion',
      resolutionKey: 'completion:preview-completion',
      kind: 'completion',
      priority: 'ambient',
      summary: 'Completed rollout tracking slice.',
      actorLabel: '@codex3',
      projectLabel: 'hexdeck',
      terminalLabel: 'Ghostty',
      stage: 'completed',
      participantId: 'preview-agent',
      taskId: 'preview-task',
      threadId: 'preview-thread',
    };
  }

  return {
    cardId: 'preview:approval',
    resolutionKey: 'approval:preview-approval',
    kind: 'approval',
    priority: 'critical',
    summary: 'Claude wants to run Bash.',
    actorLabel: '@codex3',
    projectLabel: 'hexdeck',
    terminalLabel: 'Ghostty',
    approvalId: 'preview-approval',
    actionMode: 'action',
    decision: 'pending',
    taskId: 'preview-task',
    actions: [
      { label: 'No', decisionMode: 'no' },
      { label: 'Yes', decisionMode: 'yes' },
      { label: 'Always', decisionMode: 'always' },
    ],
    detailText: '本地预览卡。它绕过 broker，只用于调顶部浮窗样式。',
    commandTitle: 'Bash',
    commandLine: '$ mkdir -p /Users/song/.claude/skills/kai-export-ppt-lite/scripts',
    commandPreview: 'mkdir -p /Users/song/.claude/skills/kai-export-ppt-lite/scripts',
  };
}

async function debugLogActivityCardFrontend(message: string): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const debugEnabled = params.has('debugLive') || params.get('debug') === 'activity-card';
  if (!debugEnabled) {
    return;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('debug_log_activity_card_frontend', { message });
  } catch {
    // Ignore when not running in Tauri.
  }
}

export interface ActivityCardRouteProps {
  card: ActivityCardProjection | null;
  windowVisibility?: 'hide' | 'keep' | 'show';
  pendingApprovalIds?: Set<string>;
  debugInfo?: ActivityCardDebugInfo | null;
  onApprovalAction?: (card: ActivityCardApprovalProjection, decisionMode: BrokerApprovalDecisionMode) => void;
  onQuestionAction?: (card: ActivityCardQuestionProjection, option: ActivityCardQuestionOption) => void;
  onDismiss?: () => void;
  onJump?: (target: JumpTarget) => void;
  onHoverChange?: (hovered: boolean) => void;
}

function isSuppressedTestApprovalCard(card: ActivityCardProjection | null): boolean {
  if (!card || card.kind !== 'approval') {
    return false;
  }

  const summary = card.summary.trim().toLowerCase();
  const actorLabel = card.actorLabel?.trim().toLowerCase() ?? '';
  return summary.startsWith('codex needs approval')
    || actorLabel.startsWith('@codex');
}

function DebugMetrics({
  measurement,
  debugInfo,
  compact,
}: {
  measurement: ActivityCardMeasurement | null;
  debugInfo?: ActivityCardDebugInfo | null;
  compact?: boolean;
}) {
  const formatHeight = (height: number | null | undefined) => (
    typeof height === 'number' ? `${height}px` : 'pending'
  );

  if (compact) {
    return (
      <div className="activity-card-debug-metrics" aria-label="activity card debug measurements">
        card {formatHeight(measurement?.cardHeight)}
        {' '}· inner {formatHeight(measurement?.actualInnerHeight)}
        {' '}· outer {formatHeight(measurement?.actualOuterHeight)}
      </div>
    );
  }

  return (
    <div className="activity-card-debug-metrics" aria-label="activity card debug measurements">
      shell {formatHeight(measurement?.shellHeight)} · card {formatHeight(measurement?.cardHeight)} · target{' '}
      {formatHeight(measurement?.targetWindowHeight)}
      {measurement?.actualInnerHeight === undefined || measurement?.actualInnerHeight === null
        ? null
        : <> · inner {measurement.actualInnerHeight}px</>}
      {measurement?.actualOuterHeight === undefined || measurement?.actualOuterHeight === null
        ? null
        : <> · outer {measurement.actualOuterHeight}px</>}
      {measurement?.scaleFactor === undefined || measurement?.scaleFactor === null
        ? null
        : <> · scale {measurement.scaleFactor}x</>}
      {debugInfo ? (
        <>
          {' '}· project {debugInfo.project || 'none'} · cards {debugInfo.cardCount} · active{' '}
          {debugInfo.activeCardId ?? 'none'} · latest {debugInfo.latestEventId ?? 'none'} · state{' '}
          {debugInfo.connectionState}
          {debugInfo.error ? <> · error {debugInfo.error}</> : null}
          {!debugInfo.error && debugInfo.connectionMessage ? <> · {debugInfo.connectionMessage}</> : null}
        </>
      ) : null}
    </div>
  );
}

export function ActivityCardRoute({
  card,
  windowVisibility = card ? 'show' : 'hide',
  pendingApprovalIds,
  debugInfo,
  onApprovalAction,
  onQuestionAction,
  onDismiss,
  onJump,
  onHoverChange,
}: ActivityCardRouteProps) {
  const shellRef = useRef<HTMLElement | null>(null);
  const previewCard = useMemo(() => getPreviewCard(), []);
  const showDebugMetrics = useMemo(() => Boolean(previewCard), [previewCard]);
  const displayCard = previewCard ?? card;
  const hasHiddenActivityCardWindowRef = useRef(false);
  const hasShownActivityCardWindowRef = useRef(false);
  const [measurement, setMeasurement] = useState<ActivityCardMeasurement | null>(null);
  const displayCardId = displayCard?.cardId ?? null;

  useEffect(() => {
    document.body.classList.add('activity-card-window');
    return () => {
      document.body.classList.remove('activity-card-window');
    };
  }, []);

  useEffect(() => {
    let dispose: (() => void) | undefined;

    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => {
        const currentWindow = getCurrentWindow();
        return currentWindow.onCloseRequested(async (event) => {
          event.preventDefault();
          if (onDismiss) {
            onDismiss();
            return;
          }

          await currentWindow.hide().catch(() => undefined);
        });
      })
      .then((unlisten) => {
        dispose = unlisten;
      })
      .catch(() => undefined);

    return () => {
      dispose?.();
    };
  }, [onDismiss]);

  useEffect(() => {
    if (!previewCard) {
      return;
    }

    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('show_activity_card_window'))
      .catch(() => undefined);
  }, [previewCard]);

  useEffect(() => {
    void debugLogActivityCardFrontend(
      `[route-render] visibility=${windowVisibility} card=${card?.cardId ?? 'null'} preview=${previewCard?.cardId ?? 'null'} display=${displayCardId ?? 'null'}`
    );
  }, [card?.cardId, displayCardId, previewCard?.cardId, windowVisibility]);

  useEffect(() => {
    if (previewCard || windowVisibility !== 'hide') {
      return;
    }

    hasHiddenActivityCardWindowRef.current = true;
    void debugLogActivityCardFrontend(
      `[route-hide] visibility=${windowVisibility} display=${displayCardId ?? 'null'}`
    );
    void Promise.all([
      import('@tauri-apps/api/core'),
    ])
      .then(async ([{ invoke }]) => {
        await Promise.resolve(invoke('hide_activity_card_window')).catch(() => undefined);
      })
      .catch(() => undefined);
  }, [previewCard, windowVisibility]);

  useEffect(() => {
    if (previewCard || windowVisibility === 'hide' || !displayCard) {
      return;
    }

    const shouldShow = windowVisibility === 'show'
      ? !hasShownActivityCardWindowRef.current || hasHiddenActivityCardWindowRef.current
      : hasHiddenActivityCardWindowRef.current;

    if (!shouldShow) {
      return;
    }

    hasHiddenActivityCardWindowRef.current = false;
    hasShownActivityCardWindowRef.current = true;
    void debugLogActivityCardFrontend(
      `[route-show] visibility=${windowVisibility} display=${displayCardId ?? 'null'} hiddenSeen=${hasHiddenActivityCardWindowRef.current}`
    );
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('show_activity_card_window'))
      .catch(() => undefined);
  }, [displayCard, displayCardId, previewCard, windowVisibility]);

  useLayoutEffect(() => {
    let cancelled = false;
    let animationFrame: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const timeoutIds: number[] = [];

    const syncWindowSize = async () => {
      if (cancelled) {
        return;
      }

      try {
        const [{ invoke }, { getCurrentWindow }, { LogicalSize }] = await Promise.all([
          import('@tauri-apps/api/core'),
          import('@tauri-apps/api/window'),
          import('@tauri-apps/api/dpi'),
        ]);
        const currentWindow = getCurrentWindow();
        if (!displayCard) {
          return;
        }
        const nextMeasurement = getMeasuredWindowHeight(shellRef.current, displayCard);
        const nativeResizeMeasurement = parseNativeActivityCardMeasurement(
          await Promise.resolve(
            invoke('resize_activity_card_window', {
              width: ACTIVITY_CARD_WINDOW_WIDTH,
              height: nextMeasurement.targetWindowHeight,
            })
          ).catch(() => null)
        );
        if (nativeResizeMeasurement) {
          setMeasurement({
            ...nextMeasurement,
            targetWindowHeight: Math.round(nativeResizeMeasurement.targetHeight),
            actualInnerHeight: Math.round(nativeResizeMeasurement.innerHeight),
            actualOuterHeight: Math.round(nativeResizeMeasurement.outerHeight),
            scaleFactor: nativeResizeMeasurement.scaleFactor,
          });
          return;
        }

        await currentWindow.setSize(new LogicalSize(ACTIVITY_CARD_WINDOW_WIDTH, nextMeasurement.targetWindowHeight));
        const nativeMeasurement = await readNativeWindowMeasurement(currentWindow);
        setMeasurement({
          ...nextMeasurement,
          ...nativeMeasurement,
        });
      } catch {
        // Ignore when not running in Tauri.
      }
    };

    if (!displayCard) {
      setMeasurement(null);
      return;
    }

    const scheduleWindowSizeSync = () => {
      if (cancelled) {
        return;
      }

      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }

      if (typeof window.requestAnimationFrame === 'function') {
        animationFrame = window.requestAnimationFrame(() => {
          animationFrame = null;
          void syncWindowSize();
        });
        return;
      }

      timeoutIds.push(window.setTimeout(() => {
        void syncWindowSize();
      }, 0));
    };

    const observedSurface = shellRef.current?.querySelector<HTMLElement>('[data-activity-card-surface]');

    if (typeof ResizeObserver !== 'undefined' && shellRef.current) {
      resizeObserver = new ResizeObserver(scheduleWindowSizeSync);
      resizeObserver.observe(shellRef.current);
      if (observedSurface) {
        resizeObserver.observe(observedSurface);
      }
    }

    scheduleWindowSizeSync();
    timeoutIds.push(window.setTimeout(scheduleWindowSizeSync, 50));
    timeoutIds.push(window.setTimeout(scheduleWindowSizeSync, 150));

    void document.fonts?.ready.then(scheduleWindowSizeSync);

    return () => {
      cancelled = true;
      if (animationFrame !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(animationFrame);
      }
      resizeObserver?.disconnect();
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
    };
  }, [displayCard]);

  if (!displayCard) {
    return null;
  }

  return (
    <main
      ref={shellRef}
      className="activity-card-shell"
      style={ACTIVITY_CARD_SHELL_STYLE}
      aria-label="activity-card"
    >
      <FloatingActivityCard
        card={displayCard}
        pendingApprovalIds={pendingApprovalIds}
        onDismiss={onDismiss}
        onApprovalDecision={
          displayCard.kind === 'approval'
            ? (mode) => onApprovalAction?.(displayCard, mode)
            : undefined
        }
        onQuestionSelect={
          displayCard.kind === 'question' && displayCard.participantId
            ? (option) => onQuestionAction?.(displayCard, option)
            : undefined
        }
        onJump={onJump}
        onHoverChange={onHoverChange}
      />
      {showDebugMetrics ? (
        <DebugMetrics measurement={measurement} debugInfo={debugInfo} />
      ) : null}
    </main>
  );
}
