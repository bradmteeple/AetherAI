import { toID } from '../util/id';
import { emptyStats, PokemonSet, StatsTable } from './types';

/**
 * Packed team format (sim/TEAMS.md):
 *
 *   NICKNAME|SPECIES|ITEM|ABILITY|MOVES|NATURE|EVS|GENDER|IVS|SHINY|LEVEL|HAPPINESS,POKEBALL,HPTYPE,GMAX,DMAXLEVEL,TERATYPE
 *
 * This is a dependency-free re-implementation of `Teams.pack`/`Teams.unpack`.
 * Names are packed as ids; unpacking keeps ids (a Dex can prettify later).
 */
/** Showdown's `Teams.packName`: strips non-alphanumerics but keeps case. */
export function packName(name: string | undefined): string {
  return (name ?? '').replace(/[^A-Za-z0-9]+/g, '');
}

export function packTeam(team: PokemonSet[]): string {
  const parts: string[] = [];
  for (const set of team) {
    let buf = set.name || set.species;
    const speciesId = packName(set.species || set.name);
    buf += `|${packName(set.name || set.species) === speciesId ? '' : speciesId}`;
    buf += `|${packName(set.item)}`;
    buf += `|${packName(set.ability)}`;
    buf += `|${set.moves.map(packName).join(',')}`;
    buf += `|${set.nature || ''}`;
    const evs = set.evs
      ? `${set.evs.hp || ''},${set.evs.atk || ''},${set.evs.def || ''},${set.evs.spa || ''},${set.evs.spd || ''},${set.evs.spe || ''}`
      : '';
    buf += `|${evs === ',,,,,' ? '' : evs}`;
    buf += `|${set.gender || ''}`;
    const iv = (v: number | undefined) => (v === 31 || v === undefined ? '' : String(v));
    const ivs = set.ivs
      ? `${iv(set.ivs.hp)},${iv(set.ivs.atk)},${iv(set.ivs.def)},${iv(set.ivs.spa)},${iv(set.ivs.spd)},${iv(set.ivs.spe)}`
      : '';
    buf += `|${ivs === ',,,,,' ? '' : ivs}`;
    buf += `|${set.shiny ? 'S' : ''}`;
    buf += `|${set.level && set.level !== 100 ? set.level : ''}`;
    buf += `|${set.happiness !== undefined && set.happiness !== 255 ? set.happiness : ''}`;
    if (set.pokeball || set.hpType || set.gigantamax || (set.dynamaxLevel !== undefined && set.dynamaxLevel !== 10) || set.teraType) {
      buf += `,${set.hpType || ''}`;
      buf += `,${packName(set.pokeball || '')}`;
      buf += `,${set.gigantamax ? 'G' : ''}`;
      buf += `,${set.dynamaxLevel !== undefined && set.dynamaxLevel !== 10 ? set.dynamaxLevel : ''}`;
      buf += `,${set.teraType || ''}`;
    }
    parts.push(buf);
  }
  return parts.join(']');
}

export interface UnpackedSet {
  name: string;
  /** Species as written in the packed string (display name in the first slot, id in the second). */
  species: string;
  speciesId: string;
  item: string;
  ability: string;
  moves: string[];
  nature: string;
  /** null when the packed string left the field blank (as OTS does). */
  evs: StatsTable | null;
  gender: string;
  ivs: StatsTable | null;
  shiny: boolean;
  level: number;
  happiness?: number;
  pokeball?: string;
  hpType?: string;
  gigantamax?: boolean;
  dynamaxLevel?: number;
  teraType?: string;
}

export function unpackTeam(buf: string): UnpackedSet[] {
  if (!buf) return [];
  const out: UnpackedSet[] = [];
  for (const chunk of buf.split(']')) {
    if (!chunk) continue;
    const fields = chunk.split('|');
    if (fields.length < 11) throw new Error(`Malformed packed set: ${chunk.slice(0, 80)}`);
    const [name, speciesField, item, ability, movesField, nature, evsField, gender, ivsField, shiny, level, ...tail] = fields;
    const misc = (tail.join('|') || '').split(',');
    const speciesId = toID(speciesField || name);
    const parseStats = (s: string, blank: number): StatsTable | null => {
      if (!s) return null;
      const parts = s.split(',');
      const stats = emptyStats(blank);
      const keys: (keyof StatsTable)[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
      keys.forEach((k, i) => {
        const v = parts[i];
        stats[k] = v === '' || v === undefined ? blank : Number(v) || 0;
      });
      return stats;
    };
    const set: UnpackedSet = {
      name: speciesField ? name : '',
      species: speciesField ? speciesField : name,
      speciesId,
      item: item ?? '',
      ability: ability ?? '',
      moves: (movesField ?? '').split(',').filter(Boolean),
      nature: nature ?? '',
      evs: parseStats(evsField ?? '', 0),
      gender: gender ?? '',
      ivs: parseStats(ivsField ?? '', 31),
      shiny: shiny === 'S',
      level: level ? parseInt(level, 10) : 100,
    };
    if (misc[0]) set.happiness = parseInt(misc[0], 10);
    if (misc[1]) set.hpType = misc[1];
    if (misc[2]) set.pokeball = misc[2];
    if (misc[3]) set.gigantamax = misc[3] === 'G';
    if (misc[4]) set.dynamaxLevel = parseInt(misc[4], 10);
    if (misc[5]) set.teraType = misc[5];
    out.push(set);
  }
  return out;
}
