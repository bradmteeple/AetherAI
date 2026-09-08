/**
 * The `|request|` JSON shapes emitted by the simulator (sim/side.ts:95-165,
 * sim/pokemon.ts:1159-1193, sim/battle.ts:1419-1460). The connector never
 * fabricates legality: it reads these structures.
 */
export type SideId = 'p1' | 'p2';

export interface RequestMove {
  move: string;
  id: string;
  pp?: number;
  maxpp?: number;
  /** Move target type (`normal`, `adjacentFoe`, `allAdjacentFoes`, `self`, ...). */
  target?: string;
  disabled?: boolean | string;
  disabledSource?: string;
}

export interface RequestActive {
  moves: RequestMove[];
  maybeDisabled?: boolean;
  maybeLocked?: boolean;
  trapped?: boolean;
  maybeTrapped?: boolean;
  canMegaEvo?: boolean;
  canMegaEvoX?: boolean;
  canMegaEvoY?: boolean;
  canUltraBurst?: boolean;
  canZMove?: unknown;
  canDynamax?: boolean;
  maxMoves?: unknown;
  canTerastallize?: string;
}

export interface RequestPokemon {
  /** `p1: Nickname` */
  ident: string;
  /** `Species, L50, F` */
  details: string;
  /** `123/200` / `0 fnt` / `150/200 par` */
  condition: string;
  active: boolean;
  stats: { atk: number; def: number; spa: number; spd: number; spe: number };
  moves: string[];
  baseAbility: string;
  item: string;
  pokeball: string;
  ability?: string;
  commanding?: boolean;
  reviving?: boolean;
  teraType?: string;
  terastallized?: string;
}

export interface RequestSide {
  name: string;
  id: SideId;
  pokemon: RequestPokemon[];
}

export interface ChoiceRequest {
  rqid?: number;
  wait?: boolean;
  teamPreview?: boolean;
  maxChosenTeamSize?: number;
  forceSwitch?: boolean[];
  active?: RequestActive[];
  side: RequestSide;
  noCancel?: boolean;
  update?: boolean;
}

export type RequestKind = 'wait' | 'teampreview' | 'switch' | 'move';

export function requestKind(req: ChoiceRequest): RequestKind {
  if (req.wait) return 'wait';
  if (req.teamPreview) return 'teampreview';
  if (req.forceSwitch) return 'switch';
  return 'move';
}

export interface ParsedCondition {
  hp: number;
  maxhp: number;
  status: string;
  fainted: boolean;
}

/** Parse `condition` strings such as `123/200 par`, `0 fnt`, `45/100`. */
export function parseCondition(condition: string): ParsedCondition {
  const [hpPart, status = ''] = condition.trim().split(' ');
  if (hpPart === '0' || status === 'fnt') {
    const maxhp = hpPart.includes('/') ? Number(hpPart.split('/')[1]) : 100;
    return { hp: 0, maxhp: maxhp || 100, status: 'fnt', fainted: true };
  }
  const [hp, maxhp] = hpPart.split('/').map(Number);
  return { hp: hp || 0, maxhp: maxhp || 100, status, fainted: false };
}

export interface ParsedDetails {
  species: string;
  level: number;
  gender: string;
  shiny: boolean;
  tera: string | null;
}

/** Parse `DETAILS` strings: `Incineroar, L50, M, shiny, tera:Fire`. */
export function parseDetails(details: string): ParsedDetails {
  const parts = details.split(',').map((p) => p.trim());
  const out: ParsedDetails = { species: parts[0] ?? '', level: 100, gender: '', shiny: false, tera: null };
  for (const p of parts.slice(1)) {
    if (/^L\d+$/.test(p)) out.level = Number(p.slice(1));
    else if (p === 'M' || p === 'F') out.gender = p;
    else if (p === 'shiny') out.shiny = true;
    else if (p.startsWith('tera:')) out.tera = p.slice(5);
  }
  return out;
}

/** `p1a: Sparky` → { side: 'p1', position: 0, name: 'Sparky' }. Position is null for inactive idents (`p1: Sparky`). */
export function parseIdent(ident: string): { side: SideId; position: number | null; name: string } {
  const colon = ident.indexOf(':');
  const posPart = colon >= 0 ? ident.slice(0, colon) : ident;
  const name = colon >= 0 ? ident.slice(colon + 1).trim() : '';
  const side = posPart.slice(0, 2) as SideId;
  const letter = posPart.slice(2, 3);
  const position = letter ? letter.charCodeAt(0) - 'a'.charCodeAt(0) : null;
  return { side, position, name };
}
