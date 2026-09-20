import { el, $, setKids, api, typeClass, loadTeams, saveTeams, toast } from '/assets/common.js';

const STATS = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];

const state = {
  format: 'gen9vgc2025regi',
  dex: null,
  formats: [],
  slots: Array.from({ length: 6 }, () => null),
  selected: 0,
  moveCache: new Map(),
};

const emptySet = (species) => ({
  species: species.name,
  speciesId: species.id,
  item: '',
  ability: species.abilities[0] || '',
  teraType: species.types[0] || 'Normal',
  level: rules().level,
  nature: 'Hardy',
  evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
  moves: ['', '', '', ''],
});

const speciesById = (id) => state.dex.species.find((s) => s.id === id);
const rules = () => state.dex?.format || { level: 50, bring: 4, teamSize: 6, stats: { label: 'EVs', perStat: 252, total: 510, statPoints: false } };
const statRules = () => rules().stats;

/* ---------- Showdown paste format ---------- */

function exportSet(set) {
  const species = speciesById(set.speciesId);
  if (!species) return '';
  const lines = [];
  lines.push(set.item ? `${set.species} @ ${set.item}` : set.species);
  if (set.ability) lines.push(`Ability: ${set.ability}`);
  if (set.level !== 100) lines.push(`Level: ${set.level}`);
  if (set.teraType) lines.push(`Tera Type: ${set.teraType}`);
  const evs = STATS.filter(([k]) => set.evs[k] > 0).map(([k, label]) => `${set.evs[k]} ${label}`);
  if (evs.length) lines.push(`EVs: ${evs.join(' / ')}`);
  if (set.nature) lines.push(`${set.nature} Nature`);
  for (const move of set.moves) if (move) lines.push(`- ${move}`);
  return lines.join('\n');
}

const exportTeam = () => state.slots.filter(Boolean).map(exportSet).filter(Boolean).join('\n\n');

function parsePaste(text) {
  const blocks = text.trim().split(/\n\s*\n/).filter((b) => b.trim());
  const slots = Array.from({ length: 6 }, () => null);
  blocks.slice(0, 6).forEach((block, i) => {
    const lines = block.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const [head, ...rest] = lines;
    const [namePart, itemPart] = head.split('@').map((s) => s.trim());
    const name = namePart.replace(/\s*\(M\)|\s*\(F\)/g, '').replace(/^.*\((.+)\)$/, '$1').trim();
    const species = state.dex.species.find(
      (s) => s.name.toLowerCase() === name.toLowerCase() || s.id === name.toLowerCase().replace(/[^a-z0-9]/g, '')
    );
    if (!species) return;
    const set = emptySet(species);
    if (itemPart) set.item = itemPart;
    for (const line of rest) {
      if (line.startsWith('- ')) {
        const idx = set.moves.findIndex((m) => !m);
        if (idx >= 0) set.moves[idx] = line.slice(2).trim();
      } else if (/^Ability:/i.test(line)) set.ability = line.split(':')[1].trim();
      else if (/^Level:/i.test(line)) set.level = Number(line.split(':')[1].trim()) || 100;
      else if (/^Tera Type:/i.test(line)) set.teraType = line.split(':')[1].trim();
      else if (/^EVs:/i.test(line)) {
        for (const part of line.slice(4).split('/')) {
          const m = /(\d+)\s+(\w+)/.exec(part.trim());
          if (!m) continue;
          const key = STATS.find(([, label]) => label.toLowerCase() === m[2].toLowerCase());
          if (key) set.evs[key[0]] = Number(m[1]);
        }
      } else if (/Nature$/i.test(line)) set.nature = line.replace(/Nature$/i, '').trim();
    }
    slots[i] = set;
  });
  return slots;
}

/* ---------- rendering ---------- */

function renderRoster() {
  const host = $('#roster');
  host.replaceChildren(...state.slots.map((set, i) => {
    const species = set && speciesById(set.speciesId);
    return el('button', {
      class: 'slot',
      'aria-selected': String(i === state.selected),
      onclick: () => { state.selected = i; renderRoster(); renderEditor(); },
    },
      el('span', { class: 'idx', text: `Slot ${i + 1}` }),
      species
        ? el('span', { class: 'name', text: species.name })
        : el('span', { class: 'empty-name', text: 'Empty' }),
      species && el('span', { class: 'types' }, ...species.types.map((t) => el('span', { class: typeClass(t), text: t }))),
      set && el('span', { class: 'meta', text: set.moves.filter(Boolean).join(', ') || 'No moves yet' }),
    );
  }));
}

function renderSpeciesList() {
  const query = $('#search').value.trim().toLowerCase();
  const matches = state.dex.species.filter((s) =>
    !query || s.name.toLowerCase().includes(query) || s.types.some((t) => t.toLowerCase() === query)
  );
  $('#pickerCount').textContent = `${matches.length} of ${state.dex.species.length}`;
  const shown = matches.slice(0, 300);
  $('#speciesList').replaceChildren(...(shown.length ? shown.map((s) =>
    el('button', { class: 'mon-row', onclick: () => choose(s) },
      el('span', { class: 'mon-name', text: s.name }),
      ...s.types.map((t) => el('span', { class: typeClass(t), text: t.slice(0, 3) })),
      el('span', { class: 'bst', text: s.bst }),
    )) : [el('p', { class: 'empty', text: 'Nothing matches that search.' })]));
}

function choose(species) {
  state.slots[state.selected] = emptySet(species);
  renderRoster();
  renderEditor();
  syncPaste();
}

async function movesFor(speciesId) {
  const key = `${state.format}:${speciesId}`;
  if (state.moveCache.has(key)) return state.moveCache.get(key);
  const data = await api(`/api/moves?species=${encodeURIComponent(speciesId)}&format=${encodeURIComponent(state.format)}`);
  state.moveCache.set(key, data.moves);
  return data.moves;
}

function statBars(species, set) {
  const nature = state.dex.natures.find((n) => n.name === set.nature);
  return el('div', { class: 'stat-bars' }, ...STATS.map(([key, label]) => {
    const base = species.baseStats[key];
    const ev = set.evs[key];
    let value = key === 'hp'
      ? Math.floor((2 * base + 31 + Math.floor(ev / 4)) * set.level / 100) + set.level + 10
      : Math.floor((Math.floor((2 * base + 31 + Math.floor(ev / 4)) * set.level / 100) + 5) *
          (nature?.plus === key ? 1.1 : nature?.minus === key ? 0.9 : 1));
    if (species.id === 'shedinja' && key === 'hp') value = 1;
    return el('div', { class: 'stat-bar' },
      el('span', { class: 'lbl', text: label }),
      el('span', { class: 'track' }, el('span', { class: 'fill', style: `width:${Math.min(100, (base / 200) * 100)}%` })),
      el('span', { class: 'val', text: value }),
    );
  }));
}

async function renderEditor() {
  const host = $('#editor');
  const set = state.slots[state.selected];
  $('#editorTitle').textContent = set ? set.species : `Slot ${state.selected + 1}`;
  if (!set) {
    host.replaceChildren(el('p', { class: 'editor-empty', text: 'Pick a Pokémon from the list to fill this slot.' }));
    return;
  }
  const species = speciesById(set.speciesId);
  host.replaceChildren(el('p', { class: 'editor-empty', text: 'Loading moves…' }));
  const moves = await movesFor(set.speciesId);
  if (state.slots[state.selected] !== set) return; // the slot changed while moves loaded

  // Built once per slot. Anything that changes afterwards refreshes only the
  // part it affects — rebuilding the whole editor would interrupt a slider drag.
  const statsHost = el('div', {});
  const evTotalNode = el('div', { class: 'ev-total' });
  const moveHints = set.moves.map(() => el('div', { class: 'move-hint' }));

  const refreshStats = () => {
    statsHost.replaceChildren(statBars(species, set));
    const cap = statRules().total;
    const total = STATS.reduce((sum, [k]) => sum + set.evs[k], 0);
    evTotalNode.className = `ev-total ${total > cap ? 'over' : ''}`;
    setKids(evTotalNode,
      el('span', { text: 'Spent' }),
      el('b', { text: `${total} / ${cap}` }),
      total > cap ? el('span', { style: 'color:var(--bad)', text: 'over the limit' }) : null);
  };

  const refreshMoveHint = (slot) => {
    const picked = moves.find((m) => m.name === set.moves[slot]);
    moveHints[slot].replaceChildren(...(picked ? [
      el('span', { class: typeClass(picked.type), text: picked.type }),
      el('span', { class: 'cat', text: picked.category }),
      el('span', { text: picked.basePower ? `${picked.basePower} BP` : '—' }),
      el('span', { text: picked.accuracy === '—' ? '—' : `${picked.accuracy}%` }),
    ] : []));
  };

  const touched = () => { syncPaste(); renderRoster(); };

  host.replaceChildren(
    el('div', { class: 'grid-3' },
      el('label', { class: 'field' }, el('span', { text: 'Ability' }),
        el('select', { onchange: (e) => { set.ability = e.target.value; touched(); } },
          ...species.abilities.map((a) => el('option', { value: a, selected: a === set.ability, text: a })))),
      el('label', { class: 'field' }, el('span', { text: 'Item' }),
        el('select', { onchange: (e) => { set.item = e.target.value; touched(); } },
          el('option', { value: '', selected: !set.item, text: '— none —' }),
          ...state.dex.items.map((i) => el('option', { value: i.name, selected: i.name === set.item, text: i.name })))),
      el('label', { class: 'field' }, el('span', { text: 'Tera type' }),
        el('select', { onchange: (e) => { set.teraType = e.target.value; touched(); } },
          ...state.dex.types.map((t) => el('option', { value: t, selected: t === set.teraType, text: t })))),
    ),
    el('div', { class: 'grid-3' },
      el('label', { class: 'field' }, el('span', { text: 'Nature' }),
        el('select', { onchange: (e) => { set.nature = e.target.value; refreshStats(); touched(); } },
          ...state.dex.natures.map((n) => el('option', {
            value: n.name, selected: n.name === set.nature,
            text: n.plus ? `${n.name} (+${n.plus} −${n.minus})` : `${n.name} (neutral)`,
          })))),
      el('label', { class: 'field' }, el('span', { text: 'Level' }),
        el('input', { type: 'number', min: '1', max: '100', value: set.level,
          onchange: (e) => {
            set.level = Math.min(100, Math.max(1, Number(e.target.value) || 100));
            e.target.value = set.level;
            refreshStats(); touched();
          } })),
      el('div', { class: 'field' }, el('span', { text: 'Base stat total' }),
        el('p', { style: 'margin:0;font-size:20px;font-family:var(--display);color:var(--gold)', text: species.bst })),
    ),
    el('div', {},
      el('span', { class: 'eyebrow', style: 'display:block;margin-bottom:10px', text: 'Moves' }),
      el('div', { class: 'moves-grid' }, ...set.moves.map((chosen, slot) =>
        el('div', { class: 'move-pick' },
          el('select', { onchange: (e) => { set.moves[slot] = e.target.value; refreshMoveHint(slot); touched(); } },
            el('option', { value: '', selected: !chosen, text: `— move ${slot + 1} —` }),
            ...moves.map((m) => el('option', { value: m.name, selected: m.name === chosen, text: m.name }))),
          moveHints[slot]))),
    ),
    el('div', { class: 'grid-2' },
      el('div', {},
        el('span', { class: 'eyebrow', style: 'display:block;margin-bottom:10px', text: statRules().label }),
        el('div', { class: 'evs' }, ...STATS.map(([key, label]) => {
          const output = el('output', { text: set.evs[key] });
          return el('div', { class: 'ev-row' },
            el('label', { text: label }),
            el('input', {
              type: 'range', min: '0', max: String(statRules().perStat), step: statRules().statPoints ? '1' : '4', value: set.evs[key],
              oninput: (e) => {
                set.evs[key] = Number(e.target.value);
                output.textContent = set.evs[key];
                refreshStats();
                touched();
              },
            }),
            output);
        })),
        evTotalNode,
      ),
      el('div', {},
        el('span', { class: 'eyebrow', style: 'display:block;margin-bottom:10px', text: `Stats at level ${set.level}` }),
        statsHost),
    ),
  );

  refreshStats();
  set.moves.forEach((_, slot) => refreshMoveHint(slot));
}

/* ---------- paste + validation ---------- */

let pasteDirty = false;
function syncPaste() {
  if (pasteDirty) return;
  $('#paste').value = exportTeam();
}

async function validate() {
  const paste = $('#paste').value.trim();
  const host = $('#verdict');
  if (!paste) {
    host.replaceChildren(el('div', { class: 'notice notice-bad', text: 'Nothing to validate yet — add a Pokémon first.' }));
    return null;
  }
  host.replaceChildren(el('div', { class: 'notice', text: 'Checking with the Showdown validator…' }));
  try {
    const result = await api('/api/validate', { method: 'POST', body: { format: state.format, paste } });
    setKids(host, result.ok
      ? el('div', { class: 'notice notice-good', text: `Legal for ${formatName()} — ${result.count} Pokémon.` })
      : el('div', { class: 'notice notice-bad' },
          el('b', { text: `Not legal for ${formatName()}:` }),
          el('ul', {}, ...result.problems.map((p) => el('li', { text: p })))));
    return result;
  } catch (err) {
    host.replaceChildren(el('div', { class: 'notice notice-bad', text: err.message }));
    return null;
  }
}

const formatName = () => state.formats.find((f) => f.id === state.format)?.name || state.format;

/* ---------- saved teams ---------- */

function renderSaved() {
  const teams = loadTeams();
  $('#savedCount').textContent = teams.length;
  const host = $('#saved');
  if (!teams.length) {
    host.replaceChildren(el('p', { class: 'empty', text: 'No saved teams yet. Build one and press Save team.' }));
    return;
  }
  host.replaceChildren(...teams.map((team, i) =>
    el('div', { class: 'saved-row' },
      el('span', { class: 's-name', text: team.name }),
      el('span', { class: 's-meta', text: `${team.format} · ${team.count} Pokémon` }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn-sm', onclick: () => {
        state.format = team.format;
        $('#format').value = team.format;
        $('#teamName').value = team.name;
        void loadDex().then(() => {
          state.slots = parsePaste(team.paste);
          pasteDirty = false;
          syncPaste();
          renderRoster();
          void renderEditor();
          toast(`Loaded ${team.name}`);
        });
      }, text: 'Load' }),
      el('button', { class: 'btn-sm', onclick: () => {
        const rest = loadTeams().filter((_, j) => j !== i);
        saveTeams(rest);
        renderSaved();
      }, text: 'Delete' }),
    )));
}

/* ---------- boot ---------- */

async function loadDex() {
  state.dex = await api(`/api/dex?format=${encodeURIComponent(state.format)}`);
  state.moveCache.clear();
  clampToRules();
  renderSpeciesList();
  renderFormatNote();
}

/** Champions caps a stat at 32; carrying a 252 spread across would be illegal. */
function clampToRules() {
  const { perStat } = statRules();
  for (const set of state.slots) {
    if (!set) continue;
    for (const [key] of STATS) set.evs[key] = Math.min(set.evs[key], perStat);
    set.level = rules().level;
  }
  syncPaste();
}

function renderFormatNote() {
  const r = rules();
  const note = $('#formatNote');
  if (!note) return;
  note.textContent = `Doubles · level ${r.level} · bring ${r.bring} of ${r.teamSize} · ${r.stats.label} capped at ${r.stats.perStat} per stat, ${r.stats.total} total`;
}

async function main() {
  const { formats } = await api('/api/formats');
  state.formats = formats;
  state.format = formats[0]?.id ?? state.format;
  $('#format').replaceChildren(...state.formats.map((f) =>
    el('option', { value: f.id, text: f.name, selected: f.id === state.format })));

  await loadDex();
  renderRoster();
  await renderEditor();
  renderSaved();

  $('#format').addEventListener('change', async (e) => {
    state.format = e.target.value;
    await loadDex();
    void renderEditor();
  });
  $('#search').addEventListener('input', renderSpeciesList);
  $('#validate').addEventListener('click', validate);
  $('#clearSlot').addEventListener('click', () => {
    state.slots[state.selected] = null;
    renderRoster();
    void renderEditor();
    syncPaste();
  });
  $('#paste').addEventListener('input', () => { pasteDirty = true; });
  $('#importBtn').addEventListener('click', () => {
    state.slots = parsePaste($('#paste').value);
    pasteDirty = false;
    syncPaste();
    renderRoster();
    void renderEditor();
    const n = state.slots.filter(Boolean).length;
    toast(n ? `Imported ${n} Pokémon` : 'Could not read any Pokémon from that paste', n ? '' : 'bad');
  });
  $('#copyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#paste').value);
      toast('Copied to clipboard');
    } catch {
      $('#paste').select();
      toast('Press ⌘/Ctrl-C to copy');
    }
  });
  $('#saveBtn').addEventListener('click', () => {
    const paste = $('#paste').value.trim();
    if (!paste) return toast('Nothing to save yet', 'bad');
    const name = $('#teamName').value.trim() || 'Untitled team';
    const teams = loadTeams();
    const entry = { name, format: state.format, paste, count: paste.split(/\n\s*\n/).filter(Boolean).length, savedAt: Date.now() };
    const existing = teams.findIndex((t) => t.name === name && t.format === state.format);
    if (existing >= 0) teams[existing] = entry; else teams.unshift(entry);
    toast(saveTeams(teams) ? `Saved ${name}` : 'This browser would not let me save', 'bad');
    renderSaved();
  });
  $('#battleBtn').addEventListener('click', async () => {
    const result = await validate();
    if (!result || !result.ok) return toast('Fix the problems above first', 'bad');
    sessionStorage.setItem('aether.battleTeam', JSON.stringify({ format: state.format, paste: $('#paste').value.trim() }));
    location.href = '/battle';
  });
}

main().catch((err) => {
  document.querySelector('#verdict').replaceChildren(
    el('div', { class: 'notice notice-bad', text: `Could not start the builder: ${err.message}` }));
});
