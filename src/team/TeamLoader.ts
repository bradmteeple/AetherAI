import { readFileSync } from 'node:fs';
import { emptyStats, PokemonSet, STAT_IDS, StatId } from './types';
import { LEVEL } from '../format';

/**
 * Parses Showdown "export" text (the format the teambuilder copies) into
 * PokemonSets. Accepts `EVs:`, `Stat Points:` and `SPs:` for Champions stat
 * points. `Tera Type:` lines are parsed but ignored by the champions
 * validator (Terastallization does not exist in Champions).
 */
export function parseTeamText(text: string): PokemonSet[] {
  const blocks = text
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith('===') && !b.startsWith('#'));
  const team: PokemonSet[] = [];
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
    if (!lines.length) continue;
    const set: PokemonSet = {
      name: '',
      species: '',
      item: '',
      ability: '',
      moves: [],
      nature: '',
      gender: '',
      evs: emptyStats(0),
      ivs: emptyStats(31),
      level: LEVEL,
    };
    parseHeader(lines[0], set);
    for (const line of lines.slice(1)) {
      if (line.startsWith('- ')) {
        const move = line.slice(2).trim();
        if (move) set.moves.push(move.replace(/^Hidden Power \[(.+)\]$/, 'Hidden Power $1'));
      } else if (/^ability:/i.test(line)) {
        set.ability = line.slice(line.indexOf(':') + 1).trim();
      } else if (/^level:/i.test(line)) {
        set.level = parseInt(line.slice(line.indexOf(':') + 1).trim(), 10) || LEVEL;
      } else if (/^(evs|stat points|sps):/i.test(line)) {
        set.evs = parseStatLine(line.slice(line.indexOf(':') + 1), 0);
      } else if (/^ivs:/i.test(line)) {
        set.ivs = parseStatLine(line.slice(line.indexOf(':') + 1), 31);
      } else if (/^[A-Za-z]+ nature$/i.test(line)) {
        set.nature = line.split(' ')[0];
      } else if (/^shiny:/i.test(line)) {
        set.shiny = /yes|true/i.test(line);
      } else if (/^happiness:/i.test(line)) {
        set.happiness = parseInt(line.slice(line.indexOf(':') + 1).trim(), 10);
      } else if (/^tera type:/i.test(line)) {
        set.teraType = line.slice(line.indexOf(':') + 1).trim();
      } else if (/^gigantamax:/i.test(line)) {
        set.gigantamax = /yes|true/i.test(line);
      } else if (/^hidden power:/i.test(line)) {
        set.hpType = line.slice(line.indexOf(':') + 1).trim();
      } else if (/^pokeball:|^poké ball:|^poke ball:/i.test(line)) {
        set.pokeball = line.slice(line.indexOf(':') + 1).trim();
      }
      // unknown lines are ignored
    }
    if (!set.species) throw new Error(`Could not determine species in block:\n${block}`);
    team.push(set);
  }
  return team;
}

function parseHeader(line: string, set: PokemonSet) {
  let head = line;
  const at = head.indexOf(' @ ');
  if (at >= 0) {
    set.item = head.slice(at + 3).trim();
    head = head.slice(0, at).trim();
  }
  // gender suffix
  let m = /^(.*)\s\((M|F)\)$/.exec(head);
  if (m) {
    set.gender = m[2];
    head = m[1].trim();
  }
  // nickname (species)
  m = /^(.*)\s\(([^()]+)\)$/.exec(head);
  if (m) {
    set.name = m[1].trim();
    set.species = m[2].trim();
  } else {
    set.species = head.trim();
  }
}

function parseStatLine(text: string, blank: number) {
  const stats = emptyStats(blank);
  for (const part of text.split('/')) {
    const [value, name] = part.trim().split(/\s+/);
    if (!name) continue;
    const id = statIdFromName(name);
    if (!id) continue;
    const n = parseInt(value, 10);
    stats[id] = Number.isNaN(n) ? blank : n;
  }
  return stats;
}

function statIdFromName(name: string): StatId | null {
  const key = name.toLowerCase().replace(/[^a-z]/g, '');
  const table: Record<string, StatId> = {
    hp: 'hp', hitpoints: 'hp',
    atk: 'atk', attack: 'atk',
    def: 'def', defense: 'def', defence: 'def',
    spa: 'spa', spatk: 'spa', specialattack: 'spa', spattack: 'spa',
    spd: 'spd', spdef: 'spd', specialdefense: 'spd', spdefense: 'spd',
    spe: 'spe', speed: 'spe', spd_: 'spd',
  };
  if (table[key]) return table[key];
  return STAT_IDS.find((s) => s === key) ?? null;
}

export function loadTeamFile(path: string): PokemonSet[] {
  const text = readFileSync(path, 'utf8');
  const team = parseTeamText(text);
  if (!team.length) throw new Error(`No Pokémon found in team file ${path}`);
  return team;
}

/** Render a set back to export text (used for logs and the agent input). */
export function exportSet(set: PokemonSet, opts: { hideStats?: boolean } = {}): string {
  let out = set.name && set.name !== set.species ? `${set.name} (${set.species})` : set.species;
  if (set.gender) out += ` (${set.gender})`;
  if (set.item) out += ` @ ${set.item}`;
  out += '\n';
  if (set.ability) out += `Ability: ${set.ability}\n`;
  if (set.level && set.level !== 100) out += `Level: ${set.level}\n`;
  if (!opts.hideStats) {
    const evs = STAT_IDS.filter((s) => set.evs?.[s]).map((s) => `${set.evs[s]} ${s.toUpperCase()}`);
    if (evs.length) out += `EVs: ${evs.join(' / ')}\n`;
  }
  if (set.nature) out += `${set.nature} Nature\n`;
  for (const move of set.moves) out += `- ${move}\n`;
  return out;
}
