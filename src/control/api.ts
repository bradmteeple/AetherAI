import { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { FORMAT_ID, FORMAT_NAME } from '../format';
import { BotRunner, BotRunnerError } from './BotRunner';
import { ControlStore, ControlStoreError } from './store';

export interface ApiOptions {
  store: ControlStore;
  runner: BotRunner;
  /** When set, every request must present it (`Authorization: Bearer …` or `?token=`). */
  token?: string;
}

interface Handled {
  status: number;
  body: unknown;
}

const MAX_BODY_BYTES = 64 * 1024;

function statusOf(err: unknown): number {
  if (err instanceof BotRunnerError || err instanceof ControlStoreError) return err.status;
  return 500;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function presentedToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const query = url.searchParams.get('token');
  if (query) return query;
  const cookie = /(?:^|;\s*)aether_token=([^;]+)/.exec(req.headers.cookie ?? '');
  if (cookie) return decodeURIComponent(cookie[1]);
  return null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ControlStoreError('Request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new ControlStoreError(`Invalid JSON body: ${(err as Error).message}`, 400);
  }
}

/**
 * The control API. Every route is JSON in / JSON out and lives under `/api`;
 * anything else is the static panel, served by the caller.
 */
export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, options: ApiOptions): Promise<boolean> {
  if (!url.pathname.startsWith('/api/')) return false;
  const { store, runner, token } = options;

  if (token && !safeEqual(presentedToken(req, url) ?? '', token)) {
    send(res, 401, { error: 'Unauthorized — open the panel with the ?token= link printed at startup' });
    return true;
  }

  const method = req.method ?? 'GET';
  const route = `${method} ${url.pathname}`;
  try {
    const result = await dispatch(route, req, url, store, runner);
    if (!result) send(res, 404, { error: `No such endpoint: ${route}` });
    else send(res, result.status, result.body);
  } catch (err) {
    const status = statusOf(err);
    const expected = err instanceof BotRunnerError || err instanceof ControlStoreError;
    if (!expected) process.stderr.write(`control api error: ${(err as Error).stack ?? err}\n`);
    send(res, status, { error: (err as Error).message });
  }
  return true;
}

async function dispatch(
  route: string,
  req: IncomingMessage,
  url: URL,
  store: ControlStore,
  runner: BotRunner,
): Promise<Handled | null> {
  switch (route) {
    case 'GET /api/status':
      return { status: 200, body: runner.report() };

    case 'GET /api/config':
      return {
        status: 200,
        body: {
          settings: store.settings,
          accounts: store.listAccounts(),
          format: { id: FORMAT_ID, name: FORMAT_NAME },
          status: runner.report(),
        },
      };

    case 'POST /api/power': {
      const body = await readJson(req);
      const on = body.on;
      if (typeof on !== 'boolean') throw new ControlStoreError('Send {"on": true} or {"on": false}');
      return { status: 200, body: on ? await runner.start() : await runner.stop() };
    }

    case 'POST /api/start':
      return { status: 200, body: await runner.start() };

    case 'POST /api/stop':
      return { status: 200, body: await runner.stop() };

    case 'GET /api/logs': {
      const after = Number(url.searchParams.get('after') ?? '0');
      return { status: 200, body: runner.logs(Number.isFinite(after) && after > 0 ? after : 0) };
    }

    case 'GET /api/accounts':
      return { status: 200, body: { accounts: store.listAccounts() } };

    case 'POST /api/accounts': {
      const body = await readJson(req);
      const account = store.upsertAccount(body);
      return { status: 200, body: { account, accounts: store.listAccounts() } };
    }

    case 'POST /api/accounts/active': {
      const body = await readJson(req);
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) throw new ControlStoreError('id is required');
      if (runner.status !== 'off' && runner.status !== 'error') {
        throw new ControlStoreError('Turn the bot off before switching accounts', 409);
      }
      store.setActiveAccount(id);
      return { status: 200, body: { accounts: store.listAccounts() } };
    }

    case 'POST /api/accounts/delete': {
      const body = await readJson(req);
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) throw new ControlStoreError('id is required');
      if (id === store.activeAccountId && runner.status !== 'off' && runner.status !== 'error') {
        throw new ControlStoreError('That account is in use — turn the bot off first', 409);
      }
      store.removeAccount(id);
      return { status: 200, body: { accounts: store.listAccounts() } };
    }

    case 'GET /api/settings':
      return { status: 200, body: { settings: store.settings } };

    case 'POST /api/settings': {
      const body = await readJson(req);
      const settings = store.updateSettings(body);
      const applied = runner.status === 'off' || runner.status === 'error';
      return { status: 200, body: { settings, applied } };
    }

    default:
      return null;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}
