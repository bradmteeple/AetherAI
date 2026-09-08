import { toID } from '../util/id';

export type RoomKind = 'global' | 'lobby' | 'chat' | 'battle' | 'bestof';

/**
 * Room-id conventions from `server/rooms.ts`:
 *  - sub-battles:  `battle-<formatid>-<n>` (optionally `-<password>pw`)
 *  - best-of parents: `game-bestof<N>-<formatid>-<n>`
 */
export function classifyRoom(roomId: string): RoomKind {
  if (!roomId) return 'global';
  if (roomId === 'lobby') return 'lobby';
  if (roomId.startsWith('game-bestof')) return 'bestof';
  if (roomId.startsWith('battle-')) return 'battle';
  return 'chat';
}

export function isBattleRoom(roomId: string): boolean {
  return classifyRoom(roomId) === 'battle';
}

export function isBestOfRoom(roomId: string): boolean {
  return classifyRoom(roomId) === 'bestof';
}

export interface BestOfRoomInfo {
  roomId: string;
  bestOf: number;
  formatId: string;
  battleNumber: number;
}

export function parseBestOfRoomId(roomId: string): BestOfRoomInfo | null {
  const m = /^game-bestof(\d+)-([a-z0-9]+)-(\d+)(?:-[a-z0-9]+pw)?$/.exec(roomId);
  if (!m) return null;
  return { roomId, bestOf: Number(m[1]), formatId: m[2], battleNumber: Number(m[3]) };
}

export interface BattleRoomInfo {
  roomId: string;
  formatId: string;
  battleNumber: number;
}

export function parseBattleRoomId(roomId: string): BattleRoomInfo | null {
  const m = /^battle-([a-z0-9]+)-(\d+)(?:-[a-z0-9]+pw)?$/.exec(roomId);
  if (!m) return null;
  return { roomId, formatId: m[1], battleNumber: Number(m[2]) };
}

/**
 * Extract every room link (`href="/roomid"`) from an HTML fragment. Used to
 * follow `|uhtml|bestof|...`, `|uhtml|gameN|...` and `|uhtml|next|...`.
 */
export function extractRoomLinks(html: string): string[] {
  const out: string[] = [];
  const re = /href="\/([a-z0-9-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

export function sameUser(a: string, b: string): boolean {
  return toID(a) === toID(b);
}
