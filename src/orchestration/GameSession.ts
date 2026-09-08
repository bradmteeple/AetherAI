import { RoomMessage } from '../showdown/protocol';
import { BattleStateEngine } from '../battle/BattleStateEngine';
import { ObservationTracker } from '../battle/ObservationTracker';
import { ChoiceRequest, requestKind } from '../battle/request';
import { generateLegalActions, LegalActions } from '../battle/LegalActionGenerator';
import { encodeDefault, encodeTeamPreview, encodeTurn } from '../battle/ActionEncoder';
import { TeamPreviewDecision, TurnDecision } from '../battle/decisions';
import { AgentDriver } from '../agent/AgentDriver';
import { OpponentBattleKnowledge, OurTeamView, SetScore, StrategicContext, TeamPreviewInput, TurnDecisionInput } from '../agent/BattleAgent';
import { OpenTeamSheetParser, TeamSheet } from '../team/OpenTeamSheetParser';
import { DecisionRecord, GameRecord, SetState, scoreString } from '../set/SetState';
import { buildSetMemory } from '../set/SetMemory';
import { Logger, silentLogger } from '../util/logger';
import { Deferred } from '../util/async';
import { safeFallback } from '../battle/ActionValidator';
import { opponentOf } from '../battle/types';
import { FORMAT_MOD, BEST_OF } from '../format';

export interface GameSessionOptions {
  roomId: string;
  gameNumber: number | null;
  set: SetState;
  driver: AgentDriver;
  otsParser: OpenTeamSheetParser;
  ourTeamView: OurTeamView;
  send: (room: string, text: string) => void;
  onDecision?: (record: DecisionRecord) => void;
  onTeamSheet?: (sheet: TeamSheet) => void;
  logger?: Logger;
  otsWaitMs?: number;
  strategicContext?: StrategicContext;
  timer?: boolean;
  /** Hook for tests to observe every processed request. */
  onRequest?: (req: ChoiceRequest, legal: LegalActions) => void;
}

/**
 * Per-game runtime: owns the BattleStateEngine and ObservationTracker for one
 * sub-battle room and drives decisions for every `|request|`.
 * Game state lives here and is discarded when the game ends; set state is
 * only *read* (score, memory) and written by the orchestrator.
 */
export class GameSession {
  readonly roomId: string;
  gameNumber: number;
  engine: BattleStateEngine;
  tracker: ObservationTracker;
  /** Number of `|init|` frames seen; >1 means the server replayed the room log after a rejoin. */
  initCount = 0;
  readonly decisions: DecisionRecord[] = [];
  readonly startedAt = new Date().toISOString();
  private readonly log: Logger;
  private readonly set: SetState;
  private readonly driver: AgentDriver;
  private readonly otsParser: OpenTeamSheetParser;
  private pendingRequest: ChoiceRequest | null = null;
  private deciding = false;
  private lastSentRqid: number | null = null;
  private lastSentCommand: string | null = null;
  private lastLegal: LegalActions | null = null;
  private serverRejections = 0;
  private otsReady = new Deferred<void>();
  private linkWaiters: Array<() => void> = [];
  ourBringFour: string[] = [];
  ended = false;
  timerRequested = false;

  constructor(private readonly options: GameSessionOptions) {
    this.roomId = options.roomId;
    this.gameNumber = options.gameNumber ?? 0;
    this.log = options.logger ?? silentLogger;
    this.set = options.set;
    this.driver = options.driver;
    this.otsParser = options.otsParser;
    this.engine = this.newEngine();
    this.tracker = new ObservationTracker();
    if (this.set.opponentTeamSheet && this.set.ourTeamSheet) this.otsReady.resolve();
  }

  private newEngine(): BattleStateEngine {
    return new BattleStateEngine({
      roomId: this.roomId,
      gameNumber: this.gameNumber,
      ourUserId: this.set.us.userId,
      ourUsername: this.set.us.name,
    });
  }

  /**
   * On a rejoin the server sends `|init|battle` followed by the *complete*
   * room log (GameRoom.onConnect → getLogForUser). Rebuild game state from
   * that replay instead of applying every line twice. Decisions already made
   * and the last answered rqid are kept; a pending `|request|` is re-sent by
   * the server right after the replay.
   */
  private resetForReplay() {
    this.log.warn(`${this.roomId}: room log replayed after rejoin; rebuilding game state`);
    const sheets = this.engine.state.teamSheets;
    this.engine = this.newEngine();
    this.tracker = new ObservationTracker();
    void sheets;
  }

  setGameNumber(n: number) {
    this.gameNumber = n;
    this.engine.state.gameNumber = n;
    for (const w of this.linkWaiters) w();
    this.linkWaiters = [];
  }

  private waitForLink(timeoutMs: number): Promise<void> {
    if (this.gameNumber) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.linkWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  handle(msg: RoomMessage): void {
    if (msg.type === 'init') {
      this.initCount++;
      if (this.initCount > 1) this.resetForReplay();
    }
    this.engine.apply(msg);
    this.tracker.observe(msg, this.engine.state);
    switch (msg.type) {
      case 'showteam': {
        const sheet = this.otsParser.parseMessage(msg);
        if (sheet) this.onTeamSheet(sheet);
        break;
      }
      case 'request':
        if (this.engine.state.request) {
          this.pendingRequest = this.engine.state.request;
          // Defer so the rest of this frame (e.g. |sentchoice|) is applied first.
          setImmediate(() => void this.processPending());
        }
        break;
      case 'error':
        this.onServerError(msg.rest);
        break;
      case 'win':
      case 'tie':
        this.ended = true;
        break;
      case 'start':
        if (this.options.timer && !this.timerRequested) {
          this.timerRequested = true;
          this.options.send(this.roomId, '/timer on');
        }
        break;
      default:
        break;
    }
  }

  private onTeamSheet(sheet: TeamSheet) {
    const state = this.engine.state;
    sheet.playerName = state.players[sheet.side]?.name;
    const isOurs = state.sides[sheet.side].isUs || (state.players[sheet.side] && state.players[sheet.side]!.name && this.set.us.userId === toIDSafe(state.players[sheet.side]!.name));
    if (isOurs) this.set.ourTeamSheet = sheet;
    else this.set.opponentTeamSheet = sheet;
    this.engine.applyTeamSheet(sheet);
    this.options.onTeamSheet?.(sheet);
    if (this.set.ourTeamSheet && this.set.opponentTeamSheet && !this.otsReady.settled) this.otsReady.resolve();
  }

  private onServerError(text: string) {
    const benign = /too late|nothing to choose|nothing to cancel|game is over/i.test(text);
    if (benign) {
      this.log.debug(`server error in ${this.roomId}: ${text}`);
      return;
    }
    this.log.warn(`server error in ${this.roomId}: ${text}`);
    if (!/^\[Invalid choice\]/.test(text)) return; // [Unavailable choice] is followed by a fresh |request|
    const record = this.decisions[this.decisions.length - 1];
    if (record) record.serverRejection = text;
    this.serverRejections++;
    const state = this.engine.state;
    if (!state.request || !this.lastLegal) return;
    // Our validated choice was rejected by the server: fall back, then to `default`.
    const rqid = state.rqid;
    if (this.serverRejections === 1) {
      const fb = safeFallback(this.lastLegal);
      if (fb) {
        const cmd = this.lastLegal.kind === 'teampreview'
          ? encodeTeamPreview(fb as TeamPreviewDecision, rqid)
          : encodeTurn(fb as TurnDecision, this.lastLegal, rqid);
        if (cmd !== this.lastSentCommand) {
          this.sendChoice(cmd, rqid);
          return;
        }
      }
    }
    this.sendChoice(encodeDefault(rqid), rqid);
  }

  private sendChoice(cmd: string, rqid: number | null) {
    this.lastSentRqid = rqid;
    this.lastSentCommand = cmd;
    this.log.info(`${this.roomId} → ${cmd}`);
    this.options.send(this.roomId, cmd);
  }

  private async processPending(): Promise<void> {
    if (this.deciding) return;
    this.deciding = true;
    try {
      while (this.pendingRequest) {
        const req = this.pendingRequest;
        this.pendingRequest = null;
        await this.decide(req);
      }
    } catch (err) {
      this.log.error(`decision loop failed: ${(err as Error).stack ?? err}`);
    } finally {
      this.deciding = false;
      if (this.pendingRequest) setImmediate(() => void this.processPending());
    }
  }

  private async decide(req: ChoiceRequest): Promise<void> {
    const state = this.engine.state;
    if (this.ended) return;
    const kind = requestKind(req);
    if (kind === 'wait') return;
    const rqid = req.rqid ?? null;
    if (rqid !== null && this.lastSentRqid === rqid && !req.update) return; // already answered (reconnect echo)
    if (state.sentChoice && state.rqid === rqid) {
      this.log.info(`request ${rqid} already answered before reconnect (${state.sentChoice})`);
      return;
    }
    this.serverRejections = 0;
    await this.waitForLink(5_000);
    if (!this.gameNumber) this.log.warn(`deciding in ${this.roomId} before the game number is known`);
    const legal = generateLegalActions(req, state);
    this.lastLegal = legal;
    this.options.onRequest?.(req, legal);
    const started = new Date().toISOString();
    const score = this.score();
    let command: string;
    let finalDecision: unknown;
    let usedFallback = false;
    let attempts: DecisionRecord['attempts'] = [];
    if (legal.kind === 'teampreview') {
      await this.waitForOts();
      const input: TeamPreviewInput = {
        format: this.formatInfo(),
        setId: this.set.setId,
        gameNumber: this.gameNumber,
        setScore: score,
        opponentName: this.set.opponent.name,
        ourTeamSheet: this.options.ourTeamView,
        opponentTeamSheet: this.set.opponentTeamSheet,
        previousGames: buildSetMemory(this.set).previousGames,
        setMemory: buildSetMemory(this.set),
        legalTeamPreviewChoices: legal,
        ...(this.options.strategicContext ? { strategicContext: this.options.strategicContext } : {}),
      };
      const result = await this.driver.decideTeamPreview(input);
      finalDecision = result.decision;
      usedFallback = result.usedFallback;
      attempts = result.attempts;
      command = encodeTeamPreview(result.decision, rqid);
      const bySlot = new Map(legal.pokemon.map((p) => [p.slot, p.species]));
      this.ourBringFour = [result.decision.lead1, result.decision.lead2, result.decision.back1, result.decision.back2].map((s) => bySlot.get(s) ?? `slot${s}`);
    } else {
      const memory = buildSetMemory(this.set);
      const input: TurnDecisionInput = {
        format: this.formatInfo(),
        setId: this.set.setId,
        gameNumber: this.gameNumber,
        setScore: score,
        opponentName: this.set.opponent.name,
        ourTeamSheet: this.options.ourTeamView,
        opponentTeamSheet: this.set.opponentTeamSheet,
        currentBattleState: JSON.parse(JSON.stringify(state, (k, v) => (k === 'log' ? undefined : v))),
        ourBringFour: this.ourBringFour.length ? this.ourBringFour : this.engine.us.pokemon.map((p) => p.species),
        knownOpponentBring: this.tracker.observations.brought[opponentOf(state.ourSide)],
        opponentBattleKnowledge: this.opponentKnowledge(),
        previousGames: memory.previousGames,
        setMemory: memory,
        legalActions: legal as TurnDecisionInput['legalActions'],
        turnHistory: this.tracker.observations.turns,
        ...(this.options.strategicContext ? { strategicContext: this.options.strategicContext } : {}),
      };
      const result = await this.driver.decideTurn(input);
      finalDecision = result.decision;
      usedFallback = result.usedFallback;
      attempts = result.attempts;
      command = encodeTurn(result.decision, legal, rqid);
    }
    // A newer request may have superseded this one while the agent was thinking.
    if (state.rqid !== rqid && rqid !== null) {
      this.log.warn(`request ${rqid} superseded by ${state.rqid}; discarding decision`);
      return;
    }
    if (this.ended) return;
    const record: DecisionRecord = {
      setId: this.set.setId,
      gameNumber: this.gameNumber,
      roomId: this.roomId,
      turn: state.turn,
      rqid,
      kind: legal.kind,
      legalActions: legal,
      attempts,
      finalDecision,
      usedFallback,
      command,
      timestamp: started,
    };
    this.decisions.push(record);
    this.options.onDecision?.(record);
    this.sendChoice(command, rqid);
  }

  private async waitForOts(): Promise<void> {
    if (this.otsReady.settled) return;
    const timeout = this.options.otsWaitMs ?? 4_000;
    await Promise.race([this.otsReady.promise, new Promise<void>((r) => setTimeout(r, timeout))]);
    if (!this.set.opponentTeamSheet) this.log.warn('team preview without an opponent team sheet (not received in time)');
  }

  private formatInfo() {
    return { id: this.set.formatId, name: this.set.formatName, mod: FORMAT_MOD, gameType: 'doubles', bestOf: BEST_OF };
  }

  score(): SetScore {
    return { ourWins: this.set.ourWins, opponentWins: this.set.opponentWins, ties: this.set.ties, display: scoreString(this.set) };
  }

  private opponentKnowledge(): OpponentBattleKnowledge {
    const opp = this.engine.opponent;
    return {
      revealedThisGame: this.tracker.observations.brought[opp.id],
      pokemon: opp.pokemon.map((p) => ({
        species: p.species,
        ident: p.ident,
        hpPercent: p.hpPercent,
        status: p.status,
        fainted: p.fainted,
        active: p.active,
        revealedMoves: p.revealedMoves,
        itemKnown: p.item,
        itemSource: p.itemKnownFrom === 'request' ? null : p.itemKnownFrom,
        abilityKnown: p.ability,
        abilitySource: p.abilityKnownFrom === 'request' ? null : p.abilityKnownFrom,
        megaEvolved: p.megaEvolved,
        boosts: p.boosts,
        volatiles: p.volatiles,
      })),
    };
  }

  toRecord(result: GameRecord['result'], winnerName: string | null): GameRecord {
    const state = this.engine.state;
    const opp = opponentOf(state.ourSide);
    const o = this.tracker.observations;
    return {
      gameNumber: this.gameNumber,
      roomId: this.roomId,
      ourSide: state.ourSide,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      result,
      winnerName,
      turns: state.turn,
      ourBringFour: this.ourBringFour.length ? this.ourBringFour : o.brought[state.ourSide],
      opponentBringFour: o.brought[opp],
      ourLead: o.leads[state.ourSide],
      opponentLead: o.leads[opp],
      observations: o,
      opponentSummary: this.tracker.summarizeOpponent(state),
      decisions: this.decisions,
      battleEvents: state.log,
      finalState: state,
    };
  }
}

function toIDSafe(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
