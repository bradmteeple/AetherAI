#!/usr/bin/env tsx
/**
 * Puts the control panel on a public HTTPS URL with no hosting account:
 * starts the panel on loopback and opens a Cloudflare Quick Tunnel to it.
 *
 *   npm run share
 *
 * Prints a https://<random>.trycloudflare.com address and the password to sign
 * in with. The tunnel lasts as long as this command runs; the URL is new every
 * time. For a permanent address, deploy the Dockerfile/fly.toml instead.
 */
import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config';
import { startControlServer } from '../src/control/server';

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Pull the public address out of a line of cloudflared output. */
export function parseTunnelUrl(line: string): string | null {
  const match = TUNNEL_URL.exec(line);
  return match ? match[0] : null;
}

function platformAsset(): string {
  const os = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'arm' : 'amd64';
  if (os === 'darwin') return `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
  if (os === 'win32') return 'cloudflared-windows-amd64.exe';
  return `cloudflared-linux-${arch}`;
}

function onPath(): string | null {
  try {
    execFileSync('cloudflared', ['--version'], { stdio: 'ignore' });
    return 'cloudflared';
  } catch {
    return null;
  }
}

/**
 * Find cloudflared, downloading the official release into `.aether/bin` the
 * first time. macOS ships a tarball, which we do not unpack — tell the user to
 * `brew install cloudflared` instead.
 */
async function ensureCloudflared(): Promise<string> {
  const found = onPath();
  if (found) return found;

  const asset = platformAsset();
  const target = resolve(process.cwd(), '.aether/bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (existsSync(target)) return target;
  if (asset.endsWith('.tgz')) {
    throw new Error('cloudflared is not installed. Install it with `brew install cloudflared` and run this again.');
  }

  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  console.log(`Downloading cloudflared from ${url} ...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not download cloudflared (HTTP ${res.status}). Install it yourself and run this again.`);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.download`;
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  chmodSync(tmp, 0o755);
  renameSync(tmp, target);
  try {
    execFileSync(target, ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error(`Downloaded ${target} but it will not run on this machine. Install cloudflared yourself and run this again.`);
  }
  return target;
}

function banner(url: string, password: string | null): string {
  const rows = [
    `Control panel:  ${url}`,
    password ? `Password:       ${password}` : 'No password: anyone with this link can control the bot.',
  ];
  const width = Math.max(...rows.map((r) => r.length)) + 4;
  const rule = '─'.repeat(width);
  return [
    '',
    `┌${rule}┐`,
    ...rows.map((r) => `│  ${r.padEnd(width - 4)}  │`),
    `└${rule}┘`,
    '',
    'That URL works from anywhere for as long as this command runs, and is a',
    'different address next time. Stop with Ctrl-C.',
    '',
  ].join('\n');
}

async function main() {
  const open = process.argv.includes('--open');
  const cfg = loadConfig();
  const password = open ? null : process.env.CONTROL_PASSWORD || randomBytes(9).toString('base64url');
  if (open) {
    console.log('WARNING: --open publishes the panel with no password. Anyone with the URL can');
    console.log('         turn the bot on and off and read the account list.\n');
  }

  const cloudflared = await ensureCloudflared();
  const control = await startControlServer({
    host: '127.0.0.1',
    port: Number(process.env.CONTROL_PORT ?? 8080),
    password: password ?? undefined,
    runsDir: cfg.runsDir,
  });
  console.log(`Panel running locally at http://127.0.0.1:${control.port}`);
  console.log(`Accounts and settings: ${control.store.file}`);
  // Printed before the tunnel comes up so it is on screen even if that fails.
  if (password) console.log(`Sign-in password: ${password}`);

  const tunnel: ChildProcess = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${control.port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let announced = false;
  const scan = (chunk: Buffer) => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      const url = parseTunnelUrl(line);
      if (url && !announced) {
        announced = true;
        console.log(banner(url, password));
      }
    }
    if (process.env.SHARE_VERBOSE) process.stderr.write(text);
  };
  tunnel.stdout?.on('data', scan);
  tunnel.stderr?.on('data', scan);

  const timer = setTimeout(() => {
    if (!announced) {
      console.error('cloudflared has not produced a URL yet. Re-run with SHARE_VERBOSE=1 to see its output.');
    }
  }, 30_000);
  timer.unref();

  tunnel.on('exit', (code) => {
    console.error(`\ncloudflared exited (${code}).`);
    if (!announced) {
      console.error('It never reached Cloudflare. Usually that is a network that blocks');
      console.error('api.trycloudflare.com (a corporate proxy or VPN); the panel itself is fine.');
      console.error(`It is still reachable on this machine at http://127.0.0.1:${control.port}.`);
    }
    void control.close().then(() => process.exit(code ?? 1));
  });

  const shutdown = () => {
    console.log('\nshutting down...');
    tunnel.kill('SIGTERM');
    void control.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
