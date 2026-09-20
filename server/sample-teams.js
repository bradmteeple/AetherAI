'use strict';
/**
 * Two ready-made teams so a battle can start without building one first: the
 * classic regulations and Champions use different species, items and stat
 * systems, so each rule system needs its own.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { formatById, validate } = require('./showdown');

const read = (file) => readFileSync(join(__dirname, 'teams', file), 'utf8');

const SAMPLES = [
  { id: 'classic', name: 'Sample: Rain-free Goodstuff', file: 'classic-vgc.txt', champions: false },
  { id: 'champions', name: 'Sample: Champions Goodstuff', file: 'champions-vgc.txt', champions: true },
];

const cache = new Map();

/** The sample teams that are actually legal in this format, checked not assumed. */
function samplesFor(formatId) {
  if (cache.has(formatId)) return cache.get(formatId);
  const format = formatById(formatId);
  const out = [];
  if (format) {
    for (const sample of SAMPLES) {
      if (sample.champions !== format.champions) continue;
      const paste = read(sample.file);
      const check = validate(formatId, paste);
      if (check.ok) out.push({ id: sample.id, name: sample.name, paste });
    }
  }
  cache.set(formatId, out);
  return out;
}

module.exports = { samplesFor };
