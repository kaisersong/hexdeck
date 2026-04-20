import type {
  ActivityCardApprovalProjection,
  ActivityCardQuestionOption,
  ActivityCardProjection,
  ActivityCardQuestionProjection
} from '../../lib/activity-card/types';
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

function normalizeCardText(value: string | undefined): string {
  if (!value) {
    return '';
  }

  return value.replace(/\\n/g, '\n').replace(/\/n/g, '\n').trim();
}

function getJumpLabel(card: ActivityCardProjection): string {
  return `Open agent context for ${card.summary}`;
}

function getCardSupportingText(card: ActivityCardProjection): string {
  switch (card.kind) {
    case 'approval':
      return card.detailText ?? '';
    case 'question':
      return card.prompt;
    case 'completion':
      return card.detailText ?? '任务已完成，点击可直接跳回对应 agent';
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
  const normalizedSupportingText = normalizeCardText(supportingText);
  const normalizedCommandLine = normalizeCardText(card.commandLine);
  const normalizedCommandPreview = normalizeCardText(card.commandPreview);

  return (
    <>
      {normalizedSupportingText ? (
        <p className="floating-card__body floating-card__body--approval">{normalizedSupportingText}</p>
      ) : null}
      {card.commandTitle ? (
        <p className="floating-card__section-label">{card.commandTitle}</p>
      ) : null}
      {hasCommandBlock ? (
        <div className="floating-card__command" aria-label="Approval command preview">
          {normalizedCommandLine ? <p className="floating-card__command-primary">{normalizedCommandLine}</p> : null}
          {normalizedCommandPreview ? <p className="floating-card__command-secondary">{normalizedCommandPreview}</p> : null}
        </div>
      ) : null}
    </>
  );
}

function renderQuestionBody(card: ActivityCardQuestionProjection, supportingText: string) {
  const normalizedSupportingText = normalizeCardText(supportingText);
  const normalizedDetailText = normalizeCardText(card.detailText);
  return (
    <>
      <p className="floating-card__body">{normalizedSupportingText}</p>
      {normalizedDetailText ? (
        <p className="floating-card__body floating-card__body--question-detail">{normalizedDetailText}</p>
      ) : null}
    </>
  );
}

function renderCardBody(card: ActivityCardProjection, supportingText: string) {
  if (card.kind === 'approval') {
    return renderApprovalBody(card, supportingText);
  }

  if (card.kind === 'question') {
    return renderQuestionBody(card, supportingText);
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
          aria-label={option.label}
          onClick={() => onQuestionSelect?.(option)}
        >
          <span className="action-button__label">{option.label}</span>
          {option.description ? (
            <span className="action-button__description">{option.description}</span>
          ) : null}
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
  const canJump = card.kind === 'completion' && Boolean(card.jumpTarget && onJump);

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
          {renderCardBody(card, supportingText)}
          {sourceLine ? <p className="floating-card__source">{sourceLine}</p> : null}
        </button>
      ) : (
        <div className="floating-card__content">
          {renderCardBody(card, supportingText)}
          {sourceLine ? <p className="floating-card__source">{sourceLine}</p> : null}
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
