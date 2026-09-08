import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { LoginClient } from './LoginClient';
import { parseFrame, RoomMessage } from './protocol';
import { Logger, silentLogger } from '../util/logger';
import { Deferred, sleep } from '../util/async';
import { cleanIdentity, toID } from '../util/id';

export interface ShowdownConnectionOptions {
  /** e.g. wss://sim3.psim.us/showdown/websocket */
  serverUrl: string;
  /** e.g. https://play.pokemonshowdown.com/api/ (ignored when `noLoginServer`). */
  loginUrl?: string;
  username: string;
  password?: string;
  /**
   * Local servers started with `--no-security` accept `/trn NAME,0,` with an
   * empty assertion. Set this to skip the HTTP login round-trip.
   */
  noLoginServer?: boolean;
  avatar?: string;
  logger?: Logger;
  /** Minimum delay between outgoing messages (the official server throttles). */
  sendIntervalMs?: number;
  reconnect?: {
    enabled: boolean;
    initialDelayMs?: number;
    maxDelayMs?: number;
    maxAttempts?: number;
  };
  loginTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'loggedin';

export interface ConnectionEvents {
  message: (msg: RoomMessage) => void;
  frame: (raw: string) => void;
  state: (state: ConnectionState) => void;
  loggedin: (username: string) => void;
  disconnected: (reason: string) => void;
  reconnected: () => void;
  error: (err: Error) => void;
  sent: (room: string, text: string) => void;
}

/**
 * Raw-WebSocket client for Pokémon Showdown.
 *
 * Responsibilities: socket lifecycle, login (`|challstr|` → `/trn`), automatic
 * reconnection with re-login, room membership tracking (`|init|`/`|deinit|`),
 * a paced outgoing queue, and fan-out of parsed `RoomMessage`s. It contains
 * no Pokémon logic at all.
 */
export class ShowdownConnection extends EventEmitter {
  readonly options: Required<Pick<ShowdownConnectionOptions, 'serverUrl' | 'username'>> & ShowdownConnectionOptions;
  private ws: WebSocket | null = null;
  private stateValue: ConnectionState = 'disconnected';
  private readonly log: Logger;
  private readonly loginClient: LoginClient | null;
  private loginDeferred: Deferred<string> | null = null;
  private challstr: string | null = null;
  private closedByUs = false;
  private reconnectAttempts = 0;
  private everLoggedIn = false;
  private readonly sendQueue: Array<{ room: string; text: string }> = [];
  private sendTimer: NodeJS.Timeout | null = null;
  private lastSentAt = 0;
  /** Rooms the server has sent `|init|` for and not yet `|deinit|`. */
  readonly rooms = new Set<string>();
  /** Rooms we want to be in (re-joined after a reconnect). */
  readonly desiredRooms = new Set<string>();
  username: string;
  userId: string;
  avatar = '';

  constructor(options: ShowdownConnectionOptions) {
    super();
    this.options = { ...options };
    this.log = options.logger ?? silentLogger;
    this.username = options.username;
    this.userId = toID(options.username);
    this.loginClient = options.noLoginServer
      ? null
      : new LoginClient({ loginUrl: options.loginUrl ?? 'https://play.pokemonshowdown.com/api/', fetchImpl: options.fetchImpl });
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  private setState(state: ConnectionState) {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.emit('state', state);
  }

  /** Connect and resolve once logged in as the configured username. */
  async connect(): Promise<void> {
    this.closedByUs = false;
    await this.openSocket();
    await this.waitForLogin();
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.setState('connecting');
      this.loginDeferred = new Deferred<string>();
      this.challstr = null;
      const ws = new WebSocket(this.options.serverUrl);
      this.ws = ws;
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.setState('connected');
        this.log.info(`connected to ${this.options.serverUrl}`);
        resolve();
      });
      ws.on('message', (data) => this.onFrame(data.toString()));
      ws.on('error', (err) => {
        this.log.error(`socket error: ${err.message}`);
        this.emit('error', err);
        if (!opened) reject(err);
      });
      ws.on('close', (code, reason) => {
        const why = `close ${code} ${reason.toString()}`;
        this.log.warn(`socket closed: ${why}`);
        this.onClosed(why);
        if (!opened) reject(new Error(why));
      });
    });
  }

  private waitForLogin(): Promise<void> {
    const timeout = this.options.loginTimeoutMs ?? 30_000;
    const deferred = this.loginDeferred!;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Login timed out after ${timeout}ms`)), timeout);
      deferred.promise.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private onFrame(raw: string) {
    this.emit('frame', raw);
    const messages = parseFrame(raw);
    for (const msg of messages) {
      this.handleInternal(msg);
      this.emit('message', msg);
    }
  }

  private handleInternal(msg: RoomMessage) {
    switch (msg.type) {
      case 'challstr':
        this.challstr = msg.rest;
        void this.login(msg.rest);
        break;
      case 'updateuser': {
        const [identity, named] = msg.args;
        const name = cleanIdentity(identity ?? '');
        if (named === '1' && toID(name) === this.userId) {
          this.username = name;
          this.avatar = msg.args[2] ?? '';
          this.setState('loggedin');
          this.log.info(`logged in as ${name}`);
          if (this.loginDeferred && !this.loginDeferred.settled) this.loginDeferred.resolve(name);
          const wasReconnect = this.everLoggedIn;
          this.everLoggedIn = true;
          this.reconnectAttempts = 0;
          this.emit('loggedin', name);
          if (wasReconnect) {
            for (const room of this.desiredRooms) this.send('', `/join ${room}`);
            this.emit('reconnected');
          }
        }
        break;
      }
      case 'nametaken': {
        const [name, reason] = msg.args;
        const err = new Error(`Login as ${name} rejected: ${reason}`);
        this.log.error(err.message);
        if (this.loginDeferred && !this.loginDeferred.settled) this.loginDeferred.reject(err);
        break;
      }
      case 'init':
        if (msg.room) this.rooms.add(msg.room);
        break;
      case 'deinit':
        if (msg.room) this.rooms.delete(msg.room);
        break;
      default:
        break;
    }
  }

  private async login(challstr: string) {
    try {
      if (!this.loginClient) {
        this.sendNow('', `/trn ${this.options.username},0,`);
        return;
      }
      const assertion = await this.loginClient.getAssertion(this.options.username, this.options.password, challstr);
      this.sendNow('', `/trn ${this.options.username},0,${assertion}`);
      if (this.options.avatar) this.sendNow('', `/avatar ${this.options.avatar}`);
    } catch (err) {
      this.log.error(`login failed: ${(err as Error).message}`);
      if (this.loginDeferred && !this.loginDeferred.settled) this.loginDeferred.reject(err);
    }
  }

  private onClosed(reason: string) {
    const wasLoggedIn = this.stateValue === 'loggedin';
    this.ws = null;
    this.rooms.clear();
    this.setState('disconnected');
    if (this.loginDeferred && !this.loginDeferred.settled) {
      this.loginDeferred.reject(new Error(`Disconnected before login: ${reason}`));
    }
    this.emit('disconnected', reason);
    if (this.closedByUs) return;
    const rc = this.options.reconnect;
    if (rc?.enabled && (wasLoggedIn || this.everLoggedIn)) void this.reconnectLoop();
  }

  private async reconnectLoop() {
    const rc = this.options.reconnect!;
    const initial = rc.initialDelayMs ?? 1_000;
    const max = rc.maxDelayMs ?? 30_000;
    const maxAttempts = rc.maxAttempts ?? Infinity;
    while (!this.closedByUs && this.reconnectAttempts < maxAttempts) {
      const delay = Math.min(max, initial * 2 ** this.reconnectAttempts);
      this.reconnectAttempts++;
      this.log.warn(`reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      await sleep(delay);
      if (this.closedByUs) return;
      try {
        await this.openSocket();
        await this.waitForLogin();
        return;
      } catch (err) {
        this.log.error(`reconnect attempt failed: ${(err as Error).message}`);
      }
    }
    if (!this.closedByUs) this.emit('error', new Error('Gave up reconnecting'));
  }

  /** Queue an outgoing `ROOM|TEXT` message. */
  send(room: string, text: string): void {
    this.sendQueue.push({ room, text });
    this.pump();
  }

  /** Send a chat command / message to a specific room. */
  sendRoom(room: string, text: string): void {
    this.send(room, text);
  }

  join(room: string): void {
    this.desiredRooms.add(room);
    if (!this.rooms.has(room)) this.send('', `/join ${room}`);
  }

  leave(room: string): void {
    this.desiredRooms.delete(room);
    if (this.rooms.has(room)) this.send('', `/leave ${room}`);
  }

  /** Bypass the queue (used for login where ordering vs. the queue matters). */
  private sendNow(room: string, text: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log.warn(`dropping message while disconnected: ${room}|${text.slice(0, 60)}`);
      return;
    }
    const frame = `${room}|${text}`;
    this.log.debug(`>> ${frame.length > 300 ? frame.slice(0, 300) + '…' : frame}`);
    this.ws.send(frame);
    this.lastSentAt = Date.now();
    this.emit('sent', room, text);
  }

  private pump() {
    if (this.sendTimer) return;
    const interval = this.options.sendIntervalMs ?? 120;
    const tick = () => {
      this.sendTimer = null;
      if (!this.sendQueue.length) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        // keep queued until reconnected; try again later
        this.sendTimer = setTimeout(tick, 250);
        return;
      }
      const wait = this.lastSentAt + interval - Date.now();
      if (wait > 0) {
        this.sendTimer = setTimeout(tick, wait);
        return;
      }
      const next = this.sendQueue.shift()!;
      this.sendNow(next.room, next.text);
      if (this.sendQueue.length) this.sendTimer = setTimeout(tick, interval);
    };
    tick();
  }

  /** Simulate a dropped socket (used by reconnection tests). */
  simulateDisconnect(): void {
    this.ws?.terminate();
  }

  async disconnect(): Promise<void> {
    this.closedByUs = true;
    if (this.sendTimer) {
      clearTimeout(this.sendTimer);
      this.sendTimer = null;
    }
    const ws = this.ws;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
      setTimeout(() => {
        ws.terminate();
        resolve();
      }, 1_000);
    });
  }

  /** Typed `on` helper. */
  onMessage(handler: (msg: RoomMessage) => void): () => void {
    this.on('message', handler);
    return () => this.off('message', handler);
  }
}
