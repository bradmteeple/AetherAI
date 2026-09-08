import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ControlStore } from '../../src/control/store';
import { BotRunner } from '../../src/control/BotRunner';
import { startControlServer, ControlServer } from '../../src/control/server';

const dir = mkdtempSync(join(tmpdir(), 'aether-control-'));
let n = 0;
const newStore = () => new ControlStore(join(dir, `state-${++n}.json`));

beforeAll(() => {
  delete process.env.PS_USERNAME;
  delete process.env.PS_PASSWORD;
  delete process.env.CONTROL_TOKEN;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('ControlStore', () => {
  it('stores accounts, keeps passwords server-side and makes the first one active', () => {
    const store = newStore();
    expect(store.listAccounts()).toEqual([]);
    const added = store.upsertAccount({ username: 'Aether Bot', password: 'hunter2' });
    expect(added).toMatchObject({ id: 'aetherbot', username: 'Aether Bot', hasPassword: true, active: true });
    expect(JSON.stringify(store.listAccounts())).not.toContain('hunter2');
    expect(store.activeAccount()?.password).toBe('hunter2');
  });

  it('persists to a private file that a second store reads back', () => {
    const store = newStore();
    store.upsertAccount({ username: 'First', password: 'p1' });
    store.upsertAccount({ username: 'Second', makeActive: false });
    expect(statSync(store.file).mode & 0o077).toBe(0);

    const reopened = new ControlStore(store.file);
    expect(reopened.listAccounts().map((a) => a.username)).toEqual(['First', 'Second']);
    expect(reopened.activeAccountId).toBe('first');
    expect(reopened.activeAccount()?.password).toBe('p1');
  });

  it('switches, updates and removes accounts', () => {
    const store = newStore();
    store.upsertAccount({ username: 'One', password: 'a' });
    store.upsertAccount({ username: 'Two', password: 'b', makeActive: false });
    expect(store.setActiveAccount('two').active).toBe(true);
    expect(store.activeAccount()?.username).toBe('Two');

    store.upsertAccount({ username: 'Two' }); // no password field: keep the stored one
    expect(store.activeAccount()?.password).toBe('b');
    store.upsertAccount({ username: 'Two', password: '' }); // explicit blank: unregistered name
    expect(store.activeAccount()?.password).toBeUndefined();

    store.removeAccount('two');
    expect(store.listAccounts().map((a) => a.id)).toEqual(['one']);
    expect(store.activeAccountId).toBe('one');
    expect(() => store.removeAccount('nope')).toThrow(/No account/);
  });

  it('rejects unusable input', () => {
    const store = newStore();
    expect(() => store.upsertAccount({ username: '  ' })).toThrow(/username is required/);
    expect(() => store.upsertAccount({ username: '!!!' })).toThrow(/letter or digit/);
    expect(() => store.upsertAccount({ username: 'x'.repeat(19) })).toThrow(/18 characters/);
    expect(() => store.updateSettings({ mode: 'sideways' })).toThrow(/challenge/);
    expect(() => store.updateSettings({ timer: 'yes' })).toThrow(/boolean/);
    expect(() => store.updateSettings({ serverUrl: '' })).toThrow(/serverUrl is required/);
  });

  it('merges settings patches and leaves the rest alone', () => {
    const store = newStore();
    const before = store.settings;
    const after = store.updateSettings({ mode: 'accept', opponent: '  Rival  ', continuous: false });
    expect(after.mode).toBe('accept');
    expect(after.opponent).toBe('Rival');
    expect(after.continuous).toBe(false);
    expect(after.serverUrl).toBe(before.serverUrl);
    expect(new ControlStore(store.file).settings.mode).toBe('accept');
  });
});

describe('control server', () => {
  let control: ControlServer;
  let base: string;

  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeEach(async () => {
    if (control) await control.close();
    const store = newStore();
    control = await startControlServer({
      port: 0,
      store,
      runner: new BotRunner(store, { runsDir: null, echoLogs: false }),
    });
    base = `http://127.0.0.1:${control.port}`;
  });

  afterAll(async () => {
    if (control) await control.close();
  });

  it('serves the panel page', async () => {
    const res = await fetch(base + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('AetherAI control');
  });

  it('reports the bot as off with no account', async () => {
    const { body } = await call('/api/config');
    expect(body.status.status).toBe('off');
    expect(body.accounts).toEqual([]);
    expect(body.format.id).toMatch(/^gen9/);
  });

  it('refuses to turn on without an account', async () => {
    const { status, body } = await call('/api/power', { method: 'POST', body: JSON.stringify({ on: true }) });
    expect(status).toBe(400);
    expect(body.error).toMatch(/No account selected/);
  });

  it('adds an account, selects it and never echoes the password', async () => {
    const added = await call('/api/accounts', { method: 'POST', body: JSON.stringify({ username: 'PanelBot', password: 'secret' }) });
    expect(added.status).toBe(200);
    expect(JSON.stringify(added.body)).not.toContain('secret');
    expect(added.body.account).toMatchObject({ id: 'panelbot', hasPassword: true, active: true });

    await call('/api/accounts', { method: 'POST', body: JSON.stringify({ username: 'Backup', makeActive: false }) });
    const switched = await call('/api/accounts/active', { method: 'POST', body: JSON.stringify({ id: 'backup' }) });
    expect(switched.body.accounts.find((a: any) => a.active).id).toBe('backup');

    const removed = await call('/api/accounts/delete', { method: 'POST', body: JSON.stringify({ id: 'backup' }) });
    expect(removed.body.accounts.map((a: any) => a.id)).toEqual(['panelbot']);
  });

  it('validates the power payload and settings', async () => {
    expect((await call('/api/power', { method: 'POST', body: JSON.stringify({}) })).status).toBe(400);
    expect((await call('/api/settings', { method: 'POST', body: JSON.stringify({ agent: 'psychic' }) })).status).toBe(400);
    const ok = await call('/api/settings', { method: 'POST', body: JSON.stringify({ mode: 'accept', timer: false }) });
    expect(ok.body.settings.mode).toBe('accept');
    expect(ok.body.applied).toBe(true);
  });

  it('surfaces a failed login instead of pretending the bot is on', async () => {
    await call('/api/accounts', { method: 'POST', body: JSON.stringify({ username: 'PanelBot' }) });
    await call('/api/settings', { method: 'POST', body: JSON.stringify({ serverUrl: 'ws://127.0.0.1:1/showdown/websocket', mode: 'accept' }) });
    const res = await call('/api/power', { method: 'POST', body: JSON.stringify({ on: true }) });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Could not log in as PanelBot/);

    const { body } = await call('/api/status');
    expect(body.status).toBe('error');
    expect(body.lastError).toBeTruthy();
    expect((await call('/api/power', { method: 'POST', body: JSON.stringify({ on: false }) })).body.status).toBe('off');
  });

  it('streams log lines incrementally', async () => {
    await call('/api/accounts', { method: 'POST', body: JSON.stringify({ username: 'PanelBot' }) });
    await call('/api/settings', { method: 'POST', body: JSON.stringify({ serverUrl: 'ws://127.0.0.1:1/showdown/websocket', mode: 'accept' }) });
    await call('/api/power', { method: 'POST', body: JSON.stringify({ on: true }) });
    const first = await call('/api/logs');
    expect(first.body.lines.length).toBeGreaterThan(0);
    expect(first.body.lines.map((l: any) => l.line).join('\n')).toContain('turning on as PanelBot');
    const next = await call(`/api/logs?after=${first.body.latest}`);
    expect(next.body.lines).toEqual([]);
  });

  it('answers unknown endpoints with 404', async () => {
    expect((await call('/api/nope')).status).toBe(404);
    expect((await fetch(base + '/nope')).status).toBe(404);
  });
});

describe('control server with a token', () => {
  let control: ControlServer;

  beforeAll(async () => {
    const store = newStore();
    control = await startControlServer({ port: 0, token: 'sesame', store, runner: new BotRunner(store, { runsDir: null, echoLogs: false }) });
  });
  afterAll(async () => control.close());

  it('locks the API but still serves the page', async () => {
    const base = `http://127.0.0.1:${control.port}`;
    expect((await fetch(base + '/')).status).toBe(200);
    expect((await fetch(base + '/api/status')).status).toBe(401);
    expect((await fetch(base + '/api/status?token=wrong')).status).toBe(401);
    expect((await fetch(base + '/api/status?token=sesame')).status).toBe(200);
    expect((await fetch(base + '/api/status', { headers: { authorization: 'Bearer sesame' } })).status).toBe(200);
    expect(control.url).toContain('token=sesame');
  });
});
