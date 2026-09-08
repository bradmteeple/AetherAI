export type StatId = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export const STAT_IDS: StatId[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export const STAT_SHORT_NAMES: Record<StatId, string> = {
  hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe',
};
export type StatsTable = Record<StatId, number>;

/** Mirrors Showdown's PokemonSet (sim/teams.ts). `evs` are Stat Points in Champions. */
export interface PokemonSet {
  name: string;
  species: string;
  item: string;
  ability: string;
  moves: string[];
  nature: string;
  gender: string;
  evs: StatsTable;
  ivs: StatsTable;
  level: number;
  shiny?: boolean;
  happiness?: number;
  pokeball?: string;
  hpType?: string;
  gigantamax?: boolean;
  dynamaxLevel?: number;
  teraType?: string;
}

export function emptyStats(fill = 0): StatsTable {
  return { hp: fill, atk: fill, def: fill, spa: fill, spd: fill, spe: fill };
}
