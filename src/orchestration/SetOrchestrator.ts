import { EventEmitter } from 'node:events';
import { ShowdownConnection } from '../showdown/ShowdownConnection';
import { ProtocolRouter } from '../showdown/ProtocolRouter';
import { ChallengeManager } from '../showdown/ChallengeManager';
import { RoomMessage } from '../showdown/protocol';
import { isBattleRoom, isBestOfRoom, parseBattleRoomId } from '../showdown/rooms';
import { BestOfSetManager, SetManagerEvent } from '../set/BestOfSetManager';
import { GameRecord, SetState, scoreString } from '../set/SetState';
import { buildSetMemory } from '../set/SetMemory';
import { BattleAgent, OurTeamView, StrategicContext } from '../agent/BattleAgent';
import { AgentDriver } from '../agent/AgentDriver';
import { PokemonSet } from '../team/types';
import { packTeam } from '../team/PackedTeam';
import { exportSet } from '../team/TeamLoader';
import { OpenTeamSheetParser, TeamSheet } from '../team/OpenTeamSheetParser';
import { defaultNameResolver } from '../team/dex';
import { validateWithServer, ValidationResult, staticChecks } from '../team/TeamValidator';
import { SetRecorder } from '../recording/SetRecorder';
import { GameSession } from './GameSession';
import { Logger, silentLogger } from '../util/logger';
import { toID } from '../util/id';
import { Deferred, sleep } from '../util/async';
import { FORMAT_ID, FORMAT_NAME } from '../format';

export interface SetOrchestratorOptions {
  connection: ShowdownConnection;
  agent: BattleAgent;
  team: PokemonSet[];
  formatId?: string;
  formatName?: string;
  /** Directory for run records; null disables recording. */
  runsDir?: string | null;
  logger?: Logger;
  timer?: boolean;
  readyDelayMs?: number;
  agentTimeoutMs?: number;
  otsWaitMs?: number;
  strategicContext?: StrategicContext;
  /** Skip the server-side `/vtm` validation (tests with known-good teams). */
  skipValidation?: boolean;
}

export type StartMode = { mode: 'challenge'; opponent: string; timeoutMs?: number } | { mode: 'accept'; from?: string; timeoutMs?: number };

export interface OrchestratorEvents {
  setCreated: (set: SetState) => void;
  gameStarted: (gameNumber: number, roomId: string) => void;
  gameEnded: (record: GameRecord, set: SetState) => void;
  readyConfirmed: (gameNumber: number) => void;
  setEnded: (set: SetState) => void;
  teamSheet: (sheet: TeamSheet) => void;
  phase: (phase: SetState['phase']) => void;
}

/**
 * Top-level runner for exactly one best-of-three set.
 */
export class SetOrchestrator extends EventEmitter {
  readonly conn: ShowdownConnection;
  readonly router: ProtocolRouter;
  readonly challenges: ChallengeManager;
  readonly agent: BattleAgent;
  readonly driver: AgentDriver;
  readonly formatId: string;
  readonly formatName: string;
  readonly log: Logger;
  readonly sessions = new Map<string, GameSession>();
  manager: BestOfSetManager | null = null;
  set: SetState | null = null;
  recorder: SetRecorder | null = null;
  private readonly otsParser = new OpenTeamSheetParser(defaultNameResolver());
  private readonly ourTeamView: OurTeamView;
  private finished = new Deferred<SetState>();
  private unsubscribe: (() => void) | null = null;
  private readonly readySent = new Set<number>();

  constructor(private readonly options: SetOrchestratorOptions) {
    super();
    this.conn = options.connection;
    this.router = new ProtocolRouter(this.conn);
    this.log = options.logger ?? silentLogger;
    this.challenges = new ChallengeManager(this.conn, { logger: this.log.child('challenge'), autoRejectOtherFormats: true });
    this.agent = options.agent;
    this.driver = new AgentDriver(options.agent, { logger: this.log.child('agent'), agentTimeoutMs: options.agentTimeoutMs ?? 20_000 });
    this.formatId = options.formatId ?? FORMAT_ID;
    this.formatName = options.formatName ?? FORMAT_NAME;
    this.ourTeamView = {
      pokemon: options.team.map((s, i) => ({
        slot: i + 1,
        species: s.species,
        item: s.item,
        ability: s.ability,
        moves: s.moves,
        nature: s.nature,
        statPoints: s.evs,
        level: s.level,
        gender: s.gender,
      })),
      exportText: options.team.map((s) => exportSet(s)).join('\n'),
    };
  }

  /** Validate our team: static checks, then the server's own validator. */
  async validateTeam(): Promise<ValidationResult> {
    const stat = staticChecks(this.options.team);
    if (!stat.ok) return stat;
    if (this.options.skipValidation) return stat;
    const result = await validateWithServer(this.conn, this.options.team, this.formatId);
    if (stat.problems.length) result.problems.unshift(...stat.problems);
    return result;
  }

  /**
   * Run one complete set. Resolves when Showdown declares the set over.
   */
  async runSet(start: StartMode): Promise<SetState> {
    if (this.conn.state !== 'loggedin') throw new Error('Connection must be logged in before running a set');
    const validation = await this.validateTeam();
    if (!validation.ok) throw new Error(`Team is not legal for ${this.formatName}:\n- ${validation.problems.join('\n- ')}`);
    this.log.info(`team validated (${validation.source})`);

    const packed = packTeam(this.options.team);
    const opponentName = start.mode === 'challenge' ? start.opponent : start.from ?? '';
    this.set = this.newSetState(opponentName);
    this.manager = new BestOfSetManager({ ourUserId: this.conn.userId, formatId: this.formatId, logger: this.log.child('bestof') });
    if (this.options.runsDir !== null) {
      this.recorder = new SetRecorder(this.options.runsDir ?? 'runs');
      this.set.setId = this.recorder.setId;
    }
    this.unsubscribe = this.router.onKind('message', (msg) => this.onMessage(msg));
    this.conn.on('reconnected', this.onReconnected);

    const parentRoom = start.mode === 'challenge'
      ? await this.challenges.challenge(start.opponent, this.formatId, packed, start.timeoutMs)
      : await this.challenges.acceptNext(this.formatId, packed, start.from, start.timeoutMs);
    this.log.info(`set room: ${parentRoom}`);
    return this.finished.promise;
  }

  private readonly onReconnected = () => {
    this.log.warn('reconnected; rejoining set rooms');
    // desiredRooms are re-joined by the connection itself; the server re-sends
    // pending |request| and the ready button on join.
  };

  private newSetState(opponentName: string): SetState {
    return {
      setId: `set_${Date.now()}`,
      formatId: this.formatId,
      formatName: this.formatName,
      parentRoomId: null,
      us: { name: this.conn.username, userId: this.conn.userId },
      opponent: { name: opponentName, userId: toID(opponentName) },
      startedAt: new Date().toISOString(),
      endedAt: null,
      ourTeam: this.options.team,
      ourTeamSheet: null,
      opponentTeamSheet: null,
      ourWins: 0,
      opponentWins: 0,
      ties: 0,
      currentGame: 0,
      games: [],
      phase: 'WAITING',
      setFinished: false,
      setWinner: null,
      setWinnerName: null,
      opponentSetObservations: {
        seenBrought: [], leadsByGame: {}, bringByGame: {}, protectCountBySpecies: {}, switchCountBySpecies: {}, megaEvolvedSpecies: [], revealedMovesBySpecies: {}, revealedItemsBySpecies: {},
      },
      ourSetObservations: { leadsByGame: {}, bringByGame: {}, resultsByGame: {} },
    };
  }

  private onMessage(msg: RoomMessage) {
    if (!this.manager || !this.set) return;
    const relevant = isBestOfRoom(msg.room) || isBattleRoom(msg.room);
    if (!relevant) return;
    if (isBattleRoom(msg.room)) {
      const info = parseBattleRoomId(msg.room);
      if (info && info.formatId !== this.formatId) return; // some other battle we happen to be in
    }
    this.recorder?.appendProtocol(msg.room, msg.raw);
    const events = this.manager.handleMessage(msg);
    for (const ev of events) this.onSetEvent(ev);
    if (isBattleRoom(msg.room)) {
      let session = this.sessions.get(msg.room);
      if (!session && msg.type === 'init' && !this.manager.setEnded) {
        session = this.createSession(msg.room, this.manager.gameRooms.get(msg.room) ?? null);
      }
      session?.handle(msg);
    }
  }

  private createSession(roomId: string, gameNumber: number | null): GameSession {
    const set = this.set!;
    const session = new GameSession({
      roomId,
      gameNumber,
      set,
      driver: this.driver,
      otsParser: this.otsParser,
      ourTeamView: this.ourTeamView,
      send: (room, text) => this.conn.send(room, text),
      onDecision: (record) => this.recorder?.appendDecision(record),
      onTeamSheet: (sheet) => {
        this.recorder?.writeOts(set);
        if (!set.opponent.name && sheet.playerName && toID(sheet.playerName) !== set.us.userId) {
          set.opponent = { name: sheet.playerName, userId: toID(sheet.playerName) };
        }
        this.emit('teamSheet', sheet);
      },
      logger: this.log.child(roomId.replace(/^battle-[a-z0-9]+-/, 'battle#')),
      otsWaitMs: this.options.otsWaitMs,
      strategicContext: this.options.strategicContext,
      timer: this.options.timer ?? true,
    });
    this.sessions.set(roomId, session);
    this.conn.desiredRooms.add(roomId);
    return session;
  }

  private onSetEvent(ev: SetManagerEvent) {
    const set = this.set!;
    const manager = this.manager!;
    switch (ev.type) {
      case 'phase':
        set.phase = ev.phase;
        this.emit('phase', ev.phase);
        this.recorder?.writeSet(set);
        break;
      case 'setCreated':
        set.parentRoomId = ev.parentRoomId;
        this.conn.desiredRooms.add(ev.parentRoomId);
        this.log.info(`best-of-${ev.bestOf} set created in ${ev.parentRoomId}`);
        this.emit('setCreated', set);
        break;
      case 'players': {
        const opp = ev.names.find((n) => toID(n) !== this.conn.userId);
        if (opp && !set.opponent.name) set.opponent = { name: opp, userId: toID(opp) };
        break;
      }
      case 'gameRoomLinked': {
        set.currentGame = Math.max(set.currentGame, ev.gameNumber);
        let session = this.sessions.get(ev.roomId);
        if (!session) session = this.createSession(ev.roomId, ev.gameNumber);
        else session.setGameNumber(ev.gameNumber);
        this.log.info(`game ${ev.gameNumber} started in ${ev.roomId} (score ${scoreString(set)})`);
        this.emit('gameStarted', ev.gameNumber, ev.roomId);
        break;
      }
      case 'gameEnded': {
        const session = this.sessions.get(ev.roomId);
        set.ourWins = manager.ourWins;
        set.opponentWins = manager.opponentWins;
        set.ties = manager.ties;
        if (session) {
          const record = session.toRecord(ev.ourResult, ev.winnerName);
          set.games.push(record);
          this.updateSetObservations(record);
          this.recorder?.writeGame(record);
          this.log.info(`game ${ev.gameNumber} ended: ${ev.ourResult} (score ${scoreString(set)})`);
          this.emit('gameEnded', record, set);
          void Promise.resolve(this.agent.onGameEnd?.(record, session.score(), buildSetMemory(set))).catch((err) => this.log.warn(`agent.onGameEnd failed: ${err}`));
        }
        this.recorder?.writeSet(set);
        break;
      }
      case 'readyPrompt': {
        if (this.readySent.has(ev.nextGameNumber)) break;
        this.readySent.add(ev.nextGameNumber);
        const delay = this.options.readyDelayMs ?? 1_500;
        this.log.info(`server is waiting for readiness for game ${ev.nextGameNumber}; confirming in ${delay}ms`);
        void sleep(delay).then(() => {
          if (manager.setEnded) return;
          this.conn.send(ev.parentRoomId, '/confirmready');
          this.emit('readyConfirmed', ev.nextGameNumber);
        });
        break;
      }
      case 'playerReady':
        this.log.info(`${ev.name} is ready for game ${ev.gameNumber}`);
        break;
      case 'setEnded':
        this.finishSet(ev.ourResult, ev.winnerName);
        break;
    }
  }

  private updateSetObservations(record: GameRecord) {
    const set = this.set!;
    const o = set.opponentSetObservations;
    o.leadsByGame[record.gameNumber] = record.opponentLead;
    o.bringByGame[record.gameNumber] = record.opponentBringFour;
    for (const s of record.opponentBringFour) if (!o.seenBrought.includes(s)) o.seenBrought.push(s);
    const opp = record.ourSide === 'p1' ? 'p2' : 'p1';
    for (const p of record.observations.protects.filter((x) => x.side === opp)) o.protectCountBySpecies[p.species] = (o.protectCountBySpecies[p.species] ?? 0) + 1;
    for (const s of record.observations.switches.filter((x) => x.side === opp)) o.switchCountBySpecies[s.outSpecies] = (o.switchCountBySpecies[s.outSpecies] ?? 0) + 1;
    for (const m of record.observations.megaEvolutions.filter((x) => x.side === opp)) if (!o.megaEvolvedSpecies.includes(m.species)) o.megaEvolvedSpecies.push(m.species);
    if (record.finalState) {
      for (const p of record.finalState.sides[opp].pokemon) {
        if (p.revealedMoves.length) o.revealedMovesBySpecies[p.species] = [...new Set([...(o.revealedMovesBySpecies[p.species] ?? []), ...p.revealedMoves])];
        if (p.item && p.itemKnownFrom === 'reveal') o.revealedItemsBySpecies[p.species] = p.item;
      }
    }
    set.ourSetObservations.leadsByGame[record.gameNumber] = record.ourLead;
    set.ourSetObservations.bringByGame[record.gameNumber] = record.ourBringFour;
    if (record.result) set.ourSetObservations.resultsByGame[record.gameNumber] = record.result;
  }

  private finishSet(ourResult: 'win' | 'loss' | 'tie', winnerName: string | null) {
    const set = this.set!;
    if (set.setFinished) return;
    set.setFinished = true;
    set.setWinner = ourResult === 'win' ? 'us' : ourResult === 'loss' ? 'opponent' : 'tie';
    set.setWinnerName = winnerName;
    set.endedAt = new Date().toISOString();
    set.phase = 'SET_COMPLETE';
    this.recorder?.writeSet(set);
    this.log.info(`set finished: ${ourResult} ${scoreString(set)} (winner: ${winnerName ?? 'tie'})`);
    void Promise.resolve(this.agent.onSetEnd?.({ ourWins: set.ourWins, opponentWins: set.opponentWins, ties: set.ties, display: scoreString(set) }, ourResult)).catch(() => undefined);
    this.emit('setEnded', set);
    this.unsubscribe?.();
    this.conn.off('reconnected', this.onReconnected);
    this.finished.resolve(set);
  }

  /** Stop listening (does not disconnect). */
  dispose(): void {
    this.unsubscribe?.();
    this.conn.off('reconnected', this.onReconnected);
  }
}
