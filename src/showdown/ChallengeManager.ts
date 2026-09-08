import { ShowdownConnection } from './ShowdownConnection';
import { parsePm, RoomMessage } from './protocol';
import { cleanIdentity, toID } from '../util/id';
import { Logger, silentLogger } from '../util/logger';
import { isBestOfRoom } from './rooms';

/**
 * Challenge state as delivered by the current server: a PM of the form
 *
 *   /challenge FORMATID|TEAMBUILDERFORMATID|MESSAGE|ACCEPTBUTTON|REJECTBUTTON
 *
 * (server/ladders-challenges.ts getUpdate). A bare `/challenge` clears it.
 */
export interface IncomingChallenge {
  from: string;
  fromId: string;
  formatId: string;
  raw: string;
}

export interface ChallengeManagerOptions {
  logger?: Logger;
  /** Reject challenges in other formats automatically. */
  autoRejectOtherFormats?: boolean;
}

export class ChallengeError extends Error {}

export class ChallengeManager {
  private readonly log: Logger;
  private readonly pending = new Map<string, IncomingChallenge>();
  private readonly listeners = new Set<(c: IncomingChallenge) => void>();

  constructor(
    private readonly conn: ShowdownConnection,
    private readonly options: ChallengeManagerOptions = {},
  ) {
    this.log = options.logger ?? silentLogger;
    conn.on('message', (msg: RoomMessage) => this.onMessage(msg));
  }

  private onMessage(msg: RoomMessage) {
    if (msg.type !== 'pm' || msg.room) return;
    const pm = parsePm(msg);
    if (!pm) return;
    if (!pm.message.startsWith('/challenge')) return;
    const sender = cleanIdentity(pm.sender);
    const receiver = cleanIdentity(pm.receiver);
    const senderId = toID(sender);
    const isIncoming = toID(receiver) === this.conn.userId && senderId !== this.conn.userId;
    const body = pm.message.slice('/challenge'.length).trim();
    if (!body) {
      // challenge cancelled/consumed
      const other = isIncoming ? senderId : toID(receiver);
      if (this.pending.delete(other)) this.log.info(`challenge with ${other} cleared`);
      return;
    }
    const [formatId] = body.split('|');
    if (!isIncoming) return; // our own outgoing challenge echo
    const challenge: IncomingChallenge = { from: sender, fromId: senderId, formatId: toID(formatId), raw: pm.message };
    this.pending.set(senderId, challenge);
    this.log.info(`incoming challenge from ${sender} in ${challenge.formatId}`);
    for (const l of this.listeners) l(challenge);
  }

  get pendingChallenges(): IncomingChallenge[] {
    return [...this.pending.values()];
  }

  onIncoming(listener: (c: IncomingChallenge) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Send `/utm` + `/challenge`. Resolves with the best-of parent room id once
   * the server creates it, rejects on a validation popup or if the challenge
   * is rejected/cancelled.
   */
  challenge(opponent: string, formatId: string, packedTeam: string, timeoutMs = 120_000): Promise<string> {
    const opponentId = toID(opponent);
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        this.conn.off('message', handler);
        clearTimeout(timer);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new ChallengeError(`Challenge to ${opponent} was not accepted within ${timeoutMs}ms`));
      }, timeoutMs);
      let sentChallenge = false;
      const handler = (msg: RoomMessage) => {
        if (msg.type === 'popup' && !msg.room) {
          const text = msg.rest.replace(/\|\|/g, '\n');
          if (/not found|rejected|cannot challenge|locked|banned|already|blocking|team was rejected|Your team/i.test(text)) {
            cleanup();
            reject(new ChallengeError(`Challenge failed: ${text}`));
          }
          return;
        }
        if (msg.type === 'pm' && !msg.room) {
          const pm = parsePm(msg)!;
          const sender = toID(cleanIdentity(pm.sender));
          const receiver = toID(cleanIdentity(pm.receiver));
          const involvesOpponent = sender === opponentId || receiver === opponentId;
          if (!involvesOpponent) return;
          if (pm.message.startsWith('/challenge')) {
            const body = pm.message.slice('/challenge'.length).trim();
            if (body) sentChallenge = true;
            else if (sentChallenge) {
              // Cleared: either accepted (a room init follows) or rejected. Give the room a moment.
              setTimeout(() => {
                if (!settled) {
                  cleanup();
                  reject(new ChallengeError(`Challenge to ${opponent} was rejected or cancelled`));
                }
              }, 3_000);
            }
          } else if (/rejected the challenge|cancelled the challenge/i.test(pm.message)) {
            cleanup();
            reject(new ChallengeError(`Challenge to ${opponent} was rejected`));
          }
          return;
        }
        if (msg.type === 'init' && isBestOfRoom(msg.room)) {
          settled = true;
          cleanup();
          resolve(msg.room);
        }
      };
      let settled = false;
      this.conn.on('message', handler);
      this.conn.send('', `/utm ${packedTeam}`);
      this.conn.send('', `/challenge ${opponent}, ${formatId}`);
    });
  }

  /**
   * Wait for a challenge in `formatId` (optionally from a specific user) and
   * accept it. Resolves with the best-of parent room id.
   */
  acceptNext(formatId: string, packedTeam: string, from?: string, timeoutMs = 10 * 60_000): Promise<string> {
    const wantedFrom = from ? toID(from) : null;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new ChallengeError(`No ${formatId} challenge received within ${timeoutMs}ms`));
      }, timeoutMs);
      let accepting: string | null = null;
      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
        this.conn.off('message', roomHandler);
      };
      const roomHandler = (msg: RoomMessage) => {
        if (accepting && msg.type === 'init' && isBestOfRoom(msg.room)) {
          cleanup();
          resolve(msg.room);
        } else if (accepting && msg.type === 'popup' && !msg.room && /team was rejected|Your team/i.test(msg.rest)) {
          cleanup();
          reject(new ChallengeError(`Accept failed: ${msg.rest.replace(/\|\|/g, '\n')}`));
        }
      };
      const tryAccept = (c: IncomingChallenge) => {
        if (accepting) return;
        if (c.formatId !== toID(formatId)) {
          if (this.options.autoRejectOtherFormats) {
            this.log.info(`rejecting ${c.from}: wrong format ${c.formatId}`);
            this.conn.send('', `/reject ${c.from}`);
          }
          return;
        }
        if (wantedFrom && c.fromId !== wantedFrom) return;
        accepting = c.fromId;
        this.log.info(`accepting challenge from ${c.from}`);
        this.conn.send('', `/utm ${packedTeam}`);
        this.conn.send('', `/accept ${c.from}`);
      };
      const unsubscribe = this.onIncoming(tryAccept);
      this.conn.on('message', roomHandler);
      for (const c of this.pending.values()) tryAccept(c);
    });
  }
}
