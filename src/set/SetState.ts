import { TeamSheet } from '../team/OpenTeamSheetParser';
import { PokemonSet } from '../team/types';
import { GameObservations, OpponentGameSummary } from '../battle/ObservationTracker';
import { BattleState } from '../battle/types';
import { LegalActions } from '../battle/LegalActionGenerator';
import { SideId } from '../battle/request';

export type GameResult = 'win' | 'loss' | 'tie';

export interface DecisionRecord {
  setId: string;
  gameNumber: number;
  roomId: string;
  turn: number;
  rqid: number | null;
  kind: LegalActions['kind'];
  legalActions: LegalActions;
  attempts: {
    attempt: number;
    decision: unknown;
    valid: boolean;
    errors: string[];
    latencyMs: number;
    agentError?: string;
  }[];
  finalDecision: unknown;
  usedFallback: boolean;
  command: string | null;
  serverRejection?: string;
  timestamp: string;
}

export interface GameRecord {
  gameNumber: number;
  roomId: string;
  ourSide: SideId;
  startedAt: string;
  endedAt: string | null;
  result: GameResult | null;
  winnerName: string | null;
  turns: number;
  ourBringFour: string[];
  /** Opponent Pokémon actually revealed on the field this game (public). */
  opponentBringFour: string[];
  ourLead: string[];
  opponentLead: string[];
  observations: GameObservations;
  opponentSummary: OpponentGameSummary | null;
  decisions: DecisionRecord[];
  /** Raw protocol lines for the room (audit trail; not given to the agent). */
  battleEvents: string[];
  finalState: BattleState | null;
}

export interface Participant {
  name: string;
  userId: string;
}

export type SetPhase =
  | 'WAITING'
  | 'SET_CREATED'
  | 'GAME_TEAM_PREVIEW'
  | 'GAME_ACTIVE'
  | 'GAME_COMPLETE'
  | 'BETWEEN_GAMES'
  | 'READY_CONFIRMED'
  | 'SET_COMPLETE';

/**
 * State that spans the whole best-of-three. Never reset between games.
 */
export interface SetState {
  setId: string;
  formatId: string;
  formatName: string;
  parentRoomId: string | null;
  us: Participant;
  opponent: Participant;
  startedAt: string;
  endedAt: string | null;
  ourTeam: PokemonSet[];
  ourTeamSheet: TeamSheet | null;
  opponentTeamSheet: TeamSheet | null;
  ourWins: number;
  opponentWins: number;
  ties: number;
  /** 1-based number of the game currently (or most recently) being played. */
  currentGame: number;
  games: GameRecord[];
  phase: SetPhase;
  setFinished: boolean;
  setWinner: 'us' | 'opponent' | 'tie' | null;
  setWinnerName: string | null;
  opponentSetObservations: OpponentSetObservations;
  ourSetObservations: OurSetObservations;
}

export interface OpponentSetObservations {
  /** Species that have appeared in at least one game. */
  seenBrought: string[];
  leadsByGame: Record<number, string[]>;
  bringByGame: Record<number, string[]>;
  protectCountBySpecies: Record<string, number>;
  switchCountBySpecies: Record<string, number>;
  megaEvolvedSpecies: string[];
  revealedMovesBySpecies: Record<string, string[]>;
  revealedItemsBySpecies: Record<string, string>;
}

export interface OurSetObservations {
  leadsByGame: Record<number, string[]>;
  bringByGame: Record<number, string[]>;
  resultsByGame: Record<number, GameResult>;
}

export function scoreString(set: SetState): string {
  return `${set.ourWins}-${set.opponentWins}`;
}
