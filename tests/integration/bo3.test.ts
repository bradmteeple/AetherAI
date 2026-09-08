import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connectBot, findShowdownDir, LocalShowdown, startLocalShowdown } from '../helpers/localShowdown';
import { SetOrchestrator } from '../../src/orchestration/SetOrchestrator';
import { MockBattleAgent } from '../../src/agent/MockBattleAgent';
import { HttpBattleAgent } from '../../src/agent/HttpBattleAgent';
import { loadTeamFile } from '../../src/team/TeamLoader';
import { validateWithServer } from '../../src/team/TeamValidator';
import { ShowdownConnection } from '../../src/showdown/ShowdownConnection';
import { createLogger } from '../../src/util/logger';
import { FORMAT_ID, FORMAT_NAME } from '../../src/format';
import { SetState } from '../../src/set/SetState';
import { startAgentServer } from '../../examples/agent-server';
import { BattleAgent, TeamPreviewInput, TurnDecisionInput } from '../../src/agent/BattleAgent';
import { PokemonSet } from '../../src/team/types';

const HAS_SHOWDOWN = !!findShowdownDir();
const describeIf = HAS_SHOWDOWN || process.env.REQUIRE_LOCAL_SHOWDOWN ? describe : describe.skip;

const TEAM = loadTeamFile('teams/regmb-team.txt');
const log = createLogger({ level: (process.env.LOG_LEVEL as 'info') || 'warn', prefix: 'test' });
let counter = 0;

interface Bot {
  name: string;
  conn: ShowdownConnection;
  agent: BattleAgent;
  orchestrator: SetOrchestrator;
}

async function makeBot(server: LocalShowdown, name: string, agent: BattleAgent, runsDir: string | null, team: PokemonSet[] = TEAM, extra: Partial<ConstructorParameters<typeof SetOrchestrator>[0]> = {}): Promise<Bot> {
  const conn = await connectBot(server.url, name, log.child(name));
  const orchestrator = new SetOrchestrator({
    connection: conn,
    agent,
    team,
    runsDir,
    logger: log.child(`${name}:set`),
    timer: false,
    readyDelayMs: 200,
    agentTimeoutMs: 10_000,
    ...extra,
  });
  return { name, conn, agent, orchestrator };
}

async function playSet(server: LocalShowdown, a: Bot, b: Bot): Promise<[SetState, SetState]> {
  const accept = b.orchestrator.runSet({ mode: 'accept', from: a.name, timeoutMs: 60_000 });
  const challenge = a.orchestrator.runSet({ mode: 'challenge', opponent: b.name, timeoutMs: 60_000 });
  return Promise.all([challenge, accept]);
}

describeIf('local Showdown: Regulation M-B Bo3 end-to-end', () => {
  let server: LocalShowdown;
  const bots: Bot[] = [];

  beforeAll(async () => {
    server = await startLocalShowdown();
  }, 180_000);

  afterAll(async () => {
    for (const b of bots) await b.conn.disconnect().catch(() => undefined);
    await server?.stop();
  });

  const uniq = (base: string) => `${base}${Date.now().toString(36).slice(-4)}${counter++}`;

  it('1. connects, authenticates, and the server validates the Reg M-B team', async () => {
    const conn = await connectBot(server.url, uniq('aethervalid'));
    expect(conn.state).toBe('loggedin');
    const res = await validateWithServer(conn, TEAM, FORMAT_ID);
    expect(res.source).toBe('server');
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
    const bad = JSON.parse(JSON.stringify(TEAM)) as PokemonSet[];
    bad[0].item = 'Safety Goggles';
    const badRes = await validateWithServer(conn, bad, FORMAT_ID);
    expect(badRes.ok).toBe(false);
    expect(badRes.problems.join(' ')).toMatch(/Safety Goggles/);
    await conn.disconnect();
  }, 60_000);

  it('2-13. plays a complete 2-0 set with forced OTS, adaptive team preview and automatic /confirmready', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'aether-runs-'));
    const winnerAgent = new MockBattleAgent({ seed: 1 });
    const loserAgent = new MockBattleAgent({ seed: 2, forfeitGames: [1, 2] });
    const a = await makeBot(server, uniq('aetherbot'), winnerAgent, runsDir);
    const b = await makeBot(server, uniq('rivalbot'), loserAgent, null);
    bots.push(a, b);

    const phases: string[] = [];
    const readyConfirmed: number[] = [];
    const gamesStarted: [number, string][] = [];
    a.orchestrator.on('phase', (p) => phases.push(p));
    a.orchestrator.on('readyConfirmed', (n) => readyConfirmed.push(n));
    a.orchestrator.on('gameStarted', (n, room) => gamesStarted.push([n, room]));
    const [setA, setB] = await playSet(server, a, b);

    // parent room + game rooms
    expect(setA.parentRoomId).toMatch(/^game-bestof3-gen9championsvgc2026regmbbo3-\d+$/);
    expect(gamesStarted.map(([n]) => n)).toEqual([1, 2]);
    expect(gamesStarted.every(([, room]) => room.startsWith(`battle-${FORMAT_ID}-`))).toBe(true);
    expect(setA.formatName).toBe(FORMAT_NAME);
    expect(setA.opponent.userId).toBe(b.conn.userId);

    // OTS parsed before team preview
    expect(setA.opponentTeamSheet?.pokemon.map((p) => p.speciesId)).toEqual(['incineroar', 'whimsicott', 'garchomp', 'rotomwash', 'kingambit', 'gholdengo']);
    const sheetMon = setA.opponentTeamSheet!.pokemon[0];
    expect(sheetMon.itemId.toLowerCase()).toBe('sitrusberry');
    expect(sheetMon.abilityId.toLowerCase()).toBe('intimidate');
    expect(sheetMon.moveIds.map((m) => m.toLowerCase())).toEqual(['fakeout', 'flareblitz', 'darkestlariat', 'partingshot']);
    expect(sheetMon.nature).toBe('Careful');
    expect(JSON.stringify(setA.opponentTeamSheet)).not.toMatch(/"evs"|"ivs"/);
    expect(setA.ourTeamSheet?.pokemon).toHaveLength(6);

    // score / result
    expect(setA.setFinished).toBe(true);
    expect(setA.setWinner).toBe('us');
    expect(setA.ourWins).toBe(2);
    expect(setA.opponentWins).toBe(0);
    expect(setA.games.map((g) => g.result)).toEqual(['win', 'win']);
    expect(setB.setWinner).toBe('opponent');
    expect(setB.games.map((g) => g.result)).toEqual(['loss', 'loss']);
    expect(readyConfirmed).toEqual([2]);
    expect(phases).toContain('BETWEEN_GAMES');
    expect(phases).toContain('READY_CONFIRMED');
    expect(phases[phases.length - 1]).toBe('SET_COMPLETE');
    // team preview was re-evaluated for every game and produced different bring-fours
    expect(winnerAgent.calls.teamPreview).toBe(2);
    expect(setA.games[0].ourBringFour).toHaveLength(4);
    expect(setA.games[1].ourBringFour).toHaveLength(4);
    expect(setA.games[0].ourBringFour).not.toEqual(setA.games[1].ourBringFour);
    // set memory carried into game 2: decisions of game 2 saw one previous game
    const g2Preview = setA.games[1].decisions.find((d) => d.kind === 'teampreview')!;
    expect(String((g2Preview.finalDecision as { reasoning: string }).reasoning)).toMatch(/1 previous game/);
    // records on disk
    const dir = a.orchestrator.recorder!.dir;
    expect(readdirSync(dir).sort()).toEqual(['decisions.jsonl', 'game1.json', 'game2.json', 'ots.json', 'protocol.log', 'set.json']);
    const setJson = JSON.parse(readFileSync(join(dir, 'set.json'), 'utf8'));
    expect(setJson.setWinner).toBe('us');
    expect(setJson.ourWins).toBe(2);
    expect(setJson.games).toHaveLength(2);
    const decisions = readFileSync(join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(decisions.filter((d) => d.kind === 'teampreview')).toHaveLength(2);
    expect(decisions.every((d) => d.command)).toBe(true);
    expect(existsSync(join(dir, 'game3.json'))).toBe(false);
  }, 240_000);

  it('14-16. reaches 1-1, advances to game 3 automatically and detects the final 2-1 score', async () => {
    // Bot A forfeits game 2, bot B forfeits games 1 and 3 → A wins 2-1.
    const agentA = new MockBattleAgent({ seed: 3, forfeitGames: [2] });
    const agentB = new MockBattleAgent({ seed: 4, forfeitGames: [1, 3] });
    const a = await makeBot(server, uniq('aetherbot'), agentA, null);
    const b = await makeBot(server, uniq('rivalbot'), agentB, null);
    bots.push(a, b);
    const readyConfirmed: number[] = [];
    a.orchestrator.on('readyConfirmed', (n) => readyConfirmed.push(n));
    const [setA, setB] = await playSet(server, a, b);
    expect(setA.games.map((g) => g.result)).toEqual(['win', 'loss', 'win']);
    expect(setA.ourWins).toBe(2);
    expect(setA.opponentWins).toBe(1);
    expect(setA.currentGame).toBe(3);
    expect(setA.setWinner).toBe('us');
    expect(setB.setWinner).toBe('opponent');
    expect(setB.games.map((g) => g.result)).toEqual(['loss', 'win', 'loss']);
    expect(readyConfirmed).toEqual([2, 3]);
    expect(agentA.calls.teamPreview).toBe(3);
    // game 3's team preview input contained both previous games and the 1-1 score
    const g3 = setA.games[2].decisions.find((d) => d.kind === 'teampreview')!;
    expect(String((g3.finalDecision as { reasoning: string }).reasoning)).toMatch(/game 3 at 1-1, 2 previous game/);
  }, 300_000);

  it('17-20. plays real games with random legal actions, survives a disconnect mid-set, and tolerates malformed agent output', async () => {
    const agentA = new MockBattleAgent({ seed: 5, invalidFirstAttempts: 3, switchProbability: 0.25 });
    const agentB = new MockBattleAgent({ seed: 6, switchProbability: 0.25 });
    const a = await makeBot(server, uniq('aetherbot'), agentA, null);
    const b = await makeBot(server, uniq('rivalbot'), agentB, null);
    bots.push(a, b);
    // Deterministic disconnects: once in the between-games ready state (after game 1)
    // and once mid-game (right after our first move choice of game 2).
    let drops = 0;
    let reconnects = 0;
    a.conn.on('reconnected', () => reconnects++);
    a.orchestrator.on('gameEnded', (record) => {
      if (record.gameNumber === 1) {
        drops++;
        a.conn.simulateDisconnect();
      }
    });
    let droppedMidGame = false;
    a.conn.on('sent', (room: string, text: string) => {
      if (!droppedMidGame && a.orchestrator.sessions.get(room)?.gameNumber === 2 && text.startsWith('/choose move')) {
        droppedMidGame = true;
        drops++;
        setImmediate(() => a.conn.simulateDisconnect());
      }
    });
    const [setA, setB] = await playSet(server, a, b);
    expect(drops).toBe(2);
    expect(reconnects).toBe(2);
    expect(setA.setFinished).toBe(true);
    expect(setA.games.length).toBeGreaterThanOrEqual(2);
    expect(setA.games.length).toBeLessThanOrEqual(3);
    expect(setA.ourWins + setA.opponentWins + setA.ties).toBe(setA.games.length);
    expect(Math.max(setA.ourWins, setA.opponentWins)).toBe(2);
    expect(setB.games.length).toBe(setA.games.length);
    expect(setB.setWinner).toBe(setA.setWinner === 'us' ? 'opponent' : 'us');
    // Every game actually played out (no forfeits): turns > 0, both leads known, opponent bring revealed
    for (const g of setA.games) {
      expect(g.turns).toBeGreaterThan(0);
      expect(g.ourLead).toHaveLength(2);
      expect(g.opponentLead).toHaveLength(2);
      expect(g.opponentBringFour.length).toBeGreaterThanOrEqual(2);
      expect(g.opponentBringFour.length).toBeLessThanOrEqual(4);
      expect(g.observations.turns.length).toBe(g.turns);
    }
    // malformed decisions were rejected, retried, and never sent
    const allDecisions = setA.games.flatMap((g) => g.decisions);
    const invalidFirst = allDecisions.filter((d) => d.attempts[0] && !d.attempts[0].valid);
    expect(invalidFirst.length).toBe(3);
    expect(invalidFirst.every((d) => d.attempts.length === 2 && d.attempts[1].valid)).toBe(true);
    expect(allDecisions.some((d) => d.serverRejection)).toBe(false);
    // forced switches and doubles targeting were exercised somewhere in the set
    expect(allDecisions.some((d) => d.kind === 'switch')).toBe(true);
    const targeted = allDecisions.filter((d) => d.kind === 'move').flatMap((d) => (d.finalDecision as { actions: { type: string; target?: number }[] }).actions).filter((x) => x.type === 'move' && typeof x.target === 'number');
    expect(targeted.length).toBeGreaterThan(0);
    // speed order / damage observations captured
    const game = setA.games[0];
    expect(game.observations.damage.length).toBeGreaterThan(0);
    expect(game.observations.speedOrders.length).toBeGreaterThan(0);
  }, 600_000);

  it('MILESTONE 13. plays a set through the HTTP BattleAgent contract', async () => {
    const remote = await startAgentServer(new MockBattleAgent({ seed: 7, forfeitGames: [1, 2] }), 0);
    try {
      const httpAgent = new HttpBattleAgent({ baseUrl: `http://127.0.0.1:${remote.port}`, timeoutMs: 10_000 });
      const a = await makeBot(server, uniq('aetherbot'), new MockBattleAgent({ seed: 8 }), null);
      const b = await makeBot(server, uniq('httpbot'), httpAgent, null);
      bots.push(a, b);
      const [setA, setB] = await playSet(server, a, b);
      expect(setA.setWinner).toBe('us');
      expect(setB.setWinner).toBe('opponent');
      expect(setB.games.every((g) => g.decisions.some((d) => d.kind === 'teampreview' && !d.usedFallback))).toBe(true);
    } finally {
      remote.server.close();
    }
  }, 240_000);

  it('gives the agent exactly the legitimate information (fair-play boundary)', async () => {
    const seen: { preview: TeamPreviewInput[]; turns: TurnDecisionInput[] } = { preview: [], turns: [] };
    const spy: BattleAgent = {
      name: 'spy',
      async chooseTeamPreview(input) {
        seen.preview.push(input);
        return new MockBattleAgent({ seed: 9 }).chooseTeamPreview(input);
      },
      async chooseTurn(input) {
        seen.turns.push(input);
        return { actions: [], forfeit: true };
      },
    };
    const a = await makeBot(server, uniq('aetherbot'), spy, null);
    const b = await makeBot(server, uniq('rivalbot'), new MockBattleAgent({ seed: 10 }), null);
    bots.push(a, b);
    await playSet(server, a, b);
    expect(seen.preview.length).toBe(2);
    const p = seen.preview[0];
    expect(p.gameNumber).toBe(1);
    expect(p.setScore.display).toBe('0-0');
    expect(p.opponentTeamSheet?.pokemon).toHaveLength(6);
    expect(p.ourTeamSheet.pokemon[0].statPoints).toEqual({ hp: 32, atk: 4, def: 12, spa: 0, spd: 18, spe: 0 });
    const oppJson = JSON.stringify(p.opponentTeamSheet);
    expect(oppJson).not.toMatch(/statPoints|"evs"|"ivs"|"stats"/);
    expect(seen.preview[1].setScore.display).toBe('0-1');
    expect(seen.preview[1].previousGames).toHaveLength(1);
    const t = seen.turns[0];
    expect(t.legalActions.kind).toBe('move');
    expect(t.currentBattleState.sides[t.currentBattleState.ourSide].pokemon.every((m) => m.stats)).toBe(true);
    const opp = t.currentBattleState.ourSide === 'p1' ? 'p2' : 'p1';
    expect(t.currentBattleState.sides[opp].pokemon.every((m) => !m.stats)).toBe(true);
    expect(t.knownOpponentBring).toHaveLength(2);
  }, 240_000);
});
