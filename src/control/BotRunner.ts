import { EventEmitter } from 'node:events';
import { BattleAgent } from '../agent/BattleAgent';
import { HttpBattleAgent } from '../agent/HttpBattleAgent';
import { MockBattleAgent } from '../agent/MockBattleAgent';
import { SetOrchestrator, StartMode } from '../orchestration/SetOrchestrator';
import { ConnectionState, ShowdownConnection } from '../showdown/ShowdownConnection';
import { GameResult, SetState, scoreString } from '../set/SetState';
import { loadTeamFile } from '../team/TeamLoader';
import { PokemonSet } from '../team/types';
import { Deferred } from '../util/async';
import { createLogger, Logger } from '../util/logger';
import { BotSettings, ControlStore, StoredAccount } from './store';

/** `off` and `error` are the two states in which `start()` is allowed. */
export type BotStatus = 'off' | 'starting' | 'online' | 'stopping' | 'error';

export interface LogLine {
  seq: number;
  line: string;
}

export interface SetSummary {
  setId: string;
  opponent: string;
  score: string;
  result: GameResult | null;
  endedAt: string | null;
}

export interface StatusReport {
  status: BotStatus;
  since: string;
  connection: ConnectionState;
  account: { id: string; username: string } | null;
  loggedInAs: string | null;
  settings: BotSettings;
  currentSet: { setId: string; phase: SetState['phase']; opponent: string; score: string; game: number } | null;
  totals: { sets: number; wins: number; losses: number; ties: number };
  lastSet: SetSummary | null;
  lastError: string | null;
}

export class BotRunnerError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'BotRunnerError';
  }
}

const MAX_LOG_LINES = 500;
const STOP_GRACE_MS = 5_000;

/**
 * Owns the on/off lifecycle of the connector for the control panel: one
 * connection, and a loop that plays sets with the selected account until it is
 * switched off.
 */
export class BotRunner extends EventEmitter {
  private statusValue: BotStatus = 'off';
  private since = new Date().toISOString();
  private conn: ShowdownConnection | null = null;
  private orchestrator: SetOrchestrator | null = null;
  private account: StoredAccount | null = null;
  private settings: BotSettings;
  private loop: Promise<void> | null = null;
  private stopSignal = new Deferred<null>();
  private stopping = false;
  private lastError: string | null = null;
  private lastSet: SetSummary | null = null;
  private totals = { sets: 0, wins: 0, losses: 0, ties: 0 };
  private buffer: LogLine[] = [];
  private seq = 0;

  constructor(private readonly store: ControlStore, private readonly options: { runsDir?: string | null; echoLogs?: boolean } = {}) {
    super();
    this.settings = store.settings;
  }

  get status(): BotStatus {
    return this.statusValue;
  }

  private setStatus(status: BotStatus) {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.since = new Date().toISOString();
    this.emit('status', status);
  }

  private push(line: string) {
    this.seq += 1;
    this.buffer.push({ seq: this.seq, line });
    if (this.buffer.length > MAX_LOG_LINES) this.buffer.splice(0, this.buffer.length - MAX_LOG_LINES);
    if (this.options.echoLogs !== false) process.stderr.write(line + '\n');
  }

  /** Log lines newer than `afterSeq` (0 for everything currently buffered). */
  logs(afterSeq = 0): { lines: LogLine[]; latest: number } {
    return { lines: this.buffer.filter((l) => l.seq > afterSeq), latest: this.seq };
  }

  private makeLogger(): Logger {
    return createLogger({ level: this.settings.logLevel, sink: (line) => this.push(line) });
  }

  private makeAgent(): BattleAgent {
    if (this.settings.agent === 'http') {
      if (!this.settings.agentUrl) throw new BotRunnerError('The HTTP agent needs an agent URL');
      return new HttpBattleAgent({ baseUrl: this.settings.agentUrl });
    }
    return new MockBattleAgent();
  }

  private startMode(): StartMode {
    return this.settings.mode === 'challenge'
      ? { mode: 'challenge', opponent: this.settings.opponent }
      : { mode: 'accept', from: this.settings.opponent || undefined };
  }

  report(): StatusReport {
    const set = this.orchestrator?.set ?? null;
    return {
      status: this.statusValue,
      since: this.since,
      connection: this.conn?.state ?? 'disconnected',
      account: this.account ? { id: this.account.id, username: this.account.username } : null,
      loggedInAs: this.conn?.state === 'loggedin' ? this.conn.username : null,
      settings: this.store.settings,
      currentSet: set && !set.setFinished
        ? { setId: set.setId, phase: set.phase, opponent: set.opponent.name, score: scoreString(set), game: set.currentGame }
        : null,
      totals: { ...this.totals },
      lastSet: this.lastSet,
      lastError: this.lastError,
    };
  }

  /**
   * Turn the bot on: connect and log in as the active account, then start
   * playing. Rejects (and leaves the bot off) if the account, team or login is
   * not usable, so the control panel can show why.
   */
  async start(): Promise<StatusReport> {
    if (this.statusValue === 'starting' || this.statusValue === 'online') throw new BotRunnerError('The bot is already on', 409);
    if (this.statusValue === 'stopping') throw new BotRunnerError('The bot is still shutting down; try again in a moment', 409);

    const account = this.store.activeAccount();
    if (!account) throw new BotRunnerError('No account selected — add one first');
    this.settings = this.store.settings;
    if (this.settings.mode === 'challenge' && !this.settings.opponent) {
      throw new BotRunnerError('Challenge mode needs an opponent username');
    }

    let team: PokemonSet[];
    try {
      team = loadTeamFile(this.settings.teamFile);
    } catch (err) {
      throw new BotRunnerError(`Could not read team file "${this.settings.teamFile}": ${(err as Error).message}`);
    }

    this.account = account;
    this.lastError = null;
    this.stopping = false;
    this.stopSignal = new Deferred<null>();
    this.setStatus('starting');
    const log = this.makeLogger();
    const isLocal = /localhost|127\.0\.0\.1/.test(this.settings.serverUrl);
    const conn = new ShowdownConnection({
      serverUrl: this.settings.serverUrl,
      loginUrl: this.settings.loginUrl,
      username: account.username,
      password: account.password,
      noLoginServer: isLocal,
      logger: log.child('ws'),
      reconnect: { enabled: true },
    });
    this.conn = conn;
    conn.on('error', (err) => log.error(`connection error: ${err.message}`));

    log.info(`turning on as ${account.username} (${this.settings.mode} mode, ${this.settings.agent} agent)`);
    try {
      await conn.connect();
    } catch (err) {
      this.conn = null;
      this.account = null;
      this.lastError = (err as Error).message;
      this.setStatus('error');
      log.error(`login failed: ${this.lastError}`);
      throw new BotRunnerError(`Could not log in as ${account.username}: ${this.lastError}`, 502);
    }
    this.store.markAccountUsed(account.id);
    this.setStatus('online');
    this.loop = this.runLoop(conn, team, log).catch((err) => {
      this.lastError = (err as Error).message;
      log.error(`bot loop crashed: ${this.lastError}`);
      this.setStatus('error');
    });
    return this.report();
  }

  private async runLoop(conn: ShowdownConnection, team: PokemonSet[], log: Logger): Promise<void> {
    try {
      while (!this.stopping) {
        const orchestrator = new SetOrchestrator({
          connection: conn,
          agent: this.makeAgent(),
          team,
          formatId: this.settings.formatId,
          runsDir: this.options.runsDir === undefined ? 'runs' : this.options.runsDir,
          logger: log.child('set'),
          timer: this.settings.timer,
        });
        this.orchestrator = orchestrator;
        orchestrator.on('gameEnded', (record, set) => log.info(`game ${record.gameNumber}: ${record.result} — score ${scoreString(set)}`));
        let set: SetState | null;
        try {
          set = await Promise.race([orchestrator.runSet(this.startMode()), this.stopSignal.promise]);
        } catch (err) {
          orchestrator.dispose();
          this.orchestrator = null;
          if (this.stopping) return;
          throw err;
        }
        orchestrator.dispose();
        if (!set) {
          this.orchestrator = null;
          return; // switched off mid-set
        }
        this.recordSet(set);
        this.orchestrator = null;
        if (!this.settings.continuous) {
          log.info('set finished and continuous play is off — turning the bot off');
          void this.stop();
          return;
        }
      }
    } finally {
      this.loop = null;
    }
  }

  private recordSet(set: SetState) {
    const result: GameResult | null = set.setWinner === 'us' ? 'win' : set.setWinner === 'opponent' ? 'loss' : set.setWinner === 'tie' ? 'tie' : null;
    this.totals.sets += 1;
    if (result === 'win') this.totals.wins += 1;
    else if (result === 'loss') this.totals.losses += 1;
    else if (result === 'tie') this.totals.ties += 1;
    this.lastSet = { setId: set.setId, opponent: set.opponent.name, score: scoreString(set), result, endedAt: set.endedAt };
    this.emit('setEnded', this.lastSet);
  }

  /** Turn the bot off: abandon any set in progress and drop the connection. */
  async stop(): Promise<StatusReport> {
    if (this.statusValue === 'off') return this.report();
    this.stopping = true;
    this.setStatus('stopping');
    if (!this.stopSignal.settled) this.stopSignal.resolve(null);
    this.orchestrator?.dispose();
    this.orchestrator = null;
    const conn = this.conn;
    this.conn = null;
    try {
      await conn?.disconnect();
    } catch (err) {
      this.push(`warning: disconnect failed: ${(err as Error).message}`);
    }
    const loop = this.loop;
    if (loop) {
      await Promise.race([loop, new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS).unref?.())]);
    }
    this.account = null;
    this.stopping = false;
    this.setStatus('off');
    this.push('bot is off');
    return this.report();
  }
}
