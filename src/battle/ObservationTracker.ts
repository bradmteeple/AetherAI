import { RoomMessage } from '../showdown/protocol';
import { parseIdent, SideId } from './request';
import { BattleState, opponentOf } from './types';
import { toID } from '../util/id';

/**
 * Structured per-game observations (public information only) that feed
 * `GameRecord` and, across games, `SetMemory`. Nothing here is a text log;
 * every entry is a typed event the AI can reason about.
 */
export interface TurnAction {
  turn: number;
  order: number;
  actor: SideId;
  actorIdent: string;
  actorSpecies: string;
  kind: 'move' | 'switch' | 'drag' | 'cant' | 'mega';
  move?: string;
  target?: { ident: string; species: string; side: SideId } | null;
  spread?: boolean;
  missed?: boolean;
  protectedBy?: string;
  switchedTo?: string;
  reason?: string;
}

export interface DamageObservation {
  turn: number;
  attacker: string;
  attackerSpecies: string;
  attackerSide: SideId;
  move: string;
  target: string;
  targetSpecies: string;
  targetSide: SideId;
  /** HP % before / after, from the public log (exact for our side, % for theirs). */
  hpBeforePercent: number;
  hpAfterPercent: number;
  damagePercent: number;
  crit: boolean;
  effectiveness: 'super' | 'resisted' | 'immune' | 'neutral';
  koed: boolean;
}

export interface SpeedOrderObservation {
  turn: number;
  /** Actors in the order their moves executed this turn. */
  order: { ident: string; species: string; side: SideId; move: string }[];
}

export interface SwitchObservation {
  turn: number;
  side: SideId;
  out: string;
  outSpecies: string;
  in: string;
  inSpecies: string;
  forced: boolean;
}

export interface ProtectObservation {
  turn: number;
  side: SideId;
  ident: string;
  species: string;
  move: string;
  /** Whether it blocked at least one move. */
  blocked: boolean;
}

export interface TargetingObservation {
  turn: number;
  side: SideId;
  attacker: string;
  attackerSpecies: string;
  move: string;
  target: string;
  targetSpecies: string;
  targetSide: SideId;
}

export interface KoObservation {
  turn: number;
  side: SideId;
  ident: string;
  species: string;
  by?: string;
  byMove?: string;
}

export interface TurnSummary {
  turn: number;
  actions: TurnAction[];
  /** Actives at the start of the turn, per side. */
  actives: Record<SideId, string[]>;
}

export interface GameObservations {
  leads: Record<SideId, string[]>;
  brought: Record<SideId, string[]>;
  turns: TurnSummary[];
  speedOrders: SpeedOrderObservation[];
  damage: DamageObservation[];
  switches: SwitchObservation[];
  protects: ProtectObservation[];
  targeting: TargetingObservation[];
  kos: KoObservation[];
  megaEvolutions: { turn: number; side: SideId; ident: string; species: string; megaStone?: string }[];
  itemsRevealed: { turn: number; side: SideId; ident: string; item: string; how: string }[];
  abilitiesRevealed: { turn: number; side: SideId; ident: string; ability: string }[];
}

export class ObservationTracker {
  readonly observations: GameObservations = {
    leads: { p1: [], p2: [] },
    brought: { p1: [], p2: [] },
    turns: [],
    speedOrders: [],
    damage: [],
    switches: [],
    protects: [],
    targeting: [],
    kos: [],
    megaEvolutions: [],
    itemsRevealed: [],
    abilitiesRevealed: [],
  };
  private currentTurn: TurnSummary | null = null;
  private lastMove: { actor: string; actorSpecies: string; actorSide: SideId; move: string; turn: number } | null = null;
  private orderCounter = 0;
  private hpBefore = new Map<string, number>();
  private pendingEffect: 'super' | 'resisted' | 'immune' | 'neutral' = 'neutral';
  private pendingCrit = false;
  private started = false;

  /** Must be called with the post-apply state so idents resolve. */
  observe(msg: RoomMessage, state: BattleState): void {
    const a = msg.args;
    switch (msg.type) {
      case 'start':
        this.started = true;
        break;
      case 'turn': {
        const turn = Number(a[0]);
        this.currentTurn = { turn, actions: [], actives: { p1: activeIdents(state, 'p1'), p2: activeIdents(state, 'p2') } };
        this.observations.turns.push(this.currentTurn);
        this.orderCounter = 0;
        this.snapshotHp(state);
        if (turn === 1) {
          this.observations.leads.p1 = activeIdents(state, 'p1');
          this.observations.leads.p2 = activeIdents(state, 'p2');
        }
        break;
      }
      case 'switch':
      case 'drag': {
        const ident = parseIdent(a[0] ?? '');
        const species = a[1]?.split(',')[0] ?? '';
        const key = `${ident.side}: ${ident.name}`;
        if (!this.broughtIdents.has(key)) {
          this.broughtIdents.add(key);
          // Base species so a Mega re-entering the field is not a "new" Pokémon.
          this.observations.brought[ident.side].push(baseSpeciesName(species));
        }
        if (state.turn < 1) break; // lead switch-ins are not switches
        const turn = state.turn;
        const prevIdent = this.previousOccupant.get(`${ident.side}${ident.position}`);
        const forced = msg.type === 'drag' || !this.currentTurn || this.expectingForcedSwitch.has(ident.side);
        this.observations.switches.push({
          turn,
          side: ident.side,
          out: prevIdent?.ident ?? '',
          outSpecies: prevIdent?.species ?? '',
          in: key,
          inSpecies: species,
          forced,
        });
        this.currentTurn?.actions.push({
          turn,
          order: ++this.orderCounter,
          actor: ident.side,
          actorIdent: key,
          actorSpecies: prevIdent?.species ?? species,
          kind: msg.type as 'switch' | 'drag',
          switchedTo: species,
        });
        this.previousOccupant.set(`${ident.side}${ident.position}`, { ident: key, species });
        this.expectingForcedSwitch.delete(ident.side);
        this.snapshotHp(state);
        break;
      }
      case 'move': {
        const actor = parseIdent(a[0] ?? '');
        const actorKey = `${actor.side}: ${actor.name}`;
        const mon = findMon(state, actorKey);
        const move = a[1] ?? '';
        const targetArg = a[2];
        const target = targetArg && targetArg.includes(':') ? parseIdent(targetArg) : null;
        const targetMon = target ? findMon(state, `${target.side}: ${target.name}`) : null;
        const missed = msg.rest.includes('[miss]');
        this.lastMove = { actor: actorKey, actorSpecies: mon?.species ?? '', actorSide: actor.side, move, turn: state.turn };
        const action: TurnAction = {
          turn: state.turn,
          order: ++this.orderCounter,
          actor: actor.side,
          actorIdent: actorKey,
          actorSpecies: mon?.species ?? '',
          kind: 'move',
          move,
          target: target ? { ident: `${target.side}: ${target.name}`, species: targetMon?.species ?? '', side: target.side } : null,
          missed,
        };
        this.currentTurn?.actions.push(action);
        if (target && target.side !== actor.side) {
          this.observations.targeting.push({
            turn: state.turn,
            side: actor.side,
            attacker: actorKey,
            attackerSpecies: mon?.species ?? '',
            move,
            target: `${target.side}: ${target.name}`,
            targetSpecies: targetMon?.species ?? '',
            targetSide: target.side,
          });
        }
        if (PROTECT_MOVES.has(toID(move))) {
          this.observations.protects.push({ turn: state.turn, side: actor.side, ident: actorKey, species: mon?.species ?? '', move, blocked: false });
        }
        this.pendingEffect = 'neutral';
        this.pendingCrit = false;
        break;
      }
      case 'cant': {
        const actor = parseIdent(a[0] ?? '');
        const actorKey = `${actor.side}: ${actor.name}`;
        const mon = findMon(state, actorKey);
        this.currentTurn?.actions.push({
          turn: state.turn, order: ++this.orderCounter, actor: actor.side, actorIdent: actorKey, actorSpecies: mon?.species ?? '', kind: 'cant', reason: a[1], move: a[2],
        });
        break;
      }
      case '-mega': {
        const actor = parseIdent(a[0] ?? '');
        const key = `${actor.side}: ${actor.name}`;
        const mon = findMon(state, key);
        this.observations.megaEvolutions.push({ turn: state.turn, side: actor.side, ident: key, species: mon?.species ?? '', megaStone: a[2] });
        this.currentTurn?.actions.push({ turn: state.turn, order: ++this.orderCounter, actor: actor.side, actorIdent: key, actorSpecies: mon?.species ?? '', kind: 'mega' });
        break;
      }
      case '-crit':
        this.pendingCrit = true;
        break;
      case '-supereffective':
        this.pendingEffect = 'super';
        break;
      case '-resisted':
        this.pendingEffect = 'resisted';
        break;
      case '-immune':
        this.pendingEffect = 'immune';
        break;
      case '-activate': {
        // |-activate|p2a: X|move: Protect  → X protected against the last move
        const ident = parseIdent(a[0] ?? '');
        const effect = toID((a[1] ?? '').replace(/^move:\s*/, ''));
        if (PROTECT_MOVES.has(effect)) {
          const key = `${ident.side}: ${ident.name}`;
          const p = [...this.observations.protects].reverse().find((x) => x.ident === key && x.turn === state.turn);
          if (p) p.blocked = true;
          const last = this.currentTurn?.actions[this.currentTurn.actions.length - 1];
          if (last && last.kind === 'move') last.protectedBy = key;
        }
        break;
      }
      case '-damage': {
        if (!this.lastMove || msg.rest.includes('[from]')) {
          this.snapshotOne(state, a[0]);
          break;
        }
        const target = parseIdent(a[0] ?? '');
        const key = `${target.side}: ${target.name}`;
        const mon = findMon(state, key);
        const before = this.hpBefore.get(key) ?? 100;
        const after = mon?.hpPercent ?? before;
        this.observations.damage.push({
          turn: state.turn,
          attacker: this.lastMove.actor,
          attackerSpecies: this.lastMove.actorSpecies,
          attackerSide: this.lastMove.actorSide,
          move: this.lastMove.move,
          target: key,
          targetSpecies: mon?.species ?? '',
          targetSide: target.side,
          hpBeforePercent: before,
          hpAfterPercent: after,
          damagePercent: Math.round((before - after) * 10) / 10,
          crit: this.pendingCrit,
          effectiveness: this.pendingEffect,
          koed: !!mon?.fainted || after === 0,
        });
        this.hpBefore.set(key, after);
        this.pendingCrit = false;
        this.pendingEffect = 'neutral';
        break;
      }
      case '-heal':
      case '-sethp':
        this.snapshotOne(state, a[0]);
        break;
      case 'faint': {
        const ident = parseIdent(a[0] ?? '');
        const key = `${ident.side}: ${ident.name}`;
        const mon = findMon(state, key);
        this.observations.kos.push({
          turn: state.turn,
          side: ident.side,
          ident: key,
          species: mon?.species ?? '',
          ...(this.lastMove && this.lastMove.actorSide !== ident.side ? { by: this.lastMove.actor, byMove: this.lastMove.move } : {}),
        });
        this.expectingForcedSwitch.add(ident.side);
        break;
      }
      case '-item': {
        const ident = parseIdent(a[0] ?? '');
        this.observations.itemsRevealed.push({ turn: state.turn, side: ident.side, ident: `${ident.side}: ${ident.name}`, item: a[1] ?? '', how: msg.rest.includes('[from]') ? msg.rest.slice(msg.rest.indexOf('[from]')) : 'announced' });
        break;
      }
      case '-enditem': {
        const ident = parseIdent(a[0] ?? '');
        this.observations.itemsRevealed.push({ turn: state.turn, side: ident.side, ident: `${ident.side}: ${ident.name}`, item: a[1] ?? '', how: 'consumed/removed' });
        break;
      }
      case '-ability': {
        const ident = parseIdent(a[0] ?? '');
        this.observations.abilitiesRevealed.push({ turn: state.turn, side: ident.side, ident: `${ident.side}: ${ident.name}`, ability: a[1] ?? '' });
        break;
      }
      case 'upkeep':
        this.finishTurn();
        break;
      default:
        break;
    }
  }

  private readonly previousOccupant = new Map<string, { ident: string; species: string }>();
  private readonly broughtIdents = new Set<string>();
  private readonly expectingForcedSwitch = new Set<SideId>();

  private finishTurn() {
    if (!this.currentTurn) return;
    const moves = this.currentTurn.actions.filter((x) => x.kind === 'move');
    if (moves.length >= 2) {
      this.observations.speedOrders.push({
        turn: this.currentTurn.turn,
        order: moves.map((m) => ({ ident: m.actorIdent, species: m.actorSpecies, side: m.actor, move: m.move ?? '' })),
      });
    }
    this.lastMove = null;
  }

  private snapshotHp(state: BattleState) {
    for (const side of ['p1', 'p2'] as SideId[]) {
      for (const mon of state.sides[side].pokemon) this.hpBefore.set(mon.ident, mon.hpPercent);
    }
  }

  private snapshotOne(state: BattleState, identArg: string | undefined) {
    if (!identArg) return;
    const ident = parseIdent(identArg);
    const key = `${ident.side}: ${ident.name}`;
    const mon = findMon(state, key);
    if (mon) this.hpBefore.set(key, mon.hpPercent);
  }

  /** Public-information summary from `side`'s opponent's point of view. */
  summarizeOpponent(state: BattleState): OpponentGameSummary {
    const opp = opponentOf(state.ourSide);
    const o = this.observations;
    return {
      side: opp,
      lead: o.leads[opp],
      brought: o.brought[opp],
      protects: o.protects.filter((p) => p.side === opp),
      switches: o.switches.filter((s) => s.side === opp),
      targeting: o.targeting.filter((t) => t.side === opp),
      megaEvolutions: o.megaEvolutions.filter((m) => m.side === opp),
      kosDealt: o.kos.filter((k) => k.side === state.ourSide),
      kosTaken: o.kos.filter((k) => k.side === opp),
    };
  }
}

export interface OpponentGameSummary {
  side: SideId;
  lead: string[];
  brought: string[];
  protects: ProtectObservation[];
  switches: SwitchObservation[];
  targeting: TargetingObservation[];
  megaEvolutions: GameObservations['megaEvolutions'];
  kosDealt: KoObservation[];
  kosTaken: KoObservation[];
}

const PROTECT_MOVES = new Set([
  'protect', 'detect', 'spikyshield', 'banefulbunker', 'kingsshield', 'obstruct', 'silktrap', 'burningbulwark', 'wideguard', 'quickguard', 'matblock', 'craftyshield', 'maxguard',
]);

export function baseSpeciesName(species: string): string {
  return species.replace(/-Mega(-[XY])?$/, '').replace(/-Primal$/, '');
}

function activeIdents(state: BattleState, side: SideId): string[] {
  return state.sides[side].active.filter((m): m is NonNullable<typeof m> => !!m).map((m) => m.species);
}

function findMon(state: BattleState, ident: string) {
  const parsed = parseIdent(ident);
  const side = state.sides[parsed.side];
  if (!side) return null;
  return side.pokemon.find((p) => toID(p.nickname) === toID(parsed.name)) ?? side.pokemon.find((p) => toID(p.species) === toID(parsed.name)) ?? null;
}
