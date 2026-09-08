import { TeamSheet } from '../team/OpenTeamSheetParser';
import { BattleState } from '../battle/types';
import { ForceSwitchLegalActions, TeamPreviewLegalActions, TurnLegalActions } from '../battle/LegalActionGenerator';
import { TeamPreviewDecision, TurnDecision } from '../battle/decisions';
import { SetMemory, PreviousGameMemory } from '../set/SetMemory';
import { TurnSummary } from '../battle/ObservationTracker';
import { GameRecord } from '../set/SetState';

export interface SetScore {
  ourWins: number;
  opponentWins: number;
  ties: number;
  /** e.g. "1-0" */
  display: string;
}

/**
 * Placeholder for strategic material (general VGC guide, lead selection guide,
 * team-specific notes, ...). Attached by the runner, never by the connector.
 */
export interface StrategicContext {
  guides?: Record<string, string>;
  teamNotes?: string;
  metagameNotes?: string;
  [key: string]: unknown;
}

export interface OurTeamView {
  /** Our full six in team-preview order with everything we know (including stat points). */
  pokemon: {
    slot: number;
    species: string;
    item: string;
    ability: string;
    moves: string[];
    nature: string;
    statPoints: Record<string, number>;
    level: number;
    gender: string;
  }[];
  exportText: string;
}

export interface AgentRetryInfo {
  attempt: number;
  previousDecision: unknown;
  errors: string[];
}

export interface TeamPreviewInput {
  format: { id: string; name: string; mod: string; gameType: string; bestOf: number };
  setId: string;
  gameNumber: number;
  setScore: SetScore;
  opponentName: string;
  ourTeamSheet: OurTeamView;
  opponentTeamSheet: TeamSheet | null;
  previousGames: PreviousGameMemory[];
  setMemory: SetMemory;
  legalTeamPreviewChoices: TeamPreviewLegalActions;
  strategicContext?: StrategicContext;
  retry?: AgentRetryInfo;
}

export interface OpponentBattleKnowledge {
  /** Species revealed on the field this game. */
  revealedThisGame: string[];
  /** Per-Pokémon in-game knowledge (moves used, item/ability confirmations, HP, status). */
  pokemon: {
    species: string;
    ident: string;
    hpPercent: number;
    status: string;
    fainted: boolean;
    active: boolean;
    revealedMoves: string[];
    itemKnown: string | null;
    itemSource: 'sheet' | 'reveal' | null;
    abilityKnown: string | null;
    abilitySource: 'sheet' | 'reveal' | null;
    megaEvolved: boolean;
    boosts: Record<string, number>;
    volatiles: string[];
  }[];
}

export interface TurnDecisionInput {
  format: { id: string; name: string; mod: string; gameType: string; bestOf: number };
  setId: string;
  gameNumber: number;
  setScore: SetScore;
  opponentName: string;
  ourTeamSheet: OurTeamView;
  opponentTeamSheet: TeamSheet | null;
  /** Full public game state (our side exact, opponent side as visible). */
  currentBattleState: BattleState;
  ourBringFour: string[];
  knownOpponentBring: string[];
  opponentBattleKnowledge: OpponentBattleKnowledge;
  previousGames: PreviousGameMemory[];
  setMemory: SetMemory;
  legalActions: TurnLegalActions | ForceSwitchLegalActions;
  turnHistory: TurnSummary[];
  strategicContext?: StrategicContext;
  retry?: AgentRetryInfo;
}

/**
 * Provider-independent interface. Implementations may be LLM-backed, search
 * based, learned, or rule based; the connector does not care.
 */
export interface BattleAgent {
  readonly name: string;
  chooseTeamPreview(input: TeamPreviewInput): Promise<TeamPreviewDecision>;
  chooseTurn(input: TurnDecisionInput): Promise<TurnDecision>;
  /** Optional hooks for between-game analysis. */
  onGameEnd?(record: GameRecord, score: SetScore, memory: SetMemory): Promise<void> | void;
  onSetEnd?(score: SetScore, result: 'win' | 'loss' | 'tie'): Promise<void> | void;
}
