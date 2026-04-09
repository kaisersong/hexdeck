import type { ActivityCardApprovalProjection, ActivityCardProjection, ActivityCardQuestionOption, ActivityCardQuestionProjection } from '../../lib/activity-card/types';
import type { BrokerApprovalDecisionMode } from '../../lib/broker/types';
import type { JumpTarget } from '../../lib/jump/types';
import { FloatingActivityCard } from '../../features/activity-card/FloatingActivityCard';

export interface ActivityCardRouteProps {
  card: ActivityCardProjection | null;
  pendingApprovalIds?: Set<string>;
  onApprovalAction?: (card: ActivityCardApprovalProjection, decisionMode: BrokerApprovalDecisionMode) => void;
  onQuestionAction?: (card: ActivityCardQuestionProjection, option: ActivityCardQuestionOption) => void;
  onJump?: (target: JumpTarget) => void;
  onHoverChange?: (hovered: boolean) => void;
}

export function ActivityCardRoute({
  card,
  pendingApprovalIds,
  onApprovalAction,
  onQuestionAction,
  onJump,
  onHoverChange,
}: ActivityCardRouteProps) {
  if (!card) {
    return <main className="activity-card-shell activity-card-shell--empty" aria-label="activity-card" />;
  }

  return (
    <main className="activity-card-shell" aria-label="activity-card">
      <FloatingActivityCard
        card={card}
        pendingApprovalIds={pendingApprovalIds}
        onApprovalDecision={
          card.kind === 'approval'
            ? (mode) => onApprovalAction?.(card, mode)
            : undefined
        }
        onQuestionSelect={
          card.kind === 'question' && card.participantId
            ? (option) => onQuestionAction?.(card, option)
            : undefined
        }
        onJump={onJump}
        onHoverChange={onHoverChange}
      />
    </main>
  );
}
