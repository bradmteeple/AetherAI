#!/usr/bin/env node
'use strict';
/**
 * Puts AetherAI on a public https link with no hosting account: starts the site
 * on loopback and opens a Cloudflare Quick Tunnel to it.
 *
 *   npm run share
 *
 * The link lives as long as this command runs and is a different address next
 * time. For one that stays put you need a host that runs Node continuously —
 * the site is a server, not a set of static files, because the battle engine
 * runs inside it.
 */
const { spawn, execFileSync } = require('node:child_process');
const { chmodSync, existsSync, mkdirSync, renameSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const { dirname, resolve } = require('node:path');

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Pull the public address out of a line of cloudflared output. */
function parseTunnelUrl(line) {
  const match = TUNNEL_URL.exec(line);
  return match ? match[0] : null;
}

function platformAsset() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'arm' : 'amd64';
  if (process.platform === 'darwin') return `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
  if (process.platform === 'win32') return 'cloudflared-windows-amd64.exe';
  return `cloudflared-linux-${arch}`;
}

function onPath() {
  try {
    execFileSync('cloudflared', ['--version'], { stdio: 'ignore' });
    return 'cloudflared';
  } catch {
    return null;
  }
}

/**
 * Find cloudflared, downloading the official release into `.aether/bin` the
 * first time. macOS ships a tarball we do not unpack, so there we ask for brew.
 */
async function ensureCloudflared() {
  const found = onPath();
  if (found) return found;

  const asset = platformAsset();
  const target = resolve(process.cwd(), '.aether/bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (existsSync(target)) return target;
  if (asset.endsWith('.tgz')) {
    throw new Error('cloudflared is not installed. Install it with `brew install cloudflared`, then run this again.');
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
    throw new Error(`Downloaded ${target} but it will not run here. Install cloudflared yourself and run this again.`);
  }
  return target;
}

function banner(publicUrl, localUrl, lanUrl) {
  const rows = [`Public link:  ${publicUrl}`, `This machine: ${localUrl}`];
  if (lanUrl) rows.push(`This network: ${lanUrl}`);
  const width = Math.max(...rows.map((r) => r.length)) + 4;
  const rule = '─'.repeat(width);
  return [
    '',
    `┌${rule}┐`,
    ...rows.map((r) => `│  ${r.padEnd(width - 4)}  │`),
    `└${rule}┘`,
    '',
    'The public link works from anywhere for as long as this command runs, and is',
    'a different address next time. Anyone with it can use the site. Stop with Ctrl-C.',
    '',
  ].join('\n');
}

async function main() {
  const site = require('../server/index.js');
  const cloudflared = await ensureCloudflared();

  const { port } = await site.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
  const localUrl = `http://127.0.0.1:${port}`;
  const lan = site.lanAddress();
  console.log(`AetherAI is up on ${localUrl}`);

  const tunnel = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', localUrl], { stdio: ['ignore', 'pipe', 'pipe'] });

  let announced = false;
  const scan = (chunk) => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      const url = parseTunnelUrl(line);
      if (url && !announced) {
        announced = true;
        console.log(banner(url, localUrl, lan ? `http://${lan}:${port}` : null));
      }
    }
    if (process.env.SHARE_VERBOSE) process.stderr.write(text);
  };
  tunnel.stdout.on('data', scan);
  tunnel.stderr.on('data', scan);

  tunnel.on('exit', (code) => {
    console.error(`\ncloudflared exited (${code}).`);
    if (!announced) {
      console.error('It never reached Cloudflare — usually a network that blocks api.trycloudflare.com');
      console.error('(a corporate proxy or VPN). The site itself is fine:');
      console.error(`  ${localUrl}`);
      if (lan) console.error(`  http://${lan}:${port}  (same wifi)`);
      console.error("Re-run with SHARE_VERBOSE=1 to see cloudflared's own output.");
    }
    process.exit(code ?? 1);
  });

  const shutdown = () => {
    console.log('\nshutting down...');
    tunnel.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { parseTunnelUrl };
