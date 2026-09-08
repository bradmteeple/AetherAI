import { SlotAction, TeamPreviewDecision, TurnDecision } from './decisions';
import { ForceSwitchLegalActions, LegalActions, TeamPreviewLegalActions, TurnLegalActions } from './LegalActionGenerator';

export interface ValidationOutcome {
  ok: boolean;
  errors: string[];
}

export function validateTeamPreview(decision: TeamPreviewDecision, legal: TeamPreviewLegalActions): ValidationOutcome {
  const errors: string[] = [];
  const picks = [decision?.lead1, decision?.lead2, decision?.back1, decision?.back2];
  if (!decision || picks.some((p) => typeof p !== 'number' || !Number.isInteger(p))) {
    return { ok: false, errors: ['Decision must contain integer lead1, lead2, back1, back2 (1-based team slots).'] };
  }
  const valid = new Set(legal.pokemon.map((p) => p.slot));
  for (const p of picks) if (!valid.has(p)) errors.push(`Slot ${p} is not a valid team slot (valid: ${[...valid].join(', ')}).`);
  if (new Set(picks).size !== picks.length) errors.push('Team preview picks must be distinct.');
  if (picks.length !== legal.pickCount) errors.push(`Exactly ${legal.pickCount} Pokémon must be chosen.`);
  return { ok: !errors.length, errors };
}

export function validateTurn(decision: TurnDecision, legal: TurnLegalActions | ForceSwitchLegalActions): ValidationOutcome {
  const errors: string[] = [];
  if (!decision || typeof decision !== 'object') return { ok: false, errors: ['Decision must be an object with an `actions` array.'] };
  if (decision.forfeit) return { ok: true, errors: [] };
  if (!Array.isArray(decision.actions)) return { ok: false, errors: ['`actions` must be an array with one entry per slot.'] };
  if (decision.actions.length !== legal.slots.length) {
    errors.push(`Expected ${legal.slots.length} actions (one per slot), got ${decision.actions.length}.`);
    return { ok: false, errors };
  }
  const switchTargets = new Set<number>();
  let megas = 0;
  decision.actions.forEach((action, i) => {
    const prefix = `Slot ${legal.slots[i].positionLetter}:`;
    if (legal.kind === 'switch') {
      const slot = legal.slots[i];
      if (slot.mustSwitch) {
        if (action.type === 'pass') {
          if (slot.switches.length) errors.push(`${prefix} must switch (options: ${slot.switches.map((s) => s.slot).join(', ')}).`);
        } else if (action.type !== 'switch') {
          errors.push(`${prefix} only 'switch' (or 'pass' when no Pokémon is available) is legal during a forced switch.`);
        } else {
          checkSwitch(action, slot.switches.map((s) => s.slot), prefix, errors, switchTargets);
        }
      } else if (action.type !== 'pass') {
        errors.push(`${prefix} this slot is not switching; it must pass.`);
      }
      return;
    }
    const slot = legal.slots[i];
    if (slot.mustPass) {
      if (action.type !== 'pass') errors.push(`${prefix} has no acting Pokémon and must pass.`);
      return;
    }
    switch (action.type) {
      case 'pass':
        errors.push(`${prefix} has an active Pokémon and cannot pass.`);
        break;
      case 'switch':
        if (slot.trapped) errors.push(`${prefix} is trapped and cannot switch.`);
        checkSwitch(action, slot.switches.map((s) => s.slot), prefix, errors, switchTargets);
        break;
      case 'move': {
        const move = slot.moves.find((m) => m.index === action.moveIndex);
        if (!move) {
          errors.push(`${prefix} moveIndex ${action.moveIndex} is not one of ${slot.moves.map((m) => m.index).join(', ')}.`);
          break;
        }
        if (move.disabled) errors.push(`${prefix} ${move.name} is disabled${move.disabledReason ? ` (${move.disabledReason})` : ''}.`);
        if (move.requiresTarget) {
          if (typeof action.target !== 'number') {
            errors.push(`${prefix} ${move.name} requires a target (one of ${move.targets.map((t) => t.loc).join(', ')}).`);
          } else if (!move.targets.some((t) => t.loc === action.target)) {
            errors.push(`${prefix} target ${action.target} is not valid for ${move.name} (valid: ${move.targets.map((t) => t.loc).join(', ')}).`);
          }
        } else if (action.target !== undefined && action.target !== 0) {
          errors.push(`${prefix} ${move.name} does not take a target.`);
        }
        if (action.mega) {
          if (!slot.canMegaEvo) errors.push(`${prefix} cannot Mega Evolve.`);
          megas++;
        }
        break;
      }
      default:
        errors.push(`${prefix} unknown action type ${(action as { type?: string }).type}.`);
    }
  });
  if (megas > 1) errors.push('Only one Pokémon may Mega Evolve per turn.');
  return { ok: !errors.length, errors };
}

function checkSwitch(action: Extract<SlotAction, { type: 'switch' }>, allowed: number[], prefix: string, errors: string[], seen: Set<number>) {
  if (!allowed.includes(action.toSlot)) {
    errors.push(`${prefix} cannot switch to slot ${action.toSlot} (options: ${allowed.join(', ') || 'none'}).`);
    return;
  }
  if (seen.has(action.toSlot)) errors.push(`${prefix} slot ${action.toSlot} was already chosen as a switch target this turn.`);
  seen.add(action.toSlot);
}

export function validateDecision(decision: unknown, legal: LegalActions): ValidationOutcome {
  switch (legal.kind) {
    case 'teampreview':
      return validateTeamPreview(decision as TeamPreviewDecision, legal);
    case 'move':
    case 'switch':
      return validateTurn(decision as TurnDecision, legal);
    case 'wait':
      return { ok: false, errors: ['No decision is expected while waiting.'] };
  }
}

/**
 * A guaranteed-legal fallback used when the agent fails twice. Prefers an
 * enabled damaging-looking move at an occupied foe, then any enabled move,
 * then a switch, then pass.
 */
export function safeFallback(legal: LegalActions): TeamPreviewDecision | TurnDecision | null {
  if (legal.kind === 'teampreview') {
    const slots = legal.pokemon.map((p) => p.slot);
    return { lead1: slots[0], lead2: slots[1], back1: slots[2], back2: slots[3], reasoning: 'fallback: first four in order' };
  }
  if (legal.kind === 'switch') {
    const used = new Set<number>();
    const actions: SlotAction[] = legal.slots.map((slot) => {
      if (!slot.mustSwitch) return { type: 'pass' };
      const opt = slot.switches.find((s) => !used.has(s.slot));
      if (!opt) return { type: 'pass' };
      used.add(opt.slot);
      return { type: 'switch', toSlot: opt.slot };
    });
    return { actions, reasoning: 'fallback: first available switches' };
  }
  if (legal.kind === 'move') {
    const actions: SlotAction[] = legal.slots.map((slot) => {
      if (slot.mustPass) return { type: 'pass' };
      const enabled = slot.moves.filter((m) => !m.disabled);
      const pick = enabled.find((m) => !m.requiresTarget || m.targets.some((t) => t.side === 'foe' && t.occupied)) ?? enabled[0];
      if (pick) {
        if (!pick.requiresTarget) return { type: 'move', moveIndex: pick.index };
        const target = pick.targets.find((t) => t.side === 'foe' && t.occupied) ?? pick.targets.find((t) => t.side === 'foe') ?? pick.targets[0];
        return { type: 'move', moveIndex: pick.index, target: target.loc };
      }
      if (slot.switches.length) return { type: 'switch', toSlot: slot.switches[0].slot };
      // Server lists Struggle as the only move when everything is disabled.
      return slot.moves.length ? { type: 'move', moveIndex: slot.moves[0].index, ...(slot.moves[0].requiresTarget ? { target: slot.moves[0].targets[0]?.loc ?? 1 } : {}) } : { type: 'pass' };
    });
    return { actions, reasoning: 'fallback: first enabled move at an opposing Pokémon' };
  }
  return null;
}
