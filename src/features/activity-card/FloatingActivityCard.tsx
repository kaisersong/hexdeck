import { useEffect } from 'react';
import type { ActivityCardApprovalProjection, ActivityCardQuestionOption, ActivityCardProjection } from '../../lib/activity-card/types';
import type { BrokerApprovalDecisionMode } from '../../lib/broker/types';
import type { JumpTarget } from '../../lib/jump/types';

export interface FloatingActivityCardProps {
  card: ActivityCardProjection;
  pendingApprovalIds?: Set<string>;
  onApprovalDecision?: (mode: BrokerApprovalDecisionMode) => void;
  onQuestionSelect?: (option: ActivityCardQuestionOption) => void;
  onJump?: (target: JumpTarget) => void;
  onHoverChange?: (hovered: boolean) => void;
}

function getCardLabel(card: ActivityCardProjection): string {
  switch (card.kind) {
    case 'approval':
      return 'Approval';
    case 'question':
      return 'Question';
    case 'completion':
      return 'Completion';
  }
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
      <button
        type="button"
        className="action-button"
        disabled={isPending}
        onClick={() => onApprovalDecision?.('yes')}
      >
        Yes
      </button>
      <button
        type="button"
        className="action-button"
        disabled={isPending}
        onClick={() => onApprovalDecision?.('always')}
      >
        Always
      </button>
      <button
        type="button"
        className="action-button"
        disabled={isPending}
        onClick={() => onApprovalDecision?.('no')}
      >
        No
      </button>
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
          className="action-button"
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
  onJump,
  onHoverChange,
}: FloatingActivityCardProps) {
  const label = getCardLabel(card);
  const approvalPending = card.kind === 'approval' && (pendingApprovalIds?.has(card.approvalId) ?? false);

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
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <p className="floating-card__eyebrow">{label}</p>
      <h1 className="floating-card__summary">{card.summary}</h1>
      {card.actorLabel ? <p className="floating-card__meta">{card.actorLabel}</p> : null}

      {card.kind === 'question' ? <p className="floating-card__body">{card.prompt}</p> : null}
      {card.kind === 'completion' ? <p className="floating-card__body">Completed</p> : null}

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

      {card.jumpTarget ? (
        <button
          type="button"
          className="action-button floating-card__jump"
          onClick={() => onJump?.(card.jumpTarget!)}
        >
          Jump
        </button>
      ) : null}
    </article>
  );
}
