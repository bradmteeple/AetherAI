import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { toID } from '../util/id';

/**
 * Optional bridge to Showdown's own data. The connector never *requires* it,
 * but when available (a local checkout in `SHOWDOWN_DIR` / `.showdown`, or
 * the `pokemon-showdown` npm package) it is used for:
 *   - prettifying ids from team sheets into display names
 *   - exact local team validation with the real TeamValidator
 *   - move target types when the server omits them
 */
export interface NameResolver {
  species(idOrName: string): string;
  item(id: string): string;
  ability(id: string): string;
  move(id: string): string;
}

export const plainNameResolver: NameResolver = {
  species: (s) => s,
  item: (s) => s,
  ability: (s) => s,
  move: (s) => s,
};

export interface DexLike {
  formats: { get(name: string): { exists: boolean; id: string; name: string; mod?: string } };
  species: { get(name: string): { exists: boolean; name: string; id: string; types?: string[]; baseStats?: Record<string, number> } };
  items: { get(name: string): { exists: boolean; name: string } };
  abilities: { get(name: string): { exists: boolean; name: string } };
  moves: { get(name: string): { exists: boolean; name: string; target?: string; priority?: number; category?: string; type?: string; basePower?: number } };
  forFormat?(format: string): DexLike;
}

export interface ShowdownModule {
  Dex: DexLike;
  Teams: { pack(team: unknown[]): string; unpack(packed: string): unknown[] | null; import(text: string): unknown[] | null };
  TeamValidator: { get(format: string): { validateTeam(team: unknown[]): string[] | null } };
}

let cached: ShowdownModule | null | undefined;

export function candidateShowdownDirs(): string[] {
  const dirs = [process.env.SHOWDOWN_DIR, resolve(process.cwd(), '.showdown'), resolve(__dirname, '../../.showdown')];
  return dirs.filter((d): d is string => !!d);
}

/** Load Showdown's sim from a checkout or the npm package. Returns null if unavailable. */
export function loadShowdown(): ShowdownModule | null {
  if (cached !== undefined) return cached;
  cached = null;
  for (const dir of candidateShowdownDirs()) {
    const entry = resolve(dir, 'dist/sim/index.js');
    if (existsSync(entry)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        cached = require(entry) as ShowdownModule;
        return cached;
      } catch {
        /* try next */
      }
    }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('pokemon-showdown') as ShowdownModule;
  } catch {
    cached = null;
  }
  return cached;
}

export function dexNameResolver(dex: DexLike | null): NameResolver {
  if (!dex) return plainNameResolver;
  const pick = (get: (s: string) => { exists: boolean; name: string }) => (s: string) => {
    if (!s) return s;
    const data = get(s);
    return data.exists ? data.name : s;
  };
  return {
    species: pick((s) => dex.species.get(s)),
    item: pick((s) => dex.items.get(s)),
    ability: pick((s) => dex.abilities.get(s)),
    move: pick((s) => dex.moves.get(s)),
  };
}

export function defaultNameResolver(): NameResolver {
  const sd = loadShowdown();
  return dexNameResolver(sd?.Dex ?? null);
}

export function idOf(name: string): string {
  return toID(name);
}
