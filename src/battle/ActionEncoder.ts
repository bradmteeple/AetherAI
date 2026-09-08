import { TeamPreviewDecision, TurnDecision } from './decisions';
import { LegalActions } from './LegalActionGenerator';

/**
 * Turns a validated decision into the exact `/choose` text (SIM-PROTOCOL.md
 * "Sending decisions"). Only this module produces choice strings.
 */
export function encodeTeamPreview(decision: TeamPreviewDecision, rqid: number | null): string {
  const order = [decision.lead1, decision.lead2, decision.back1, decision.back2];
  return `/choose team ${order.join(',')}${rqidSuffix(rqid)}`;
}

export function encodeTurn(decision: TurnDecision, legal: LegalActions, rqid: number | null): string {
  if (decision.forfeit) return '/forfeit';
  const parts = decision.actions.map((action) => {
    switch (action.type) {
      case 'pass':
        return 'pass';
      case 'switch':
        return `switch ${action.toSlot}`;
      case 'move': {
        let text = `move ${action.moveIndex}`;
        if (typeof action.target === 'number' && action.target !== 0) text += ` ${action.target > 0 ? '+' : ''}${action.target}`;
        if (action.mega) text += ' mega';
        return text;
      }
    }
  });
  void legal;
  return `/choose ${parts.join(', ')}${rqidSuffix(rqid)}`;
}

export function encodeDefault(rqid: number | null): string {
  return `/choose default${rqidSuffix(rqid)}`;
}

function rqidSuffix(rqid: number | null): string {
  return rqid === null || rqid === undefined ? '' : `|${rqid}`;
}
