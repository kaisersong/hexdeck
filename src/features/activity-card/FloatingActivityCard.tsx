import { useEffect } from 'react';
import type { ActivityCardApprovalProjection, ActivityCardQuestionOption, ActivityCardProjection } from '../../lib/activity-card/types';
import type { BrokerApprovalDecisionMode } from '../../lib/broker/types';
import type { JumpTarget } from '../../lib/jump/types';

export interface FloatingActivityCardProps {
  card: ActivityCardProjection;
  pendingApprovalIds?: Set<string>;
  onApprovalDecision?: (mode: BrokerApprovalDecisionMode) => void;
  onQuestionSelect?: (option: ActivityCardQuestionOption) => void;
  onDismiss?: () => void;
  onJump?: (target: JumpTarget) => void;
  onHoverChange?: (hovered: boolean) => void;
}

function getJumpLabel(card: ActivityCardProjection): string {
  return `Open agent context for ${card.summary}`;
}

function getCardSupportingText(card: ActivityCardProjection): string {
  switch (card.kind) {
    case 'approval':
      return card.detailText ?? '需要你立即确认这个 agent 意图';
    case 'question':
      return card.prompt;
    case 'completion':
      return '任务已完成，点击可直接跳回对应 agent';
  }
}

function getDisplayTitle(card: ActivityCardProjection): string {
  return card.actorLabel ? `${card.actorLabel} · ${card.summary}` : card.summary;
}

function getSourceLine(card: ActivityCardProjection): string | null {
  return card.projectLabel ?? null;
}

function renderApprovalBody(card: ActivityCardApprovalProjection, supportingText: string) {
  const hasCommandBlock = Boolean(card.commandLine || card.commandPreview);

  return (
    <>
      <p className="floating-card__body floating-card__body--approval">{supportingText}</p>
      {card.commandTitle ? (
        <p className="floating-card__section-label">{card.commandTitle}</p>
      ) : null}
      {hasCommandBlock ? (
        <div className="floating-card__command" aria-label="Approval command preview">
          {card.commandLine ? <p className="floating-card__command-primary">{card.commandLine}</p> : null}
          {card.commandPreview ? <p className="floating-card__command-secondary">{card.commandPreview}</p> : null}
        </div>
      ) : null}
    </>
  );
}

function renderCardBody(card: ActivityCardProjection, supportingText: string) {
  if (card.kind === 'approval') {
    return renderApprovalBody(card, supportingText);
  }

  return <p className="floating-card__body">{supportingText}</p>;
}

function ApprovalActions({
  card,
  pendingApprovalIds,
  onApprovalDecision,
}: {
  card: ActivityCardApprovalProjection;
  pendingApprovalIds?: Set<string>;
  onApprovalDecision?: (mode: BrokerApprovalDecisionMode) => void;
}) {
  const isPending = pendingApprovalIds?.has(card.approvalId) ?? false;

  return (
    <div className="floating-card__actions">
      {card.actions.map((action) => (
        <button
          key={action.decisionMode}
          type="button"
          className={`action-button action-button--${action.decisionMode}`}
          disabled={isPending}
          onClick={() => onApprovalDecision?.(action.decisionMode)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

function QuestionActions({
  card,
  onQuestionSelect,
}: {
  card: Extract<ActivityCardProjection, { kind: 'question' }>;
  onQuestionSelect?: (option: ActivityCardQuestionOption) => void;
}) {
  const disabled = !onQuestionSelect;

  return (
    <div className="floating-card__actions" aria-label="Question options">
      {card.options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="action-button action-button--question"
          disabled={disabled}
          onClick={() => onQuestionSelect?.(option)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function FloatingActivityCard({
  card,
  pendingApprovalIds,
  onApprovalDecision,
  onQuestionSelect,
  onDismiss,
  onJump,
  onHoverChange,
}: FloatingActivityCardProps) {
  const displayTitle = getDisplayTitle(card);
  const sourceLine = getSourceLine(card);
  const supportingText = getCardSupportingText(card);
  const approvalPending = card.kind === 'approval' && (pendingApprovalIds?.has(card.approvalId) ?? false);
  const canJump = Boolean(card.jumpTarget && onJump);

  useEffect(() => {
    if (card.kind !== 'approval' || !onApprovalDecision || approvalPending) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 'y') {
        event.preventDefault();
        onApprovalDecision('yes');
      }
      if (key === 'a') {
        event.preventDefault();
        onApprovalDecision('always');
      }
      if (key === 'n') {
        event.preventDefault();
        onApprovalDecision('no');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [approvalPending, card, onApprovalDecision]);

  return (
    <article
      className={`floating-card floating-card--${card.kind}`}
      data-activity-card-surface
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <div className="floating-card__header">
        <div className="floating-card__identity">
          <span className="floating-card__dot" aria-hidden="true" />
          <div className="floating-card__identity-copy">
            <h1 className="floating-card__summary">{displayTitle}</h1>
          </div>
        </div>
        <div className="floating-card__chips" aria-label="activity card metadata">
          {card.terminalLabel ? <span className="floating-card__chip">{card.terminalLabel}</span> : null}
          <button
            type="button"
            className="floating-card__dismiss"
            aria-label="Close activity card"
            onClick={() => onDismiss?.()}
          >
            Close
          </button>
        </div>
      </div>

      {canJump ? (
        <button
          type="button"
          className="floating-card__content floating-card__content--interactive"
          aria-label={getJumpLabel(card)}
          onClick={() => onJump?.(card.jumpTarget!)}
        >
          {sourceLine ? <p className="floating-card__source">{sourceLine}</p> : null}
          {renderCardBody(card, supportingText)}
        </button>
      ) : (
        <div className="floating-card__content">
          {sourceLine ? <p className="floating-card__source">{sourceLine}</p> : null}
          {renderCardBody(card, supportingText)}
        </div>
      )}

      {card.kind === 'approval' ? (
        <ApprovalActions
          card={card}
          pendingApprovalIds={pendingApprovalIds}
          onApprovalDecision={onApprovalDecision}
        />
      ) : null}

      {card.kind === 'question' ? (
        <QuestionActions card={card} onQuestionSelect={onQuestionSelect} />
      ) : null}
    </article>
  );
}
