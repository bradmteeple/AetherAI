'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dex = require('../server/showdown');
const battles = require('../server/battles');

test('formats are real, playable and carry their game type', () => {
  const formats = dex.formats();
  assert.ok(formats.length >= 10, 'expected a healthy list of formats');
  const ou = formats.find((f) => f.id === 'gen9ou');
  assert.equal(ou.gameType, 'singles');
  assert.equal(ou.random, false);
  assert.equal(formats.find((f) => f.id === 'gen9randombattle').random, true);
  for (const format of formats) assert.ok(format.name && !format.name.startsWith('[Gen'));
});

test('the dex payload is populated from the engine', () => {
  const data = dex.dexFor('gen9ou');
  assert.ok(data.species.length > 800);
  assert.ok(data.items.length > 100);
  assert.equal(data.natures.length, 25);
  assert.ok(data.moveCount > 500);
  const tusk = data.species.find((s) => s.id === 'greattusk');
  assert.deepEqual(tusk.types, ['Ground', 'Fighting']);
  assert.equal(tusk.bst, Object.values(tusk.baseStats).reduce((a, b) => a + b, 0));
  assert.ok(tusk.abilities.includes('Protosynthesis'));
});

test('learnsets come from the cartridge, not a guess', () => {
  const moves = dex.movesFor('greattusk');
  const names = moves.map((m) => m.name);
  assert.ok(names.includes('Headlong Rush'));
  assert.ok(names.includes('Rapid Spin'));
  assert.ok(!names.includes('Hydro Pump'), 'Great Tusk cannot learn Hydro Pump');
  const rush = moves.find((m) => m.name === 'Headlong Rush');
  assert.equal(rush.type, 'Ground');
  assert.equal(rush.category, 'Physical');
});

const LEGAL_SET = [
  'Great Tusk @ Booster Energy',
  'Ability: Protosynthesis',
  'Tera Type: Steel',
  'EVs: 252 Atk / 4 Def / 252 Spe',
  'Jolly Nature',
  '- Headlong Rush',
  '- Close Combat',
  '- Ice Spinner',
  '- Rapid Spin',
].join('\n');

test('validation accepts a legal set and explains an illegal one', () => {
  const ok = dex.validate('gen9ou', LEGAL_SET);
  assert.equal(ok.ok, true, `expected legal, got: ${ok.problems}`);
  assert.equal(ok.count, 1);

  const bad = dex.validate('gen9ou', LEGAL_SET.replace('Headlong Rush', 'Hydro Pump'));
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(' '), /can't learn Hydro Pump/);

  assert.equal(dex.validate('gen9ou', '').ok, false);
  assert.match(dex.validate('notaformat', LEGAL_SET).problems.join(' '), /Unknown format/);
});

test('a battle runs from the first request to a winner', async () => {
  const session = await battles.create({ formatId: 'gen9randombattle' });
  assert.equal(session.ended, false, 'a fresh battle must not report itself over');
  assert.ok(session.request, 'the engine should be waiting on a choice');
  assert.ok(session.log.length > 5);

  let picks = 0;
  while (!session.ended && picks < 300) {
    const request = session.request;
    if (!request) break;
    let choice = 'default';
    if (request.forceSwitch) {
      const slot = request.side.pokemon.findIndex((p, i) => i > 0 && !p.active && !p.condition.endsWith(' fnt'));
      choice = slot >= 0 ? `switch ${slot + 1}` : 'default';
    } else if (request.active?.[0]) {
      // Pick like a real client would: the first move that is actually usable.
      const usable = request.active[0].moves.findIndex((m) => !m.disabled && m.pp !== 0);
      choice = `move ${usable >= 0 ? usable + 1 : 1}`;
    }
    session.choose(choice);
    await session.settled();
    picks += 1;
  }

  assert.equal(session.ended, true, `the battle should reach an end (stopped after ${picks} picks, last error: ${session.error})`);
  assert.ok(session.log.some((l) => l.startsWith('|win|') || l === '|tie'));
  assert.ok(picks > 0, 'the battle should have taken at least one choice');
});

test('|tier| is not mistaken for a tie', async () => {
  // `|tier|[Gen 9] Random Battle` shares a prefix with `|tie`; treating it as a
  // tie ended every battle on its first line.
  const session = await battles.create({ formatId: 'gen9randombattle' });
  assert.ok(session.log.some((l) => l.startsWith('|tier|')), 'the format line should be present');
  assert.equal(session.ended, false);
  assert.equal(session.winner, null);
});

test('a battle rejects nonsense choices', async () => {
  const session = await battles.create({ formatId: 'gen9randombattle' });
  assert.throws(() => session.choose('rm -rf /'), /not a valid choice/);
});

test('a choice the engine refuses leaves something to click', async () => {
  // The engine answers a bad choice with |error| and no new |request|; without
  // restoring the last request the battle would hang with no buttons.
  const session = await battles.create({ formatId: 'gen9randombattle' });
  const before = session.request;
  assert.ok(before?.active, 'expected a move request to start with');
  session.choose('switch 1');   // switching to the Pokémon already out is illegal
  await session.settled();
  assert.ok(session.error, 'the engine should have refused that');
  assert.ok(session.request, 'the player must still have a choice to make');
  assert.equal(session.ended, false);
});
