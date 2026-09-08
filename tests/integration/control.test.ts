import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectBot, findShowdownDir, LocalShowdown, startLocalShowdown } from '../helpers/localShowdown';
import { MockBattleAgent } from '../../src/agent/MockBattleAgent';
import { SetOrchestrator } from '../../src/orchestration/SetOrchestrator';
import { ShowdownConnection } from '../../src/showdown/ShowdownConnection';
import { loadTeamFile } from '../../src/team/TeamLoader';
import { createLogger } from '../../src/util/logger';
import { BotRunner, StatusReport } from '../../src/control/BotRunner';
import { ControlServer, startControlServer } from '../../src/control/server';
import { ControlStore } from '../../src/control/store';

const HAS_SHOWDOWN = !!findShowdownDir();
const describeIf = HAS_SHOWDOWN || process.env.REQUIRE_LOCAL_SHOWDOWN ? describe : describe.skip;

const TEAM = loadTeamFile('teams/regmb-team.txt');
const log = createLogger({ level: (process.env.LOG_LEVEL as 'info') || 'warn', prefix: 'test' });

describeIf('control panel driving the bot on a local Showdown server', () => {
  let server: LocalShowdown;
  let control: ControlServer;
  let base: string;
  let sparring: ShowdownConnection | null = null;
  const dir = mkdtempSync(join(tmpdir(), 'aether-control-int-'));
  let counter = 0;
  const uniq = (base_: string) => `${base_}${Date.now().toString(36).slice(-4)}${counter++}`;

  beforeAll(async () => {
    server = await startLocalShowdown();
  }, 180_000);

  afterAll(async () => {
    await control?.close();
    await sparring?.disconnect().catch(() => undefined);
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function panel(botName: string): Promise<{ store: ControlStore; call: (path: string, body?: unknown) => Promise<any> }> {
    const store = new ControlStore(join(dir, `${botName}.json`));
    store.upsertAccount({ username: botName });
    store.updateSettings({
      serverUrl: server.url,
      mode: 'accept',
      opponent: '',
      agent: 'mock',
      timer: false,
      continuous: true,
      logLevel: 'info',
    });
    control = await startControlServer({ port: 0, store, runner: new BotRunner(store, { runsDir: null, echoLogs: false }) });
    base = `http://127.0.0.1:${control.port}`;
    const call = async (path: string, body?: unknown) => {
      const res = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
      return data;
    };
    return { store, call };
  }

  async function until(call: (path: string) => Promise<any>, predicate: (s: StatusReport) => boolean, what: string, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    let last: StatusReport | null = null;
    while (Date.now() < deadline) {
      last = (await call('/api/status')) as StatusReport;
      if (predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Timed out waiting for ${what}; last status: ${JSON.stringify(last)}`);
  }

  async function challenge(opponentName: string) {
    const name = uniq('Spar');
    const conn = await connectBot(server.url, name, log.child(name));
    sparring = conn;
    const orchestrator = new SetOrchestrator({
      connection: conn,
      agent: new MockBattleAgent(),
      team: TEAM,
      runsDir: null,
      logger: log.child(`${name}:set`),
      timer: false,
      readyDelayMs: 200,
      agentTimeoutMs: 10_000,
    });
    const done = orchestrator.runSet({ mode: 'challenge', opponent: opponentName, timeoutMs: 60_000 }).catch(() => null);
    return { name, conn, orchestrator, done };
  }

  it('turns on, plays a whole set and turns off again', async () => {
    const botName = uniq('Panel');
    const { call } = await panel(botName);

    const on = (await call('/api/power', { on: true })) as StatusReport;
    expect(on.status).toBe('online');
    expect(on.loggedInAs).toBe(botName);
    expect(on.account?.username).toBe(botName);

    const spar = await challenge(botName);
    const playing = await until(call, (s) => s.currentSet !== null, 'the set to start');
    expect(playing.currentSet?.setId).toBeTruthy();

    await spar.done;
    const finished = await until(call, (s) => s.totals.sets >= 1, 'the set to be recorded');
    expect(finished.lastSet?.opponent).toBe(spar.name);
    expect(['win', 'loss', 'tie']).toContain(finished.lastSet?.result);
    expect(finished.lastSet?.score).toMatch(/^[0-2]-[0-2]$/);
    expect(finished.status).toBe('online'); // continuous: waiting for the next challenge

    const logs = (await call('/api/logs')) as { lines: { line: string }[] };
    expect(logs.lines.map((l) => l.line).join('\n')).toContain('set finished');

    const off = (await call('/api/power', { on: false })) as StatusReport;
    expect(off.status).toBe('off');
    expect(off.connection).toBe('disconnected');
    expect(off.loggedInAs).toBeNull();

    await spar.conn.disconnect().catch(() => undefined);
  }, 300_000);

  it('turning off mid-set drops the connection and refuses account switches while on', async () => {
    const botName = uniq('Panel');
    const { call, store } = await panel(botName);
    store.upsertAccount({ username: uniq('Other'), makeActive: false });
    const otherId = store.listAccounts().find((a) => !a.active)!.id;

    await call('/api/power', { on: true });
    const spar = await challenge(botName);
    await until(call, (s) => s.currentSet !== null, 'the set to start');

    await expect(call('/api/accounts/active', { id: otherId })).rejects.toThrow(/Turn the bot off/);

    const off = (await call('/api/power', { on: false })) as StatusReport;
    expect(off.status).toBe('off');
    expect(off.currentSet).toBeNull();
    expect(off.totals.sets).toBe(0);

    // With the bot off, the account can be switched and turned back on.
    await call('/api/accounts/active', { id: otherId });
    const status = (await call('/api/status')) as StatusReport;
    expect(status.status).toBe('off');

    await spar.conn.disconnect().catch(() => undefined);
  }, 300_000);
});
