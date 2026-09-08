import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ControlStore } from '../../src/control/store';
import { BotRunner } from '../../src/control/BotRunner';
import { startControlServer, ControlServer } from '../../src/control/server';
import { Auth, SESSION_COOKIE } from '../../src/control/auth';
import { parseTunnelUrl } from '../../scripts/share';
import { renderControlPage } from '../../src/control/ui';
import { DEFAULT_ALLOWED_ORIGINS, originAllowed, parseAllowedOrigins } from '../../src/control/cors';

const dir = mkdtempSync(join(tmpdir(), 'aether-control-'));
let n = 0;
const newStore = () => new ControlStore(join(dir, `state-${++n}.json`));

beforeAll(() => {
  delete process.env.PS_USERNAME;
  delete process.env.PS_PASSWORD;
  delete process.env.CONTROL_TOKEN;
  delete process.env.CONTROL_PASSWORD;
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

describe('Auth', () => {
  const req = (headers: Record<string, string> = {}) =>
    ({ headers, socket: { remoteAddress: '198.51.100.4' } }) as any;

  it('is open only when nothing is configured', () => {
    expect(new Auth().open).toBe(true);
    expect(new Auth({ password: 'pw' }).open).toBe(false);
    expect(new Auth({ token: 'tk' }).open).toBe(false);
  });

  it('mints sessions that verify, expire and do not survive a password change', () => {
    let clock = 1_000;
    const auth = new Auth({ password: 'pw', now: () => clock });
    const { cookie } = auth.login('pw', 'ip');
    expect(auth.validSession(cookie)).toBe(true);
    expect(auth.validSession(cookie.slice(0, -3) + 'aaa')).toBe(false);
    expect(auth.validSession('v1.9999999999999.x.y')).toBe(false);
    expect(new Auth({ password: 'different', now: () => clock }).validSession(cookie)).toBe(false);
    // A restart with the same password keeps existing sessions valid.
    expect(new Auth({ password: 'pw', now: () => clock }).validSession(cookie)).toBe(true);
    clock += 15 * 24 * 60 * 60 * 1_000;
    expect(auth.validSession(cookie)).toBe(false);
  });

  it('locks out repeated wrong passwords per client address', () => {
    let clock = 0;
    const auth = new Auth({ password: 'pw', now: () => clock });
    for (let i = 0; i < 5; i++) expect(() => auth.login('nope', 'attacker')).toThrow(/Wrong password/);
    expect(() => auth.login('nope', 'attacker')).toThrow(/Too many attempts/);
    expect(() => auth.login('pw', 'attacker')).toThrow(/Too many attempts/);
    expect(() => auth.login('pw', 'someone-else')).not.toThrow(); // the lockout is per address
    clock += 61_000;
    expect(() => auth.login('pw', 'attacker')).not.toThrow();
  });

  it('accepts a bearer token or query token when one is configured', () => {
    const auth = new Auth({ token: 'tk' });
    const url = new URL('http://x/api/status');
    expect(auth.check(req(), url).ok).toBe(false);
    expect(auth.check(req({ authorization: 'Bearer tk' }), url).ok).toBe(true);
    expect(auth.check(req({ authorization: 'Bearer nope' }), url).ok).toBe(false);
    expect(auth.check(req(), new URL('http://x/api/status?token=tk')).ok).toBe(true);
  });

  it('marks the cookie Secure only when the request arrived over https', () => {
    const auth = new Auth({ password: 'pw' });
    expect(auth.cookieHeader('v', req())).not.toContain('Secure');
    expect(auth.cookieHeader('v', req({ 'x-forwarded-proto': 'https' }))).toContain('Secure');
    expect(auth.cookieHeader('v', req())).toContain('HttpOnly');
    expect(auth.cookieHeader('v', req())).toContain('SameSite=Strict');
  });
});

describe('control server behind a password', () => {
  let control: ControlServer;
  let base: string;

  beforeAll(async () => {
    const store = newStore();
    control = await startControlServer({
      port: 0,
      password: 'correct horse',
      store,
      runner: new BotRunner(store, { runsDir: null, echoLogs: false }),
    });
    base = `http://127.0.0.1:${control.port}`;
  });
  afterAll(async () => control.close());

  it('serves the page but locks the API until you sign in', async () => {
    expect((await fetch(base + '/')).status).toBe(200);
    expect(control.url).not.toContain('token');
    expect(control.passwordProtected).toBe(true);

    const anon = await fetch(base + '/api/session');
    expect(await anon.json()).toMatchObject({ authenticated: false, needsPassword: true, open: false });

    const denied = await fetch(base + '/api/status');
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ needsPassword: true });

    const wrong = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'guess' }),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();

    const ok = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct horse' }),
    });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toContain(SESSION_COOKIE);
    expect(cookie).toContain('HttpOnly');

    const session = cookie.split(';')[0];
    const allowed = await fetch(base + '/api/status', { headers: { cookie: session } });
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as any).status).toBe('off');

    const out = await fetch(base + '/api/logout', { method: 'POST', headers: { cookie: session } });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('never leaks a stored password through the API, signed in or not', async () => {
    const login = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct horse' }),
    });
    const session = login.headers.get('set-cookie')!.split(';')[0];
    await fetch(base + '/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session },
      body: JSON.stringify({ username: 'HostedBot', password: 'showdown-secret' }),
    });
    const config = await (await fetch(base + '/api/config', { headers: { cookie: session } })).text();
    expect(config).toContain('HostedBot');
    expect(config).not.toContain('showdown-secret');
    expect(config).not.toContain('correct horse');
  });
});

describe('share: cloudflared output', () => {
  it('picks the quick-tunnel URL out of a log line', () => {
    const line = '2026-09-08T01:08:21Z INF |  https://neatly-picked-words.trycloudflare.com  |';
    expect(parseTunnelUrl(line)).toBe('https://neatly-picked-words.trycloudflare.com');
    expect(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
    expect(parseTunnelUrl('ERR Host not in allowlist: api.trycloudflare.com')).toBeNull();
    expect(parseTunnelUrl('')).toBeNull();
  });
});

describe('control panel page', () => {
  const script = (html: string) => /<script>([\s\S]*?)<\/script>/.exec(html)![1];

  it('emits a script that parses, in both modes', () => {
    // A stray escape in the TypeScript template literal silently breaks the
    // page, which typechecking cannot see.
    for (const sameOrigin of [true, false]) {
      expect(() => new Function(script(renderControlPage({ sameOrigin })))).not.toThrow();
    }
  });

  it('substitutes the same-origin marker', () => {
    expect(script(renderControlPage({ sameOrigin: true }))).toContain('var SAME_ORIGIN = true;');
    expect(script(renderControlPage({ sameOrigin: false }))).toContain('var SAME_ORIGIN = false;');
    expect(renderControlPage({ sameOrigin: true })).not.toContain('/*SAME_ORIGIN*/');
  });

  it('keeps the URL normaliser regexes intact', () => {
    const src = script(renderControlPage({ sameOrigin: false }));
    expect(src).toContain(String.raw`replace(/\/+$/, '')`);
    expect(src).toContain(String.raw`/^https?:\/\//i`);
  });

  it('forces [hidden] to win over the overlay display rules', () => {
    expect(renderControlPage({ sameOrigin: false })).toContain('[hidden] { display: none !important; }');
  });
});

describe('CORS', () => {
  it('matches exact origins, wildcard hosts and *', () => {
    expect(originAllowed('https://bradmteeple.github.io', DEFAULT_ALLOWED_ORIGINS)).toBe(true);
    expect(originAllowed('https://evil.example', DEFAULT_ALLOWED_ORIGINS)).toBe(false);
    expect(originAllowed('http://bradmteeple.github.io', DEFAULT_ALLOWED_ORIGINS)).toBe(false); // scheme must match
    expect(originAllowed('https://notgithub.io', ['https://*.github.io'])).toBe(false);
    expect(originAllowed('http://127.0.0.1:8140', ['http://127.0.0.1:8140'])).toBe(true);
    expect(originAllowed('https://anything.example', ['*'])).toBe(true);
    expect(originAllowed('', ['*'])).toBe(false);
  });

  it('parses the env allowlist, defaulting to GitHub Pages', () => {
    expect(parseAllowedOrigins(undefined)).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(parseAllowedOrigins('https://a.example, https://b.example')).toEqual(['https://a.example', 'https://b.example']);
    expect(parseAllowedOrigins('')).toEqual([]);
  });
});
