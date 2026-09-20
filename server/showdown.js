'use strict';
/**
 * Everything this site knows about Pokémon comes from the vendored Showdown
 * engine: the same dex, learnsets and team validator the real server runs.
 */
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const VENDOR = join(__dirname, '..', 'vendor', 'pokemon-showdown');
const DIST = join(VENDOR, 'dist', 'sim');

if (!existsSync(DIST)) {
  throw new Error(
    `The vendored Showdown engine is not built yet.\n` +
    `Run:  npm run setup   (cd vendor/pokemon-showdown && npm install && node build)`
  );
}

const { Dex, Teams, TeamValidator } = require(DIST);

/**
 * VGC only. Two rule systems live here: the classic regulations (EVs, 252 per
 * stat) and Pokémon Champions (Stat Points, 32 per stat, its own species and
 * item pools). Both are doubles, level 50, bring 4 of 6.
 */
const FORMAT_ALLOWLIST = [
  'gen9championsvgc2026regmc',
  'gen9championsvgc2026regmcbo3',
  'gen9championsvgc2026regmb',
  'gen9championsvgc2026regmbbo3',
  'gen9vgc2025regi',
  'gen9vgc2024regg',
  'gen9vgc2023regd',
  'gen9vgc2023regc',
];

/** Champions counts Stat Points, not EVs — a different cap and a different name. */
function statRules(dex, ruleTable) {
  const statPoints = dex.currentMod.startsWith('champions');
  return statPoints
    ? { label: 'Stat Points', short: 'SP', perStat: 32, total: ruleTable.evLimit ?? 66, statPoints: true }
    : { label: 'EVs', short: 'EVs', perStat: 252, total: ruleTable.evLimit ?? 510, statPoints: false };
}

function displayName(format) {
  if (format.name.startsWith('[Gen 9 Champions]')) return `Champions ${format.name.replace('[Gen 9 Champions] ', '')}`;
  return format.name.replace(/^\[Gen \d+\]\s*/, '');
}

let formatCache = null;

function formats() {
  if (formatCache) return formatCache;
  const out = [];
  for (const id of FORMAT_ALLOWLIST) {
    const format = Dex.formats.get(id);
    if (!format.exists) continue;
    const ruleTable = Dex.formats.getRuleTable(format);
    const dex = Dex.forFormat(format);
    out.push({
      id: format.id,
      name: displayName(format),
      fullName: format.name,
      gameType: format.gameType,
      champions: dex.currentMod.startsWith('champions'),
      bring: ruleTable.pickedTeamSize ?? 4,
      teamSize: 6,
      level: ruleTable.adjustLevel ?? 50,
      bestOf: /bo3$/.test(format.id) ? 3 : 0,
      stats: statRules(dex, ruleTable),
    });
  }
  formatCache = out;
  return out;
}

const formatById = (id) => formats().find((f) => f.id === id) || null;

const dexCache = new Map();

/** The whole searchable dex for one format, built once and reused. */
function dexFor(formatId) {
  if (dexCache.has(formatId)) return dexCache.get(formatId);
  const format = Dex.formats.get(formatId);
  const dex = Dex.forFormat(format.exists ? format : Dex.formats.get('gen9ou'));

  const species = dex.species.all()
    .filter((s) => s.exists && s.num > 0 && !s.isNonstandard && s.tier !== 'Illegal')
    .map((s) => ({
      id: s.id,
      name: s.name,
      num: s.num,
      types: s.types,
      baseStats: s.baseStats,
      abilities: Object.values(s.abilities).filter(Boolean),
      bst: Object.values(s.baseStats).reduce((a, b) => a + b, 0),
      tier: s.tier,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const items = dex.items.all()
    .filter((i) => i.exists && !i.isNonstandard)
    .map((i) => ({ id: i.id, name: i.name, desc: i.shortDesc || i.desc || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const natures = dex.natures.all().map((n) => ({
    id: n.id, name: n.name, plus: n.plus || null, minus: n.minus || null,
  })).sort((a, b) => a.name.localeCompare(b.name));

  const moveCount = dex.moves.all().filter((m) => m.exists && !m.isNonstandard).length;
  const payload = {
    formatId,
    species,
    items,
    natures,
    types: dex.types.names(),
    moveCount,
    format: formatById(formatId),
  };
  dexCache.set(formatId, payload);
  return payload;
}

let moveDexCache = null;

/** id → type/category/power, so the battle UI can label move buttons. */
function moveDex() {
  if (moveDexCache) return moveDexCache;
  moveDexCache = {};
  for (const move of Dex.moves.all()) {
    if (!move.exists) continue;
    moveDexCache[move.id] = {
      type: move.type,
      category: move.category,
      basePower: move.basePower,
      accuracy: move.accuracy === true ? null : move.accuracy,
    };
  }
  return moveDexCache;
}

const learnsetCache = new Map();

/** Every move a species can legally have in this generation, with its data. */
function movesFor(speciesId, formatId = 'gen9ou') {
  const key = `${formatId}:${speciesId}`;
  if (learnsetCache.has(key)) return learnsetCache.get(key);
  const dex = Dex.forFormat(Dex.formats.get(formatId));
  const species = dex.species.get(speciesId);
  if (!species.exists) return [];

  const gen = String(dex.gen);
  const ids = new Set();
  let learnsets = [];
  try {
    learnsets = dex.species.getFullLearnset(species.id);
  } catch {
    learnsets = [];
  }
  for (const entry of learnsets) {
    for (const [moveId, sources] of Object.entries(entry.learnset || {})) {
      if (sources.some((src) => src.startsWith(gen))) ids.add(moveId);
    }
  }

  const moves = [...ids]
    .map((id) => dex.moves.get(id))
    .filter((m) => m.exists && !m.isNonstandard)
    .map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      category: m.category,
      basePower: m.basePower,
      accuracy: m.accuracy === true ? '—' : m.accuracy,
      pp: m.pp,
      desc: m.shortDesc || m.desc || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  learnsetCache.set(key, moves);
  return moves;
}

/** Run the real Showdown validator over a Showdown-format paste. */
function validate(formatId, paste) {
  let team;
  try {
    team = Teams.import(paste);
  } catch (err) {
    return { ok: false, problems: [`Could not read that team: ${err.message}`] };
  }
  if (!team || !team.length) return { ok: false, problems: ['That team is empty.'] };

  const format = Dex.formats.get(formatId);
  if (!format.exists) return { ok: false, problems: [`Unknown format "${formatId}".`] };

  let problems;
  try {
    problems = new TeamValidator(format.id).validateTeam(team);
  } catch (err) {
    return { ok: false, problems: [err.message] };
  }
  return { ok: !problems, problems: problems || [], count: team.length };
}

module.exports = { Dex, Teams, TeamValidator, formats, formatById, dexFor, movesFor, moveDex, validate, VENDOR, DIST };
