import { GameRecord, SetState } from './SetState';
import { SideId } from '../battle/request';
import { opponentOf } from '../battle/types';
import { DamageObservation, ProtectObservation, SpeedOrderObservation, SwitchObservation, TargetingObservation, TurnSummary } from '../battle/ObservationTracker';

/**
 * The structured, cross-game memory handed to the agent. It is derived from
 * `GameRecord`s and only ever contains public information from this set.
 */
export interface PreviousGameMemory {
  gameNumber: number;
  result: 'win' | 'loss' | 'tie';
  turns: number;
  ourBringFour: string[];
  opponentBringFour: string[];
  ourLead: string[];
  opponentLead: string[];
  turnHistory: TurnSummary[];
  revealedSpeedOrders: SpeedOrderObservation[];
  revealedDamageResults: DamageObservation[];
  opponentSwitches: SwitchObservation[];
  opponentProtects: ProtectObservation[];
  opponentTargeting: TargetingObservation[];
  opponentMegaEvolutions: { turn: number; species: string }[];
  kos: { turn: number; side: 'us' | 'opponent'; species: string; byMove?: string }[];
}

export interface OpponentTendencies {
  gamesObserved: number;
  leadFrequency: Record<string, number>;
  bringFrequency: Record<string, number>;
  /** Pokémon on the OTS never seen on the field so far. */
  neverBrought: string[];
  protectRateBySpecies: Record<string, { protects: number; turnsActive: number }>;
  switchesPerGame: number;
  megaEvolvedSpecies: string[];
  preferredTargetsBySpecies: Record<string, Record<string, number>>;
}

export interface SetMemory {
  previousGames: PreviousGameMemory[];
  opponentTendencies: OpponentTendencies;
  /** Free slot for future analyzers (OpponentTendencyAnalyzer, LeadPatternAnalyzer, ...). */
  analyses: Record<string, unknown>;
}

export function gameMemory(record: GameRecord): PreviousGameMemory {
  const opp: SideId = opponentOf(record.ourSide);
  const o = record.observations;
  return {
    gameNumber: record.gameNumber,
    result: record.result ?? 'tie',
    turns: record.turns,
    ourBringFour: record.ourBringFour,
    opponentBringFour: record.opponentBringFour,
    ourLead: record.ourLead,
    opponentLead: record.opponentLead,
    turnHistory: o.turns,
    revealedSpeedOrders: o.speedOrders,
    revealedDamageResults: o.damage,
    opponentSwitches: o.switches.filter((s) => s.side === opp),
    opponentProtects: o.protects.filter((p) => p.side === opp),
    opponentTargeting: o.targeting.filter((t) => t.side === opp),
    opponentMegaEvolutions: o.megaEvolutions.filter((m) => m.side === opp).map((m) => ({ turn: m.turn, species: m.species })),
    kos: o.kos.map((k) => ({ turn: k.turn, side: k.side === record.ourSide ? 'us' : 'opponent', species: k.species, byMove: k.byMove })),
  };
}

export function buildSetMemory(set: SetState): SetMemory {
  const finished = set.games.filter((g) => g.result !== null);
  const previousGames = finished.map(gameMemory);
  const leadFrequency: Record<string, number> = {};
  const bringFrequency: Record<string, number> = {};
  const protectRate: Record<string, { protects: number; turnsActive: number }> = {};
  const preferredTargets: Record<string, Record<string, number>> = {};
  let switches = 0;
  const megas = new Set<string>();
  for (const g of previousGames) {
    for (const s of g.opponentLead) leadFrequency[s] = (leadFrequency[s] ?? 0) + 1;
    for (const s of g.opponentBringFour) bringFrequency[s] = (bringFrequency[s] ?? 0) + 1;
    switches += g.opponentSwitches.length;
    for (const m of g.opponentMegaEvolutions) megas.add(m.species);
    for (const p of g.opponentProtects) {
      protectRate[p.species] = protectRate[p.species] ?? { protects: 0, turnsActive: 0 };
      protectRate[p.species].protects++;
    }
    const opp = opponentOf(finished.find((x) => x.gameNumber === g.gameNumber)!.ourSide);
    for (const t of g.turnHistory) {
      for (const species of t.actives[opp]) {
        protectRate[species] = protectRate[species] ?? { protects: 0, turnsActive: 0 };
        protectRate[species].turnsActive++;
      }
    }
    for (const t of g.opponentTargeting) {
      preferredTargets[t.attackerSpecies] = preferredTargets[t.attackerSpecies] ?? {};
      preferredTargets[t.attackerSpecies][t.targetSpecies] = (preferredTargets[t.attackerSpecies][t.targetSpecies] ?? 0) + 1;
    }
  }
  const sheetSpecies = set.opponentTeamSheet?.pokemon.map((p) => p.species) ?? [];
  const seen = new Set(Object.keys(bringFrequency));
  return {
    previousGames,
    opponentTendencies: {
      gamesObserved: previousGames.length,
      leadFrequency,
      bringFrequency,
      neverBrought: sheetSpecies.filter((s) => !seen.has(s)),
      protectRateBySpecies: protectRate,
      switchesPerGame: previousGames.length ? switches / previousGames.length : 0,
      megaEvolvedSpecies: [...megas],
      preferredTargetsBySpecies: preferredTargets,
    },
    analyses: {},
  };
}
