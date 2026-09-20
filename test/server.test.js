'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const dex = require('../server/showdown');
const battles = require('../server/battles');
const { samplesFor } = require('../server/sample-teams');

const CLASSIC = 'gen9vgc2025regi';
const CHAMPIONS = 'gen9championsvgc2026regmb';
const CHAMPIONS_BO3 = 'gen9championsvgc2026regmbbo3';
const teamFile = (name) => readFileSync(join(__dirname, '..', 'server', 'teams', name), 'utf8');

let targeting;
test.before(async () => {
  targeting = await import('../public/assets/targeting.js');
});

test('only VGC formats are offered, and all of them are doubles', () => {
  const formats = dex.formats();
  assert.ok(formats.length >= 6);
  for (const format of formats) {
    assert.match(format.id, /vgc/, `${format.id} is not a VGC format`);
    assert.equal(format.gameType, 'doubles');
    assert.equal(format.level, 50);
    assert.equal(format.bring, 4);
    assert.equal(format.teamSize, 6);
  }
  assert.ok(!formats.some((f) => f.id === 'gen9ou' || f.id === 'gen9randombattle'));
});

test('the two rule systems are described differently', () => {
  const classic = dex.formatById(CLASSIC);
  assert.equal(classic.champions, false);
  assert.deepEqual(
    { label: classic.stats.label, perStat: classic.stats.perStat },
    { label: 'EVs', perStat: 252 }
  );

  const champions = dex.formatById(CHAMPIONS);
  assert.equal(champions.champions, true);
  assert.equal(champions.stats.label, 'Stat Points');
  assert.equal(champions.stats.perStat, 32);
  assert.equal(champions.stats.total, 66);

  assert.equal(dex.formatById(CHAMPIONS_BO3).bestOf, 3);
  assert.equal(champions.bestOf, 0);
});

test('Champions is a different game, with its own pool', () => {
  const classic = dex.dexFor(CLASSIC);
  const champions = dex.dexFor(CHAMPIONS);
  assert.ok(classic.species.length > champions.species.length);
  const names = (d) => new Set(d.species.map((s) => s.name));
  assert.ok(names(classic).has('Flutter Mane'));
  assert.ok(!names(champions).has('Flutter Mane'), 'Champions has no paradox Pokémon');
  assert.ok([...names(champions)].some((n) => n.includes('-Mega')), 'Champions brings Mega Evolutions back');
  assert.equal(champions.format.stats.perStat, 32);
});

test('the sample teams really are legal where they are offered', () => {
  for (const format of dex.formats()) {
    for (const sample of samplesFor(format.id)) {
      const check = dex.validate(format.id, sample.paste);
      assert.equal(check.ok, true, `${sample.name} is not legal in ${format.id}: ${check.problems}`);
      assert.equal(check.count, 6);
    }
  }
  assert.ok(samplesFor(CLASSIC).length, 'Reg I should have a sample');
  assert.ok(samplesFor(CHAMPIONS).length, 'Champions should have a sample');
});

test('validation enforces each format s own stat cap', () => {
  const champTeam = teamFile('champions-vgc.txt');
  assert.equal(dex.validate(CHAMPIONS, champTeam).ok, true);

  // A classic 252 spread is far over the Champions cap of 32.
  const over = champTeam.replace('EVs: 20 HP / 12 Atk / 12 Def / 10 SpD / 12 Spe', 'EVs: 252 HP / 252 Atk');
  const result = dex.validate(CHAMPIONS, over);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /32 Stat Points/);

  // And the classic team is rejected outright by Champions' species pool.
  const classicInChampions = dex.validate(CHAMPIONS, teamFile('classic-vgc.txt'));
  assert.equal(classicInChampions.ok, false);
});

test('doubles targeting matches the engine', () => {
  const { needsTarget, targetOptions, validTargetLoc } = targeting;
  assert.equal(needsTarget('normal', 2), true);
  assert.equal(needsTarget('self', 2), false);
  assert.equal(needsTarget('allAdjacentFoes', 2), false);
  assert.equal(needsTarget('normal', 1), false, 'singles never needs a location');

  const locs = (type, slot) => targetOptions({ slotIndex: slot, activeCount: 2, targetType: type }).map((o) => o.loc);
  assert.deepEqual(locs('normal', 0), [1, 2, -2], 'both foes and your ally');
  assert.deepEqual(locs('normal', 1), [1, 2, -1]);
  assert.deepEqual(locs('adjacentFoe', 0), [1, 2]);
  assert.deepEqual(locs('adjacentAlly', 0), [-2], 'the ally only, never yourself');
  assert.deepEqual(locs('adjacentAllyOrSelf', 0), [-1, -2]);
  assert.deepEqual(locs('self', 0), []);

  assert.equal(validTargetLoc(0, -1, 2, 'normal'), true, 'no location is always allowed');
  assert.equal(validTargetLoc(3, -1, 2, 'normal'), false, 'off the field');
});

/** Answers whatever the engine asks, the way the page does. */
function autoChoice(request, { needsTarget, targetOptions }) {
  if (request.teamPreview) {
    const n = request.maxChosenTeamSize || request.side.pokemon.length;
    return `team ${Array.from({ length: n }, (_, i) => i + 1).join(',')}`;
  }
  if (request.forceSwitch) {
    const used = new Set();
    return request.forceSwitch.map((need) => {
      if (!need) return 'pass';
      const idx = request.side.pokemon.findIndex((p, i) => !p.active && !p.condition.endsWith(' fnt') && !used.has(i));
      if (idx < 0) return 'pass';
      used.add(idx);
      return `switch ${idx + 1}`;
    }).join(', ');
  }
  const active = request.active || [];
  return active.map((slot, i) => {
    const mine = request.side.pokemon[i];
    if (!slot || slot.commanding || (mine && mine.condition.endsWith(' fnt'))) return 'pass';
    const found = slot.moves.findIndex((m) => !m.disabled && m.pp !== 0);
    const index = found >= 0 ? found : 0;
    const move = slot.moves[index];
    if (!needsTarget(move.target, active.length)) return `move ${index + 1}`;
    const options = targetOptions({ slotIndex: i, activeCount: active.length, targetType: move.target });
    const foe = options.find((o) => o.side === 'foe') || options[0];
    return `move ${index + 1} ${foe.loc}`;
  }).join(', ');
}

async function playOut(session, limit = 2000) {
  let guard = 0;
  while (!session.ended && guard++ < limit) {
    if (!session.request) {
      await session.settled();
      if (!session.request) break;
    }
    session.choose(autoChoice(session.request, targeting));
    await session.settled();
  }
  return session;
}

test('a doubles battle runs from team preview to a winner', async () => {
  const session = await battles.create({ formatId: CLASSIC, team: teamFile('classic-vgc.txt') });
  assert.equal(session.request.teamPreview, true);
  assert.equal(session.request.maxChosenTeamSize, 4);
  assert.equal(session.request.side.pokemon.length, 6);

  session.choose('team 1,2,3,4');
  await session.settled();
  assert.equal(session.request.active.length, 2, 'doubles puts two Pokémon up');
  assert.ok(session.log.some((l) => l.startsWith('|switch|p1b:')), 'a second slot should be sent out');

  await playOut(session);
  assert.equal(session.ended, true, `did not finish (error: ${session.error})`);
  assert.ok(session.log.some((l) => l.startsWith('|win|') || l === '|tie'));
});

test('a best-of-three plays its games back to back and keeps a set score', async () => {
  const session = await battles.create({
    formatId: CHAMPIONS_BO3,
    team: teamFile('champions-vgc.txt'),
    bestOf: 3,
  });
  await playOut(session);
  assert.equal(session.ended, true, `the set did not finish (error: ${session.error})`);
  assert.ok(session.gameNumber >= 2, `a best-of-three needs at least two games, played ${session.gameNumber}`);
  assert.ok(session.gameNumber <= 3);
  assert.equal(Math.max(session.score.you, session.score.foe), 2, 'a set ends at two wins');
  assert.equal(session.score.you + session.score.foe, session.gameNumber);
  const markers = session.log.filter((l) => l.startsWith('|aether-game|'));
  assert.equal(markers.length, session.gameNumber - 1, 'each game after the first is marked');
  assert.ok(session.winner === 'You' || session.winner === 'AetherAI');
});

test('|tier| is not mistaken for a tie', async () => {
  const session = await battles.create({ formatId: CLASSIC, team: teamFile('classic-vgc.txt') });
  assert.ok(session.log.some((l) => l.startsWith('|tier|')));
  assert.equal(session.ended, false);
  assert.equal(session.winner, null);
});

test('a choice the engine refuses leaves something to click', async () => {
  const session = await battles.create({ formatId: CLASSIC, team: teamFile('classic-vgc.txt') });
  session.choose('team 1,2,3,4');
  await session.settled();
  assert.ok(session.request.active, 'expected a move request');

  session.choose('move 1, move 1');   // a doubles move that needs a target, sent without one
  await session.settled();
  assert.ok(session.error, 'the engine should have refused that');
  assert.ok(session.request, 'the player must still have a choice to make');
  assert.equal(session.ended, false);

  assert.throws(() => session.choose('rm -rf /'), /not a valid choice/);
});

test('learnsets and the dex still come from the engine', () => {
  const moves = dex.movesFor('greattusk', CLASSIC).map((m) => m.name);
  assert.ok(moves.includes('Headlong Rush'));
  assert.ok(!moves.includes('Hydro Pump'));
  assert.ok(dex.dexFor(CLASSIC).moveCount > 500);
});

test('the site serves its pages and API over http', async () => {
  const site = require('../server/index.js');
  const { port } = await site.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const [path, needle] of [['/', 'AetherAI'], ['/teams', 'Team Builder'], ['/battle', 'Challenge AetherAI']]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, `${path} should render`);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.match(await res.text(), new RegExp(needle));
    }

    const formats = await (await fetch(`${base}/api/formats`)).json();
    assert.ok(formats.formats.every((f) => f.gameType === 'doubles'));

    const samples = await (await fetch(`${base}/api/sampleteams?format=${CLASSIC}`)).json();
    assert.ok(samples.teams.length, 'Reg I should offer a sample team');

    // A battle needs a legal team, and says so rather than failing obscurely.
    const noTeam = await fetch(`${base}/api/battle`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: CLASSIC, paste: '' }),
    });
    assert.equal(noTeam.status, 400);
    assert.match((await noTeam.json()).error, /needs a team/);

    const illegal = await fetch(`${base}/api/battle`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: CHAMPIONS, paste: teamFile('classic-vgc.txt') }),
    });
    assert.equal(illegal.status, 400);
    assert.ok((await illegal.json()).problems.length, 'the validator problems should come back');

    const started = await (await fetch(`${base}/api/battle`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: CLASSIC, paste: samples.teams[0].paste }),
    })).json();
    assert.ok(started.id);
    assert.equal(started.request.teamPreview, true);

    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  } finally {
    await new Promise((done) => site.server.close(done));
  }
});

test('the public link is read out of cloudflared s own output', () => {
  const { parseTunnelUrl } = require('../scripts/share.js');
  assert.equal(
    parseTunnelUrl('2026-09-20T02:17:35Z INF |  https://neat-words-here.trycloudflare.com  |'),
    'https://neat-words-here.trycloudflare.com'
  );
  assert.equal(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), null);
  assert.equal(parseTunnelUrl('ERR Host not in allowlist: api.trycloudflare.com'), null);
  assert.equal(parseTunnelUrl(''), null);
});

test('the LAN address is a real address or nothing', () => {
  const { lanAddress } = require('../server/index.js');
  const lan = lanAddress();
  if (lan !== null) {
    assert.match(lan, /^\d+\.\d+\.\d+\.\d+$/);
    assert.ok(!lan.startsWith('127.'), 'loopback is not a LAN address');
  }
});

test('the Codespaces container is configured to actually serve the site', () => {
  const raw = readFileSync(join(__dirname, '..', '.devcontainer', 'devcontainer.json'), 'utf8');
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));   // JSONC: strip line comments

  assert.equal(config.postCreateCommand, 'npm run setup', 'the engine must be built on creation');
  assert.deepEqual(config.forwardPorts, [3000]);
  assert.equal(config.portsAttributes['3000'].label, 'AetherAI');

  // The forwarded port only works if the server listens on every interface.
  const start = config.postAttachCommand.server;
  assert.match(start, /HOST=0\.0\.0\.0/, 'binding to loopback would not be reachable through the port forward');
  assert.match(start, /server\/index\.js/);
  assert.match(String(config.image), /node/);
});
