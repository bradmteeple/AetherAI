import { randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { handleApi } from './api';
import { Auth } from './auth';
import { BotRunner } from './BotRunner';
import { ControlStore } from './store';
import { CONTROL_PAGE_HTML, FAVICON_SVG } from './ui';

export interface ControlServerOptions {
  host?: string;
  port?: number;
  store?: ControlStore;
  runner?: BotRunner;
  /**
   * Shared secret for scripted access (`Authorization: Bearer …` or `?token=`).
   * Defaults to `CONTROL_TOKEN`; one is generated when a panel would otherwise
   * be reachable off-machine with no way to authenticate.
   */
  token?: string;
  /** Admin password for the browser login. Defaults to `CONTROL_PASSWORD`. */
  password?: string;
  /** Directory for set records (`null` disables recording). */
  runsDir?: string | null;
  echoLogs?: boolean;
}

export interface ControlServer {
  server: Server;
  store: ControlStore;
  runner: BotRunner;
  auth: Auth;
  host: string;
  port: number;
  token: string | null;
  /** True when a password protects the browser UI. */
  passwordProtected: boolean;
  url: string;
  close(): Promise<void>;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Start the control panel: the page on `/`, the JSON API on `/api/*`.
 *
 * The panel can read and write Showdown credentials, so it binds to loopback
 * by default. Exposing it on another interface requires a token — one is
 * generated if you do not supply `CONTROL_TOKEN`.
 */
export async function startControlServer(options: ControlServerOptions = {}): Promise<ControlServer> {
  const host = options.host ?? process.env.CONTROL_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.CONTROL_PORT ?? 8080);
  const store = options.store ?? new ControlStore();
  const runner = options.runner ?? new BotRunner(store, { runsDir: options.runsDir, echoLogs: options.echoLogs });
  const password = options.password ?? process.env.CONTROL_PASSWORD ?? null;
  let token = options.token ?? process.env.CONTROL_TOKEN ?? null;
  // Never leave a panel that is reachable off-machine wide open.
  if (!token && !password && !isLoopback(host)) token = randomBytes(24).toString('base64url');
  const auth = new Auth({ password: password ?? undefined, token: token ?? undefined });

  const server = createServer((req, res) => {
    void route(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (await handleApi(req, res, url, { store, runner, auth })) return;
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        return void res.end();
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(CONTROL_PAGE_HTML),
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      return void res.end(req.method === 'HEAD' ? undefined : CONTROL_PAGE_HTML);
    }
    if (url.pathname === '/favicon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' });
      return void res.end(FAVICON_SVG);
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ ok: true, status: runner.status }));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found\n');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const actualPort = (server.address() as AddressInfo).port;
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  // A password login needs no secret in the URL; a token-only panel does.
  const query = !password && token ? `?token=${encodeURIComponent(token)}` : '';
  const url = `http://${displayHost}:${actualPort}/${query}`;

  return {
    server,
    store,
    runner,
    auth,
    host,
    port: actualPort,
    token,
    passwordProtected: Boolean(password),
    url,
    close: async () => {
      await runner.stop().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
