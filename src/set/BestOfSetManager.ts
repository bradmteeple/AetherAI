import { RoomMessage, parseChat } from '../showdown/protocol';
import { extractRoomLinks, isBattleRoom, isBestOfRoom, parseBestOfRoomId } from '../showdown/rooms';
import { toID } from '../util/id';
import { Logger, silentLogger } from '../util/logger';
import { SetPhase } from './SetState';
import { BEST_OF, WIN_THRESHOLD } from '../format';

export type SetManagerEvent =
  | { type: 'setCreated'; parentRoomId: string; bestOf: number }
  | { type: 'gameRoomLinked'; roomId: string; gameNumber: number }
  | { type: 'gameEnded'; roomId: string; gameNumber: number; winnerName: string | null; tie: boolean; ourResult: 'win' | 'loss' | 'tie' }
  | { type: 'readyPrompt'; parentRoomId: string; nextGameNumber: number }
  | { type: 'playerReady'; name: string; gameNumber: number; isUs: boolean }
  | { type: 'setEnded'; winnerName: string | null; ourResult: 'win' | 'loss' | 'tie' }
  | { type: 'phase'; phase: SetPhase }
  | { type: 'players'; names: string[] };

export interface BestOfSetManagerOptions {
  ourUserId: string;
  formatId: string;
  logger?: Logger;
}

/**
 * Pure state machine (no IO) that recognises Showdown's native best-of flow
 * from protocol messages: parent room, sub-battle rooms, per-game results,
 * the between-games ready prompt, and set completion. See ARCHITECTURE.md §4.
 */
export class BestOfSetManager {
  readonly ourUserId: string;
  readonly formatId: string;
  private readonly log: Logger;
  parentRoomId: string | null = null;
  bestOf = BEST_OF;
  winThreshold = WIN_THRESHOLD;
  phase: SetPhase = 'WAITING';
  /** roomId → game number */
  readonly gameRooms = new Map<string, number>();
  /** game number → roomId */
  readonly roomsByGame = new Map<number, string>();
  readonly endedGames = new Set<number>();
  private readonly unlinkedBattleRooms = new Set<string>();
  private readonly readyPrompted = new Set<number>();
  ourWins = 0;
  opponentWins = 0;
  ties = 0;
  playerNames: string[] = [];
  setEnded = false;
  setWinnerName: string | null = null;

  constructor(options: BestOfSetManagerOptions) {
    this.ourUserId = options.ourUserId;
    this.formatId = options.formatId;
    this.log = options.logger ?? silentLogger;
  }

  get currentGameNumber(): number {
    return Math.max(0, ...this.gameRooms.values());
  }

  get activeGameRoom(): string | null {
    const n = this.currentGameNumber;
    return n ? this.roomsByGame.get(n) ?? null : null;
  }

  get nextGameNumber(): number {
    return this.gameRooms.size + 1;
  }

  scoreForUs(): { ourWins: number; opponentWins: number; ties: number } {
    return { ourWins: this.ourWins, opponentWins: this.opponentWins, ties: this.ties };
  }

  private setPhase(phase: SetPhase, events: SetManagerEvent[]) {
    if (this.phase === phase) return;
    this.phase = phase;
    events.push({ type: 'phase', phase });
  }

  /** Called by the orchestrator when team preview / battle begins in the active game. */
  markGamePhase(phase: 'GAME_TEAM_PREVIEW' | 'GAME_ACTIVE'): SetManagerEvent[] {
    const events: SetManagerEvent[] = [];
    if (!this.setEnded) this.setPhase(phase, events);
    return events;
  }

  handleMessage(msg: RoomMessage): SetManagerEvent[] {
    const events: SetManagerEvent[] = [];
    if (isBestOfRoom(msg.room)) this.handleParent(msg, events);
    else if (isBattleRoom(msg.room)) this.handleBattle(msg, events);
    return events;
  }

  private handleParent(msg: RoomMessage, events: SetManagerEvent[]) {
    const room = msg.room;
    if (this.parentRoomId && this.parentRoomId !== room) {
      if (msg.type === 'init') this.log.warn(`ignoring second best-of room ${room} (already tracking ${this.parentRoomId})`);
      return;
    }
    switch (msg.type) {
      case 'init': {
        if (this.parentRoomId === room) break; // re-join after reconnect
        const info = parseBestOfRoomId(room);
        if (info && info.formatId !== this.formatId) {
          this.log.warn(`best-of room ${room} is for format ${info.formatId}, expected ${this.formatId}`);
        }
        this.parentRoomId = room;
        this.bestOf = info?.bestOf ?? BEST_OF;
        this.winThreshold = Math.floor(this.bestOf / 2) + 1;
        this.setPhase('SET_CREATED', events);
        events.push({ type: 'setCreated', parentRoomId: room, bestOf: this.bestOf });
        // Battle rooms that showed up before the parent stay pending until their
        // |uhtml|bestof| line (or the parent's |uhtml|gameN| link) names the game.
        break;
      }
      case 'title': {
        const names = msg.rest.split(' vs. ').map((s) => s.trim()).filter(Boolean);
        if (names.length === 2) {
          this.playerNames = names;
          events.push({ type: 'players', names });
        }
        break;
      }
      case 'uhtml':
      case 'uhtmlchange': {
        const [name, ...htmlParts] = msg.args;
        const html = htmlParts.join('|');
        const m = /^game(\d+)$/.exec(name ?? '');
        if (m) {
          const gameNumber = Number(m[1]);
          const link = extractRoomLinks(html).find(isBattleRoom);
          if (link) this.linkGame(link, gameNumber, events);
        }
        break;
      }
      case 'html': {
        const won = /^(.+?) won game (\d+)!/.exec(stripTags(msg.rest));
        if (won) this.log.info(`server: ${won[1]} won game ${won[2]}`);
        break;
      }
      case 'c':
      case 'chat':
      case 'c:':
        this.handleControlsChat(msg, events, room);
        break;
      case 'tempnotify':
        if (msg.args[0] === 'choice') this.handleReadyPrompt(msg.rest, room, events);
        break;
      case '': {
        const ready = /^(.+?) is ready for game (\d+)\.$/.exec(msg.rest.trim());
        if (ready) {
          events.push({ type: 'playerReady', name: ready[1], gameNumber: Number(ready[2]), isUs: toID(ready[1]) === this.ourUserId });
          if (toID(ready[1]) === this.ourUserId) this.setPhase('READY_CONFIRMED', events);
        }
        break;
      }
      case 'win':
      case 'tie': {
        if (this.setEnded) break;
        this.setEnded = true;
        this.setWinnerName = msg.type === 'win' ? msg.rest : null;
        const ourResult = msg.type === 'tie' ? 'tie' : toID(msg.rest) === this.ourUserId ? 'win' : 'loss';
        this.setPhase('SET_COMPLETE', events);
        events.push({ type: 'setEnded', winnerName: this.setWinnerName, ourResult });
        break;
      }
      default:
        break;
    }
  }

  private handleBattle(msg: RoomMessage, events: SetManagerEvent[]) {
    const room = msg.room;
    switch (msg.type) {
      case 'init':
        if (!this.gameRooms.has(room)) this.unlinkedBattleRooms.add(room);
        break;
      case 'uhtml':
      case 'uhtmlchange': {
        const [name, ...htmlParts] = msg.args;
        const html = htmlParts.join('|');
        if (name === 'bestof') {
          const m = /Game (\d+)/.exec(stripTags(html));
          const parent = extractRoomLinks(html).find(isBestOfRoom);
          if (parent && this.parentRoomId && parent !== this.parentRoomId) {
            this.log.warn(`battle ${room} belongs to a different set (${parent}); ignoring`);
            this.unlinkedBattleRooms.delete(room);
            return;
          }
          if (parent && !this.parentRoomId) {
            // Parent init not seen yet (e.g. reconnect ordering). Adopt it.
            this.parentRoomId = parent;
            this.setPhase('SET_CREATED', events);
            events.push({ type: 'setCreated', parentRoomId: parent, bestOf: this.bestOf });
          }
          if (m) this.linkGame(room, Number(m[1]), events);
        } else if (name === 'next') {
          const m = /Game (\d+)/.exec(stripTags(html));
          const link = extractRoomLinks(html).find(isBattleRoom);
          if (m && link) this.linkGame(link, Number(m[1]), events);
        }
        break;
      }
      case 'win':
      case 'tie': {
        const gameNumber = this.gameRooms.get(room);
        if (!gameNumber || this.endedGames.has(gameNumber)) break;
        this.endedGames.add(gameNumber);
        const winnerName = msg.type === 'win' ? msg.rest : null;
        let ourResult: 'win' | 'loss' | 'tie';
        if (!winnerName) {
          this.ties++;
          this.winThreshold = Math.floor((this.bestOf - this.ties) / 2) + 1;
          ourResult = 'tie';
        } else if (toID(winnerName) === this.ourUserId) {
          this.ourWins++;
          ourResult = 'win';
        } else {
          this.opponentWins++;
          ourResult = 'loss';
        }
        this.setPhase('GAME_COMPLETE', events);
        events.push({ type: 'gameEnded', roomId: room, gameNumber, winnerName, tie: !winnerName, ourResult });
        break;
      }
      case 'c':
      case 'chat':
      case 'c:':
        this.handleControlsChat(msg, events, room);
        break;
      case 'tempnotify':
        if (msg.args[0] === 'choice') this.handleReadyPrompt(msg.rest, room, events);
        break;
      case '': {
        const ready = /^(.+?) is ready for game (\d+)\.$/.exec(msg.rest.trim());
        if (ready) events.push({ type: 'playerReady', name: ready[1], gameNumber: Number(ready[2]), isUs: toID(ready[1]) === this.ourUserId });
        break;
      }
      default:
        break;
    }
  }

  private handleControlsChat(msg: RoomMessage, events: SetManagerEvent[], room: string) {
    const chat = parseChat(msg);
    if (!chat) return;
    if (chat.user.trim() !== '~' && chat.user.trim() !== '') return;
    if (!chat.message.startsWith('/uhtml controls,')) return;
    const html = chat.message.slice('/uhtml controls,'.length);
    if (!html.includes('/confirmready')) return;
    if (/<button[^>]*disabled/.test(html)) return; // our own "waiting for opponent" re-render
    this.handleReadyPrompt(html, room, events);
  }

  private handleReadyPrompt(text: string, room: string, events: SetManagerEvent[]) {
    if (this.setEnded) return;
    const m = /game (\d+)/i.exec(stripTags(text));
    const nextGameNumber = m ? Number(m[1]) : this.nextGameNumber;
    if (this.readyPrompted.has(nextGameNumber)) return;
    this.readyPrompted.add(nextGameNumber);
    const parent = this.parentRoomId ?? (isBestOfRoom(room) ? room : null);
    if (!parent) {
      this.log.warn(`ready prompt for game ${nextGameNumber} but parent room unknown`);
      return;
    }
    this.setPhase('BETWEEN_GAMES', events);
    events.push({ type: 'readyPrompt', parentRoomId: parent, nextGameNumber });
  }

  private linkGame(roomId: string, gameNumber: number, events: SetManagerEvent[]) {
    const existing = this.gameRooms.get(roomId);
    if (existing === gameNumber) return;
    if (existing !== undefined) {
      this.log.warn(`room ${roomId} re-linked from game ${existing} to ${gameNumber}`);
      this.roomsByGame.delete(existing);
    }
    const expected = this.nextGameNumber;
    if (gameNumber !== expected && !this.roomsByGame.has(gameNumber)) {
      this.log.warn(`game number ${gameNumber} for ${roomId} does not match expected ${expected}`);
    }
    this.gameRooms.set(roomId, gameNumber);
    this.roomsByGame.set(gameNumber, roomId);
    this.unlinkedBattleRooms.delete(roomId);
    this.log.info(`game ${gameNumber} → ${roomId}`);
    events.push({ type: 'gameRoomLinked', roomId, gameNumber });
  }

  /** Whether, by our own count, the set should be decided. */
  expectedSetOver(): boolean {
    return this.ourWins >= this.winThreshold || this.opponentWins >= this.winThreshold || this.endedGames.size >= this.bestOf;
  }
}

export function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
