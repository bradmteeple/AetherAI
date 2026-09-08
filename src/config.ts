import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FORMAT_ID } from './format';

export interface ConnectorConfig {
  serverUrl: string;
  loginUrl: string;
  username: string;
  password?: string;
  noLoginServer: boolean;
  formatId: string;
  teamFile: string;
  mode: 'challenge' | 'accept';
  opponent?: string;
  agent: 'mock' | 'http';
  agentUrl?: string;
  runsDir: string;
  timer: boolean;
  readyDelayMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  agentTimeoutMs: number;
}

function loadDotEnv(path = resolve(process.cwd(), '.env')) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

export function loadConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  loadDotEnv();
  const env = process.env;
  const serverUrl = env.PS_SERVER_URL ?? 'wss://sim3.psim.us/showdown/websocket';
  const isLocal = /localhost|127\.0\.0\.1/.test(serverUrl);
  const cfg: ConnectorConfig = {
    serverUrl,
    loginUrl: env.PS_LOGIN_URL ?? 'https://play.pokemonshowdown.com/api/',
    username: env.PS_USERNAME ?? '',
    password: env.PS_PASSWORD || undefined,
    noLoginServer: env.PS_NO_LOGIN_SERVER ? env.PS_NO_LOGIN_SERVER === 'true' : isLocal,
    formatId: env.PS_FORMAT ?? FORMAT_ID,
    teamFile: env.PS_TEAM_FILE ?? 'teams/regmb-team.txt',
    mode: (env.PS_MODE as 'challenge' | 'accept') ?? 'challenge',
    opponent: env.PS_OPPONENT || undefined,
    agent: (env.AGENT as 'mock' | 'http') ?? 'mock',
    agentUrl: env.AGENT_URL || undefined,
    runsDir: env.RUNS_DIR ?? 'runs',
    timer: env.PS_TIMER ? env.PS_TIMER === 'true' : true,
    readyDelayMs: env.PS_READY_DELAY_MS ? Number(env.PS_READY_DELAY_MS) : 1_500,
    logLevel: (env.LOG_LEVEL as ConnectorConfig['logLevel']) ?? 'info',
    agentTimeoutMs: env.AGENT_TIMEOUT_MS ? Number(env.AGENT_TIMEOUT_MS) : 45_000,
    ...overrides,
  };
  return cfg;
}
