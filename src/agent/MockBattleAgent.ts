import { BattleAgent, TeamPreviewInput, TurnDecisionInput } from './BattleAgent';
import { SlotAction, TeamPreviewDecision, TurnDecision } from '../battle/decisions';

export interface MockBattleAgentOptions {
  /** Deterministic PRNG seed. */
  seed?: number;
  /** Prefer switching with this probability when possible (default 0.15). */
  switchProbability?: number;
  /** Return an invalid decision on the first attempt this many times (tests). */
  invalidFirstAttempts?: number;
  /** Forfeit games listed here (1-based game numbers) on turn 1 (tests). */
  forfeitGames?: number[];
  /** Vary the bring-four between games so set adaptation is exercised. */
  rotateBring?: boolean;
}

/**
 * Infrastructure-proving agent: plays random legal moves, changes its
 * bring-four between games, and can be configured to misbehave for tests.
 * It is not meant to play well.
 */
export class MockBattleAgent implements BattleAgent {
  readonly name = 'MockBattleAgent';
  private rng: () => number;
  private invalidBudget: number;
  readonly calls: { teamPreview: number; turn: number } = { teamPreview: 0, turn: 0 };

  constructor(private readonly options: MockBattleAgentOptions = {}) {
    this.rng = mulberry32(options.seed ?? 12345);
    this.invalidBudget = options.invalidFirstAttempts ?? 0;
  }

  async chooseTeamPreview(input: TeamPreviewInput): Promise<TeamPreviewDecision> {
    this.calls.teamPreview++;
    if (this.invalidBudget > 0 && !input.retry) {
      this.invalidBudget--;
      return { lead1: 1, lead2: 1, back1: 9, back2: 2, reasoning: 'intentionally invalid' };
    }
    const slots = input.legalTeamPreviewChoices.pokemon.map((p) => p.slot);
    let order = [...slots];
    if (this.options.rotateBring !== false) {
      // rotate so each game brings a different four when possible
      const offset = (input.gameNumber - 1) % slots.length;
      order = [...slots.slice(offset), ...slots.slice(0, offset)];
    }
    // small shuffle within the chosen four so leads vary too
    const four = order.slice(0, input.legalTeamPreviewChoices.pickCount);
    for (let i = four.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [four[i], four[j]] = [four[j], four[i]];
    }
    return {
      lead1: four[0],
      lead2: four[1],
      back1: four[2],
      back2: four[3],
      reasoning: `mock: game ${input.gameNumber} at ${input.setScore.display}, ${input.previousGames.length} previous game(s) in memory; opponent OTS has ${input.opponentTeamSheet?.pokemon.length ?? 0} Pokémon`,
    };
  }

  async chooseTurn(input: TurnDecisionInput): Promise<TurnDecision> {
    this.calls.turn++;
    if (this.options.forfeitGames?.includes(input.gameNumber)) {
      return { actions: [], forfeit: true, reasoning: 'mock: scripted forfeit' };
    }
    if (this.invalidBudget > 0 && !input.retry) {
      this.invalidBudget--;
      return { actions: [{ type: 'move', moveIndex: 99, target: 7 }], reasoning: 'intentionally invalid' };
    }
    const legal = input.legalActions;
    const used = new Set<number>();
    const actions: SlotAction[] = legal.slots.map((slot) => {
      if (legal.kind === 'switch') {
        const s = slot as import('../battle/LegalActionGenerator').ForceSwitchLegalActions['slots'][number];
        if (!s.mustSwitch) return { type: 'pass' };
        const options = s.switches.filter((x) => !used.has(x.slot));
        if (!options.length) return { type: 'pass' };
        const pick = options[Math.floor(this.rng() * options.length)];
        used.add(pick.slot);
        return { type: 'switch', toSlot: pick.slot };
      }
      const s = slot as import('../battle/LegalActionGenerator').TurnLegalActions['slots'][number];
      if (s.mustPass) return { type: 'pass' };
      const switchOptions = s.switches.filter((x) => !used.has(x.slot));
      if (switchOptions.length && this.rng() < (this.options.switchProbability ?? 0.15)) {
        const pick = switchOptions[Math.floor(this.rng() * switchOptions.length)];
        used.add(pick.slot);
        return { type: 'switch', toSlot: pick.slot };
      }
      const moves = s.moves.filter((m) => !m.disabled);
      if (!moves.length) {
        if (switchOptions.length) {
          used.add(switchOptions[0].slot);
          return { type: 'switch', toSlot: switchOptions[0].slot };
        }
        return { type: 'pass' };
      }
      const move = moves[Math.floor(this.rng() * moves.length)];
      const action: SlotAction = { type: 'move', moveIndex: move.index };
      if (move.requiresTarget) {
        const occupiedFoes = move.targets.filter((t) => t.side === 'foe' && t.occupied);
        const pool = occupiedFoes.length ? occupiedFoes : move.targets.filter((t) => t.side !== 'self') .length ? move.targets.filter((t) => t.side !== 'self') : move.targets;
        action.target = pool[Math.floor(this.rng() * pool.length)].loc;
      }
      if (s.canMegaEvo && this.rng() < 0.8) action.mega = true;
      return action;
    });
    // only one mega per turn
    let megaSeen = false;
    for (const a of actions) {
      if (a.type === 'move' && a.mega) {
        if (megaSeen) a.mega = false;
        megaSeen = true;
      }
    }
    return { actions, reasoning: `mock: turn ${input.currentBattleState.turn} game ${input.gameNumber} (${input.setScore.display})` };
  }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
