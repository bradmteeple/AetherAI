#!/usr/bin/env node
import { loadConfig, ConnectorConfig } from './config';
import { createLogger } from './util/logger';
import { ShowdownConnection } from './showdown/ShowdownConnection';
import { loadTeamFile } from './team/TeamLoader';
import { staticChecks, validateLocally, validateWithServer } from './team/TeamValidator';
import { MockBattleAgent } from './agent/MockBattleAgent';
import { HttpBattleAgent } from './agent/HttpBattleAgent';
import { SetOrchestrator } from './orchestration/SetOrchestrator';
import { BattleAgent } from './agent/BattleAgent';
import { FORMAT_ID, FORMAT_NAME } from './format';
import { scoreString } from './set/SetState';
import { startControlServer } from './control/server';

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean>; positional: string[] } {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const [key, inlineValue] = arg.slice(2).split('=');
      if (inlineValue !== undefined) flags[key] = inlineValue;
      else if (rest[i + 1] && !rest[i + 1].startsWith('--')) flags[key] = rest[++i];
      else flags[key] = true;
    } else positional.push(arg);
  }
  return { command, flags, positional };
}

function usage() {
  console.log(`AetherAI Showdown connector — ${FORMAT_NAME} (${FORMAT_ID})

Usage:
  aether play [--mode challenge|accept] [--opponent NAME] [--agent mock|http] [--agent-url URL] [--team FILE]
  aether validate-team [FILE] [--server]     validate a team (static + local Showdown; --server also asks the connected server)
  aether control [--host HOST] [--port PORT] [--password PW] [--token TOKEN]
                                            web control panel: turn the bot on/off and pick the account
  aether help

Configuration comes from environment variables / .env (see .env.example); flags override.`);
}

function makeAgent(cfg: ConnectorConfig): BattleAgent {
  if (cfg.agent === 'http') {
    if (!cfg.agentUrl) throw new Error('AGENT=http requires AGENT_URL');
    return new HttpBattleAgent({ baseUrl: cfg.agentUrl, timeoutMs: cfg.agentTimeoutMs });
  }
  return new MockBattleAgent();
}

async function main() {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));
  const overrides: Partial<ConnectorConfig> = {};
  if (typeof flags.mode === 'string') overrides.mode = flags.mode as ConnectorConfig['mode'];
  if (typeof flags.opponent === 'string') overrides.opponent = flags.opponent;
  if (typeof flags.agent === 'string') overrides.agent = flags.agent as ConnectorConfig['agent'];
  if (typeof flags['agent-url'] === 'string') overrides.agentUrl = flags['agent-url'];
  if (typeof flags.team === 'string') overrides.teamFile = flags.team;
  if (typeof flags.server === 'string') overrides.serverUrl = flags.server;
  if (typeof flags.username === 'string') overrides.username = flags.username;
  if (flags['no-timer']) overrides.timer = false;
  const cfg = loadConfig(overrides);
  const log = createLogger({ level: cfg.logLevel });

  switch (command) {
    case 'validate-team': {
      const file = positional[0] ?? cfg.teamFile;
      const team = loadTeamFile(file);
      const stat = staticChecks(team);
      console.log(`Static checks: ${stat.ok ? 'OK' : 'FAILED'}`);
      for (const p of stat.problems) console.log(`  - ${p}`);
      const local = validateLocally(team, cfg.formatId);
      if (local) {
        console.log(`Local Showdown validator: ${local.ok ? 'OK' : 'FAILED'}`);
        for (const p of local.problems) console.log(`  - ${p}`);
      } else {
        console.log('Local Showdown validator: not available (run `npm run setup:showdown`)');
      }
      if (flags.server) {
        const conn = new ShowdownConnection({ ...connOptions(cfg), logger: log.child('ws') });
        await conn.connect();
        const res = await validateWithServer(conn, team, cfg.formatId);
        console.log(`Server validator: ${res.ok ? 'OK' : 'FAILED'}`);
        for (const p of res.problems) console.log(`  - ${p}`);
        await conn.disconnect();
        process.exitCode = res.ok ? 0 : 1;
      } else if (!stat.ok || (local && !local.ok)) process.exitCode = 1;
      break;
    }
    case 'play': {
      if (!cfg.username) throw new Error('PS_USERNAME is required');
      if (cfg.mode === 'challenge' && !cfg.opponent) throw new Error('PS_OPPONENT (or --opponent) is required in challenge mode');
      const team = loadTeamFile(cfg.teamFile);
      const conn = new ShowdownConnection({ ...connOptions(cfg), logger: log.child('ws'), reconnect: { enabled: true } });
      await conn.connect();
      const agent = makeAgent(cfg);
      const orchestrator = new SetOrchestrator({
        connection: conn,
        agent,
        team,
        formatId: cfg.formatId,
        runsDir: cfg.runsDir,
        logger: log.child('set'),
        timer: cfg.timer,
        readyDelayMs: cfg.readyDelayMs,
        agentTimeoutMs: cfg.agentTimeoutMs,
      });
      orchestrator.on('gameEnded', (record, set) => log.info(`Game ${record.gameNumber}: ${record.result} — score ${scoreString(set)}`));
      const set = await orchestrator.runSet(cfg.mode === 'challenge' ? { mode: 'challenge', opponent: cfg.opponent! } : { mode: 'accept', from: cfg.opponent });
      log.info(`Set over: ${set.setWinner} (${scoreString(set)}); record in ${orchestrator.recorder?.dir ?? 'memory'}`);
      await conn.disconnect();
      break;
    }
    case 'control': {
      const control = await startControlServer({
        host: typeof flags.host === 'string' ? flags.host : undefined,
        port: typeof flags.port === 'string' ? Number(flags.port) : undefined,
        token: typeof flags.token === 'string' ? flags.token : undefined,
        password: typeof flags.password === 'string' ? flags.password : undefined,
        runsDir: cfg.runsDir,
      });
      console.log(`AetherAI control panel: ${control.url}`);
      console.log(`Accounts and settings: ${control.store.file}`);
      if (control.passwordProtected) console.log('Sign in with the password in CONTROL_PASSWORD.');
      else if (control.token) console.log('A token is required — use the URL above exactly as printed.');
      else console.log('No password set: anyone who can reach this port can control the bot.');
      const shutdown = () => {
        console.log('\nshutting down...');
        void control.close().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }
    default:
      usage();
  }
}

function connOptions(cfg: ConnectorConfig) {
  return {
    serverUrl: cfg.serverUrl,
    loginUrl: cfg.loginUrl,
    username: cfg.username,
    password: cfg.password,
    noLoginServer: cfg.noLoginServer,
  };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
