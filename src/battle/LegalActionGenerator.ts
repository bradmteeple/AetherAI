import { ChoiceRequest, parseCondition, parseDetails, RequestActive, RequestPokemon, requestKind } from './request';
import { BattleState } from './types';
import { ACTIVE_PER_SIDE, LEAD_COUNT, PICKED_TEAM_SIZE } from '../format';

/** Target types for which the server requires an explicit target (sim/battle-actions.ts:3). */
export const CHOOSABLE_TARGETS = new Set(['normal', 'any', 'adjacentAlly', 'adjacentAllyOrSelf', 'adjacentFoe']);

export interface TargetOption {
  /** Showdown target location: +1/+2 foes, -1/-2 allies (see ARCHITECTURE.md §7). */
  loc: number;
  side: 'foe' | 'ally' | 'self';
  /** Position letter on that side (a/b). */
  position: 'a' | 'b';
  /** Whether a (non-fainted) Pokémon currently occupies that slot. */
  occupied: boolean;
  species: string | null;
  ident: string | null;
}

export interface LegalMove {
  index: number;
  id: string;
  name: string;
  pp: number | null;
  maxpp: number | null;
  disabled: boolean;
  disabledReason?: string;
  targetType: string;
  requiresTarget: boolean;
  /** Valid target locations if `requiresTarget`; empty otherwise. */
  targets: TargetOption[];
  /** Human description of what a targetless move hits (spread/self/field). */
  implicitTarget?: string;
}

export interface LegalSwitch {
  /** 1-based slot in the current team order (what `/choose switch N` expects). */
  slot: number;
  ident: string;
  species: string;
  hpPercent: number;
  status: string;
}

export interface SlotLegalActions {
  position: 0 | 1;
  positionLetter: 'a' | 'b';
  ident: string | null;
  species: string | null;
  /** Slot has no acting Pokémon (fainted/empty) and must `pass`. */
  mustPass: boolean;
  moves: LegalMove[];
  canSwitch: boolean;
  trapped: boolean;
  maybeTrapped: boolean;
  switches: LegalSwitch[];
  canMegaEvo: boolean;
  /** Mechanics the request advertises that this format does not use (kept for transparency). */
  otherMechanics: string[];
}

export interface TeamPreviewLegalActions {
  kind: 'teampreview';
  rqid: number | null;
  pickCount: number;
  leadCount: number;
  pokemon: { slot: number; ident: string; species: string; details: string }[];
  rules: string[];
}

export interface TurnLegalActions {
  kind: 'move';
  rqid: number | null;
  slots: SlotLegalActions[];
  constraints: string[];
}

export interface ForceSwitchLegalActions {
  kind: 'switch';
  rqid: number | null;
  slots: { position: 0 | 1; positionLetter: 'a' | 'b'; mustSwitch: boolean; ident: string | null; switches: LegalSwitch[]; reviving: boolean }[];
  constraints: string[];
}

export interface WaitLegalActions {
  kind: 'wait';
  rqid: number | null;
}

export type LegalActions = TeamPreviewLegalActions | TurnLegalActions | ForceSwitchLegalActions | WaitLegalActions;

/**
 * Derives legal actions from the server's `|request|`. Geometry follows
 * `Battle.validTargetLoc` (sim/battle.ts:2399-2432) for doubles.
 */
export function generateLegalActions(request: ChoiceRequest, state?: BattleState): LegalActions {
  const rqid = request.rqid ?? null;
  switch (requestKind(request)) {
    case 'wait':
      return { kind: 'wait', rqid };
    case 'teampreview':
      return {
        kind: 'teampreview',
        rqid,
        pickCount: request.maxChosenTeamSize ?? PICKED_TEAM_SIZE,
        leadCount: LEAD_COUNT,
        pokemon: request.side.pokemon.map((p, i) => ({
          slot: i + 1,
          ident: p.ident,
          species: parseDetails(p.details).species,
          details: p.details,
        })),
        rules: [
          `Choose exactly ${request.maxChosenTeamSize ?? PICKED_TEAM_SIZE} distinct slots.`,
          `The first ${LEAD_COUNT} chosen become the leads (positions a and b, in that order); the rest are the back line.`,
        ],
      };
    case 'switch':
      return forceSwitchActions(request, rqid);
    case 'move':
      return moveActions(request, rqid, state);
  }
}

function switchCandidates(pokemon: RequestPokemon[], reviving = false): LegalSwitch[] {
  const out: LegalSwitch[] = [];
  pokemon.forEach((p, i) => {
    const c = parseCondition(p.condition);
    if (reviving ? !c.fainted : (p.active || c.fainted)) return;
    out.push({
      slot: i + 1,
      ident: p.ident,
      species: parseDetails(p.details).species,
      hpPercent: c.maxhp ? Math.round((c.hp / c.maxhp) * 1000) / 10 : 0,
      status: c.status,
    });
  });
  return out;
}

function forceSwitchActions(request: ChoiceRequest, rqid: number | null): ForceSwitchLegalActions {
  const forced = request.forceSwitch ?? [];
  const actives = request.side.pokemon.filter((p) => p.active);
  const slots = forced.map((mustSwitch, position) => {
    const active = actives[position] ?? null;
    const reviving = !!active?.reviving;
    return {
      position: position as 0 | 1,
      positionLetter: (position === 0 ? 'a' : 'b') as 'a' | 'b',
      mustSwitch,
      ident: active?.ident ?? null,
      switches: mustSwitch ? switchCandidates(request.side.pokemon, reviving) : [],
      reviving,
    };
  });
  return {
    kind: 'switch',
    rqid,
    slots,
    constraints: [
      'Provide a switch for every slot with mustSwitch=true; other slots must pass.',
      'Two slots may not switch to the same Pokémon.',
      'If fewer healthy Pokémon remain than slots to fill, the extra slot passes.',
    ],
  };
}

function moveActions(request: ChoiceRequest, rqid: number | null, state?: BattleState): TurnLegalActions {
  const actives = request.side.pokemon.filter((p) => p.active);
  const foeSide = state ? state.sides[request.side.id === 'p1' ? 'p2' : 'p1'] : null;
  const activeList = request.active ?? [];
  const slots: SlotLegalActions[] = [];
  for (let position = 0; position < Math.max(activeList.length, ACTIVE_PER_SIDE); position++) {
    const act: RequestActive | undefined = activeList[position];
    const mon = actives[position];
    const letter = (position === 0 ? 'a' : 'b') as 'a' | 'b';
    if (!act || !mon) {
      slots.push({ position: position as 0 | 1, positionLetter: letter, ident: null, species: null, mustPass: true, moves: [], canSwitch: false, trapped: false, maybeTrapped: false, switches: [], canMegaEvo: false, otherMechanics: [] });
      continue;
    }
    const cond = parseCondition(mon.condition);
    const mustPass = cond.fainted || !!mon.commanding;
    const trapped = !!act.trapped;
    const switches = trapped || mustPass ? [] : switchCandidates(request.side.pokemon);
    const moves: LegalMove[] = act.moves.map((m, i) => {
      const targetType = m.target ?? 'normal';
      const requiresTarget = CHOOSABLE_TARGETS.has(targetType);
      return {
        index: i + 1,
        id: m.id,
        name: m.move,
        pp: m.pp ?? null,
        maxpp: m.maxpp ?? null,
        disabled: !!m.disabled,
        ...(m.disabledSource ? { disabledReason: m.disabledSource } : {}),
        targetType,
        requiresTarget,
        targets: requiresTarget ? targetOptions(position, targetType, actives, foeSide) : [],
        ...(requiresTarget ? {} : { implicitTarget: describeImplicitTarget(targetType) }),
      };
    });
    const otherMechanics: string[] = [];
    if (act.canTerastallize) otherMechanics.push('terastallize');
    if (act.canDynamax) otherMechanics.push('dynamax');
    if (act.canZMove) otherMechanics.push('zmove');
    if (act.canUltraBurst) otherMechanics.push('ultraburst');
    if (act.canMegaEvoX) otherMechanics.push('megax');
    if (act.canMegaEvoY) otherMechanics.push('megay');
    slots.push({
      position: position as 0 | 1,
      positionLetter: letter,
      ident: mon.ident,
      species: parseDetails(mon.details).species,
      mustPass,
      moves: mustPass ? [] : moves,
      canSwitch: switches.length > 0,
      trapped,
      maybeTrapped: !!act.maybeTrapped,
      switches,
      canMegaEvo: !!act.canMegaEvo && !mustPass,
      otherMechanics,
    });
  }
  return {
    kind: 'move',
    rqid,
    slots,
    constraints: [
      'Exactly one action per slot in order (a, b). Slots with mustPass=true must pass.',
      'Two slots may not switch to the same Pokémon.',
      'At most one Pokémon may Mega Evolve per battle (only where canMegaEvo=true).',
      'A move with requiresTarget=true needs one of its listed target locations; other moves take no target.',
      'A disabled move cannot be selected. A Pokémon with only disabled moves may still be selected by moveIndex 1 (Struggle) if the server lists it.',
    ],
  };
}

/**
 * Doubles geometry (sim/battle.ts validTargetLoc): from slot `position` (0=a,1=b)
 * foes are +1/+2 (always adjacent in doubles), allies -1/-2 where -(position+1) is self.
 */
export function targetOptions(position: number, targetType: string, actives: RequestPokemon[], foeSide: BattleState['sides']['p1'] | null): TargetOption[] {
  const self = -(position + 1);
  const otherAlly = position === 0 ? -2 : -1;
  const out: TargetOption[] = [];
  const foe = (loc: 1 | 2): TargetOption => {
    const foePos = loc - 1;
    const mon = foeSide?.active[foePos] ?? null;
    return {
      loc,
      side: 'foe',
      position: foePos === 0 ? 'a' : 'b',
      occupied: !!mon && !mon.fainted,
      species: mon?.species ?? null,
      ident: mon?.ident ?? null,
    };
  };
  const ally = (loc: number): TargetOption => {
    const pos = -loc - 1;
    const mon = actives[pos];
    const cond = mon ? parseCondition(mon.condition) : null;
    return {
      loc,
      side: loc === self ? 'self' : 'ally',
      position: pos === 0 ? 'a' : 'b',
      occupied: !!mon && !cond?.fainted,
      species: mon ? parseDetails(mon.details).species : null,
      ident: mon?.ident ?? null,
    };
  };
  switch (targetType) {
    case 'normal':
    case 'adjacentFoe':
      out.push(foe(1), foe(2));
      if (targetType === 'normal') out.push(ally(otherAlly));
      break;
    case 'any':
      out.push(foe(1), foe(2), ally(otherAlly));
      break;
    case 'adjacentAlly':
      out.push(ally(otherAlly));
      break;
    case 'adjacentAllyOrSelf':
      out.push(ally(otherAlly), ally(self));
      break;
    default:
      break;
  }
  return out;
}

function describeImplicitTarget(targetType: string): string {
  switch (targetType) {
    case 'self': return 'the user';
    case 'allAdjacentFoes': return 'both opposing Pokémon (spread)';
    case 'allAdjacent': return 'every other Pokémon on the field (spread, hits ally)';
    case 'allySide': return "the user's side";
    case 'foeSide': return "the opponents' side";
    case 'all': return 'the whole field';
    case 'allyTeam': return "the user's whole team";
    case 'allies': return 'all allies';
    case 'randomNormal': return 'a random opponent';
    case 'scripted': return 'the Pokémon that last hit the user';
    default: return targetType;
  }
}
