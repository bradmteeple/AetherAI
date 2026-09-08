import { PokemonSet, STAT_IDS } from './types';
import { packTeam } from './PackedTeam';
import { ShowdownConnection } from '../showdown/ShowdownConnection';
import { RoomMessage } from '../showdown/protocol';
import { loadShowdown } from './dex';
import {
  FORMAT_ID, MAX_MOVES, STAT_POINT_PER_STAT_LIMIT, STAT_POINT_TOTAL_LIMIT, TEAM_SIZE,
} from '../format';
import { toID } from '../util/id';

export interface ValidationResult {
  ok: boolean;
  problems: string[];
  /** Which validator produced the verdict. */
  source: 'static' | 'local-showdown' | 'server';
}

/**
 * Fast structural checks for Regulation M-B (Champions) teams. These do not
 * replace Showdown's validator; they catch obvious mistakes before we even
 * connect. Exact legality always comes from `validateWithServer` (or the
 * local Showdown checkout).
 */
export function staticChecks(team: PokemonSet[]): ValidationResult {
  const problems: string[] = [];
  if (team.length !== TEAM_SIZE) problems.push(`Team has ${team.length} Pokémon; Reg M-B requires exactly ${TEAM_SIZE}.`);
  const species = new Set<string>();
  const items = new Set<string>();
  for (const set of team) {
    const name = set.name || set.species;
    const sid = toID(set.species).replace(/mega[xy]?$/, '');
    if (species.has(sid)) problems.push(`${name}: Species Clause — duplicate species.`);
    species.add(sid);
    if (set.item) {
      const iid = toID(set.item);
      if (items.has(iid)) problems.push(`${name}: Item Clause — ${set.item} is used more than once.`);
      items.add(iid);
    }
    if (!set.ability) problems.push(`${name}: missing ability.`);
    if (!set.moves.length) problems.push(`${name}: has no moves.`);
    if (set.moves.length > MAX_MOVES) problems.push(`${name}: has ${set.moves.length} moves (max ${MAX_MOVES}).`);
    if (set.level !== 50) problems.push(`${name}: level ${set.level} — Reg M-B plays at level 50 (Adjust Level = 50).`);
    const total = STAT_IDS.reduce((sum, s) => sum + (set.evs?.[s] ?? 0), 0);
    if (total > STAT_POINT_TOTAL_LIMIT) problems.push(`${name}: ${total} Stat Points, limit is ${STAT_POINT_TOTAL_LIMIT}.`);
    for (const s of STAT_IDS) {
      if ((set.evs?.[s] ?? 0) > STAT_POINT_PER_STAT_LIMIT) {
        problems.push(`${name}: ${set.evs[s]} Stat Points in ${s}, max is ${STAT_POINT_PER_STAT_LIMIT}.`);
      }
      if (set.ivs && set.ivs[s] !== 31) problems.push(`${name}: IVs must all be 31 in Champions (found ${set.ivs[s]} ${s}).`);
    }
    if (set.teraType) problems.push(`${name}: Tera Type is ignored — Terastallization does not exist in Champions.`);
  }
  return { ok: !problems.some((p) => !p.includes('is ignored')), problems, source: 'static' };
}

/** Exact validation with Showdown's TeamValidator if a checkout/package is available. */
export function validateLocally(team: PokemonSet[], formatId = FORMAT_ID): ValidationResult | null {
  const sd = loadShowdown();
  if (!sd) return null;
  const format = sd.Dex.formats.get(formatId);
  if (!format.exists) return { ok: false, problems: [`Local Showdown build does not know format ${formatId}`], source: 'local-showdown' };
  const validator = sd.TeamValidator.get(formatId);
  const problems = validator.validateTeam(team.map((s) => ({ ...s })));
  return { ok: !problems, problems: problems ?? [], source: 'local-showdown' };
}

/**
 * Authoritative validation against the connected server: `/utm` then
 * `/vtm FORMAT` (server/chat-commands/core.ts:1659-1677). The result is a popup.
 */
export function validateWithServer(conn: ShowdownConnection, team: PokemonSet[], formatId = FORMAT_ID, timeoutMs = 20_000): Promise<ValidationResult> {
  const packed = packTeam(team);
  return new Promise<ValidationResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.off('message', handler);
      reject(new Error('Timed out waiting for /vtm response'));
    }, timeoutMs);
    const handler = (msg: RoomMessage) => {
      if (msg.type !== 'popup' || msg.room) return;
      const text = msg.rest.replace(/\|\|/g, '\n');
      if (/^Your team is valid for /.test(text)) {
        clearTimeout(timer);
        conn.off('message', handler);
        resolve({ ok: true, problems: [], source: 'server' });
      } else if (/Your team was rejected/.test(text) || /format .* was not found/i.test(text) || /Please provide a valid format/i.test(text)) {
        clearTimeout(timer);
        conn.off('message', handler);
        const problems = text
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('- '))
          .map((l) => l.slice(2));
        resolve({ ok: false, problems: problems.length ? problems : [text], source: 'server' });
      }
    };
    conn.on('message', handler);
    conn.send('', `/utm ${packed}`);
    conn.send('', `/vtm ${formatId}`);
  });
}
