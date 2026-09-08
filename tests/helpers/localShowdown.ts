import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { candidateShowdownDirs } from '../../src/team/dex';
import { ShowdownConnection } from '../../src/showdown/ShowdownConnection';
import { createLogger, Logger } from '../../src/util/logger';
import WebSocket from 'ws';

export function findShowdownDir(): string | null {
  return candidateShowdownDirs().find((d) => existsSync(resolve(d, 'pokemon-showdown')) && existsSync(resolve(d, 'dist/server/index.js'))) ?? null;
}

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => res(port));
    });
    srv.on('error', rej);
  });
}

export interface LocalShowdown {
  dir: string;
  port: number;
  url: string;
  process: ChildProcess;
  stop(): Promise<void>;
  logs: string[];
}

/**
 * Starts `node pokemon-showdown start <port> --no-security` from the local
 * checkout and waits until the WebSocket endpoint answers with |challstr|.
 */
export async function startLocalShowdown(logger: Logger = createLogger({ level: 'warn', prefix: 'ps' })): Promise<LocalShowdown> {
  const dir = findShowdownDir();
  if (!dir) throw new Error('No local Showdown build found. Run `npm run setup:showdown` (or set SHOWDOWN_DIR).');
  const port = await freePort();
  const logs: string[] = [];
  const proc = spawn(process.execPath, ['pokemon-showdown', 'start', String(port), '--no-security'], {
    cwd: dir,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onData = (d: Buffer) => {
    const text = d.toString();
    logs.push(text);
    if (process.env.PS_SERVER_LOG) process.stderr.write(`[ps] ${text}`);
  };
  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);
  const url = `ws://127.0.0.1:${port}/showdown/websocket`;
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`Showdown exited early:\n${logs.join('')}`);
    ready = await new Promise<boolean>((res) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.terminate();
        res(false);
      }, 3_000);
      ws.on('message', (data) => {
        if (data.toString().includes('|challstr|')) {
          clearTimeout(timer);
          ws.close();
          res(true);
        }
      });
      ws.on('error', () => {
        clearTimeout(timer);
        res(false);
      });
    });
    if (!ready) await new Promise((r) => setTimeout(r, 1_000));
  }
  if (!ready) {
    proc.kill('SIGKILL');
    throw new Error(`Showdown did not become ready on ${url}:\n${logs.slice(-20).join('')}`);
  }
  logger.info(`local Showdown ready at ${url}`);
  return {
    dir,
    port,
    url,
    process: proc,
    logs,
    stop: () =>
      new Promise<void>((res) => {
        if (proc.exitCode !== null) return res();
        proc.once('exit', () => res());
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL');
          res();
        }, 5_000);
      }),
  };
}

export async function connectBot(url: string, username: string, logger?: Logger): Promise<ShowdownConnection> {
  const conn = new ShowdownConnection({
    serverUrl: url,
    username,
    noLoginServer: true,
    logger: logger ?? createLogger({ level: (process.env.LOG_LEVEL as 'debug') || 'warn', prefix: username }),
    sendIntervalMs: 30,
    reconnect: { enabled: true, initialDelayMs: 200, maxDelayMs: 1_000 },
  });
  await conn.connect();
  return conn;
}
