import { ChoiceRequest, SideId } from './request';

export type Boosts = Record<'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy' | 'evasion', number>;

export function emptyBoosts(): Boosts {
  return { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
}

export interface MoveSlotState {
  id: string;
  name: string;
  pp: number | null;
  maxpp: number | null;
  disabled: boolean;
  target: string | null;
}

export interface PokemonState {
  /** 1-based slot in the original (team preview) order. */
  slot: number;
  /** `p1: Nickname` (without the position letter). */
  ident: string;
  side: SideId;
  nickname: string;
  species: string;
  /** Species before Mega Evolution / forme change. */
  baseSpecies: string;
  details: string;
  level: number;
  gender: string;
  /** Exact HP for our side; for the opponent `hp` is a percentage (0-100) and `maxhp` is 100. */
  hp: number;
  maxhp: number;
  hpPercent: number;
  status: string;
  fainted: boolean;
  active: boolean;
  /** 0 = position a, 1 = position b, null if benched. */
  position: number | null;
  boosts: Boosts;
  volatiles: string[];
  /** Item as currently known (ours: exact; opponent: from the team sheet or reveals). */
  item: string | null;
  itemKnownFrom: 'request' | 'sheet' | 'reveal' | null;
  ability: string | null;
  abilityKnownFrom: 'request' | 'sheet' | 'reveal' | null;
  /** Our moves come from the request; opponent moves are the sheet's list. */
  moves: MoveSlotState[];
  /** Moves actually seen used in this game (opponent knowledge). */
  revealedMoves: string[];
  megaEvolved: boolean;
  /** Turn on which this Pokémon last switched in. */
  lastSwitchInTurn: number | null;
  timesSwitchedIn: number;
  lastMove: string | null;
}

export interface SideConditionState {
  id: string;
  name: string;
  /** Turn on which it started (turns remaining are not public; derive from move data if needed). */
  startedTurn: number;
}

export interface SideState {
  id: SideId;
  name: string;
  isUs: boolean;
  /** Total Pokémon this side brought (4 in VGC after team preview). */
  totalPokemon: number;
  pokemon: PokemonState[];
  /** Active slots: index 0 = position a, 1 = position b. */
  active: (PokemonState | null)[];
  conditions: SideConditionState[];
}

export interface FieldState {
  weather: string | null;
  weatherStartedTurn: number | null;
  terrain: string | null;
  terrainStartedTurn: number | null;
  /** Pseudo-weathers: Trick Room, Gravity, Magic Room, Wonder Room, ... */
  pseudoWeather: { id: string; name: string; startedTurn: number }[];
}

export interface PlayerInfo {
  side: SideId;
  name: string;
  avatar: string;
  rating: string;
}

export type BattlePhase = 'init' | 'teampreview' | 'battle' | 'ended';

export interface BattleState {
  roomId: string;
  gameNumber: number;
  formatId: string;
  formatName: string;
  gameType: string;
  gen: number;
  phase: BattlePhase;
  turn: number;
  ourSide: SideId;
  players: Partial<Record<SideId, PlayerInfo>>;
  sides: Record<SideId, SideState>;
  field: FieldState;
  /** Latest choice request from the server (null when nothing is pending). */
  request: ChoiceRequest | null;
  rqid: number | null;
  /** The last choice we sent for `rqid` (helps after reconnects; server echoes `|sentchoice|`). */
  sentChoice: string | null;
  winner: string | null;
  tie: boolean;
  ended: boolean;
  /** Raw protocol lines received in this room (for records/debugging). */
  log: string[];
  /** `|showteam|` sheets received in this room. */
  teamSheets: Partial<Record<SideId, string>>;
  timerOn: boolean;
  lastError: string | null;
}

export function opponentOf(side: SideId): SideId {
  return side === 'p1' ? 'p2' : 'p1';
}
