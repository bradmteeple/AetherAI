'use strict';
/**
 * AetherAI — landing page, team builder and battle, served over plain node:http.
 * Every piece of Pokémon data and every battle comes from the vendored Showdown
 * engine in vendor/pokemon-showdown.
 */
const { createServer } = require('node:http');
const { createReadStream, existsSync, statSync } = require('node:fs');
const { networkInterfaces } = require('node:os');
const { extname, join, normalize } = require('node:path');
const dex = require('./showdown');
const battles = require('./battles');
const { samplesFor } = require('./sample-teams');

const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const MAX_BODY = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const PAGES = { '/': 'index.html', '/teams': 'teams.html', '/battle': 'battle.html' };

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object');
    return parsed;
  } catch (err) {
    throw new Error(`Invalid JSON body: ${err.message}`);
  }
}

function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || pathname.replace(/^\/+/, '');
  const file = join(PUBLIC_DIR, normalize(rel));
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found\n');
  }
  const type = MIME[extname(file)] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': type.startsWith('text/html') ? 'no-store' : 'max-age=300',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/formats') return json(res, 200, { formats: dex.formats() });

  if (route === 'GET /api/dex') {
    const format = url.searchParams.get('format') || 'gen9ou';
    return json(res, 200, dex.dexFor(format));
  }

  if (route === 'GET /api/movedex') return json(res, 200, { moves: dex.moveDex() });

  if (route === 'GET /api/sampleteams') {
    const format = url.searchParams.get('format') || '';
    return json(res, 200, { teams: samplesFor(format) });
  }

  if (route === 'GET /api/moves') {
    const species = url.searchParams.get('species');
    const format = url.searchParams.get('format') || 'gen9ou';
    if (!species) return json(res, 400, { error: 'species is required' });
    return json(res, 200, { species, moves: dex.movesFor(species, format) });
  }

  if (route === 'POST /api/validate') {
    const body = await readJson(req);
    if (typeof body.paste !== 'string') return json(res, 400, { error: 'paste is required' });
    return json(res, 200, dex.validate(body.format || 'gen9ou', body.paste));
  }

  if (route === 'POST /api/battle') {
    const body = await readJson(req);
    const formatId = typeof body.format === 'string' ? body.format : '';
    const format = dex.formatById(formatId);
    if (!format) return json(res, 400, { error: `Unknown format "${formatId}"` });
    if (typeof body.paste !== 'string' || !body.paste.trim()) {
      return json(res, 400, { error: `${format.name} needs a team. Build one in the team builder, or pick a sample team.` });
    }
    const check = dex.validate(formatId, body.paste);
    if (!check.ok) return json(res, 400, { error: 'That team is not legal here.', problems: check.problems });
    const session = await battles.create({
      formatId,
      team: body.paste,
      bestOf: format.bestOf,
      playerName: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 18) : 'You',
    });
    return json(res, 200, session.view(0));
  }

  const battleMatch = /^\/api\/battle\/([0-9a-f-]{36})(\/choose)?$/.exec(url.pathname);
  if (battleMatch) {
    const session = battles.get(battleMatch[1]);
    if (!session) return json(res, 404, { error: 'That battle has expired. Start a new one.' });
    const since = Number(url.searchParams.get('since') || 0);

    if (req.method === 'GET') return json(res, 200, session.view(Number.isFinite(since) ? since : 0));

    if (req.method === 'POST' && battleMatch[2]) {
      const body = await readJson(req);
      if (typeof body.choice !== 'string') return json(res, 400, { error: 'choice is required' });
      try {
        session.choose(body.choice);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      await session.settled();
      return json(res, 200, session.view(Number.isFinite(since) ? since : 0));
    }
  }

  return json(res, 404, { error: `No such endpoint: ${route}` });
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const handler = url.pathname.startsWith('/api/')
    ? api(req, res, url)
    : Promise.resolve(serveStatic(req, res, url.pathname));
  handler.catch((err) => {
    if (res.headersSent) return res.end();
    json(res, 500, { error: err.message });
  });
});

/** This machine's address on the local network, for opening the site on a phone. */
function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

function listen({ host = HOST, port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({ host, port: server.address().port });
    });
  });
}

if (require.main === module) {
  listen().then(({ host, port }) => {
    console.log(`AetherAI running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    if (host === '0.0.0.0') {
      const lan = lanAddress();
      if (lan) console.log(`On this network:       http://${lan}:${port}`);
    } else {
      console.log('Only this machine can reach it. For your phone or another computer:');
      console.log(`  HOST=0.0.0.0 npm start        (same wifi)`);
      console.log(`  npm run share                 (a public https link, no account)`);
    }
  }).catch((err) => {
    console.error(err.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use. Try: PORT=3001 npm start`
      : err.message);
    process.exit(1);
  });
}

module.exports = { server, listen, lanAddress, PORT, HOST };
