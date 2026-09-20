import { el, $, setKids, api, typeClass, loadTeams, toast } from '/assets/common.js';

const state = {
  formats: [],
  format: 'gen9randombattle',
  battle: null,       // server view
  logSeen: 0,
  sides: { p1: {}, p2: {} },   // ident -> { name, hp, maxhp, status, fainted }
  active: { p1: null, p2: null },
  counts: { p1: 6, p2: 6 },
  fainted: { p1: 0, p2: 0 },
  turn: 0,
  busy: false,
  preview: [],
  tera: false,
  moveDex: {},
};

/* ---------- protocol → readable log + board state ---------- */

const nameOf = (ident) => (ident || '').split(': ').slice(1).join(': ') || ident;
const sideOf = (ident) => (ident || '').slice(0, 2);

function parseCondition(cond) {
  if (!cond) return null;
  if (cond.startsWith('0 ') || cond === '0 fnt') return { hp: 0, maxhp: 100, status: 'fnt', fainted: true };
  const [hpPart, status] = cond.split(' ');
  const [cur, max] = hpPart.split('/').map(Number);
  return { hp: cur, maxhp: max || 100, status: status || '', fainted: cur === 0 };
}

function applyLine(line) {
  const parts = line.split('|').slice(1);
  const [cmd, ...args] = parts;
  const out = [];

  const setMon = (ident, patch) => {
    const side = sideOf(ident);
    const key = nameOf(ident);
    state.sides[side][key] = { ...(state.sides[side][key] || {}), name: key, ...patch };
  };

  switch (cmd) {
    case 'turn':
      state.turn = Number(args[0]);
      out.push({ kind: 'turn', text: `Turn ${args[0]}` });
      break;
    case 'player':
      if (args[0] === 'p1' && args[1]) $('#youLabel').textContent = args[1];
      break;
    case 'teamsize':
      state.counts[args[0]] = Number(args[1]);
      break;
    case 'switch':
    case 'drag': {
      const [ident, details, condition] = args;
      const cond = parseCondition(condition) || {};
      const level = /L(\d+)/.exec(details || '');
      setMon(ident, { ...cond, level: level ? Number(level[1]) : 100, species: (details || '').split(',')[0] });
      state.active[sideOf(ident)] = nameOf(ident);
      out.push({ kind: 'big', text: `${sideOf(ident) === 'p1' ? 'Go!' : 'AetherAI sent out'} ${nameOf(ident)}!` });
      break;
    }
    case 'move':
      out.push({ kind: 'big', text: `${nameOf(args[0])} used ${args[1]}!` });
      break;
    case '-damage':
    case '-heal': {
      const cond = parseCondition(args[1]);
      if (cond) setMon(args[0], cond);
      if (cmd === '-damage' && cond) {
        const pct = cond.maxhp === 100 ? `${cond.hp}%` : `${cond.hp}/${cond.maxhp}`;
        out.push({ kind: '', text: `${nameOf(args[0])} is at ${pct}.` });
      }
      break;
    }
    case '-sethp': {
      const cond = parseCondition(args[1]);
      if (cond) setMon(args[0], cond);
      break;
    }
    case '-status':
      setMon(args[0], { status: args[1] });
      out.push({ kind: '', text: `${nameOf(args[0])} was ${args[1] === 'slp' ? 'put to sleep' : `inflicted with ${args[1]}`}.` });
      break;
    case '-curestatus':
      setMon(args[0], { status: '' });
      break;
    case 'faint':
      setMon(args[0], { hp: 0, fainted: true, status: 'fnt' });
      state.fainted[sideOf(args[0])] += 1;
      if (state.active[sideOf(args[0])] === nameOf(args[0])) state.active[sideOf(args[0])] = null;
      out.push({ kind: 'faint', text: `${nameOf(args[0])} fainted.` });
      break;
    case '-supereffective': out.push({ kind: 'crit', text: `It's super effective!` }); break;
    case '-resisted': out.push({ kind: '', text: `It's not very effective…` }); break;
    case '-immune': out.push({ kind: '', text: `${nameOf(args[0])} is immune.` }); break;
    case '-crit': out.push({ kind: 'crit', text: `A critical hit!` }); break;
    case '-miss': out.push({ kind: '', text: `${nameOf(args[0])}'s attack missed.` }); break;
    case '-fail': out.push({ kind: '', text: `But it failed.` }); break;
    case '-terastallize': out.push({ kind: 'crit', text: `${nameOf(args[0])} terastallized into ${args[1]}!` }); break;
    case '-weather': if (args[0] !== 'none' && !args[1]) out.push({ kind: '', text: `${args[0]} kicked up.` }); break;
    case '-boost': out.push({ kind: '', text: `${nameOf(args[0])}'s ${args[1].toUpperCase()} rose.` }); break;
    case '-unboost': out.push({ kind: '', text: `${nameOf(args[0])}'s ${args[1].toUpperCase()} fell.` }); break;
    case '-ability': out.push({ kind: '', text: `${nameOf(args[0])}'s ${args[1]}!` }); break;
    case '-item': out.push({ kind: '', text: `${nameOf(args[0])} has ${args[1]}.` }); break;
    case '-enditem': out.push({ kind: '', text: `${nameOf(args[0])} used its ${args[1]}.` }); break;
    case 'cant': out.push({ kind: '', text: `${nameOf(args[0])} couldn't move.` }); break;
    case 'win': out.push({ kind: 'big', text: `${args[0]} wins.` }); break;
    case 'tie': out.push({ kind: 'big', text: `The battle ended in a tie.` }); break;
    default: break;
  }
  return out;
}

/* ---------- rendering ---------- */

function hpBar(mon) {
  if (!mon) return null;
  const pct = mon.maxhp ? Math.max(0, (mon.hp / mon.maxhp) * 100) : 0;
  const cls = pct <= 20 ? 'hp crit' : pct <= 50 ? 'hp low' : 'hp';
  return el('div', {},
    el('div', { class: cls }, el('div', { class: 'fill', style: `width:${pct}%` })),
    el('div', { class: 'hp-text' },
      el('span', { text: mon.maxhp === 100 ? `${Math.round(pct)}%` : `${mon.hp} / ${mon.maxhp}` }),
      mon.status && mon.status !== 'fnt' ? el('span', { class: `status ${mon.status}`, text: mon.status }) : null),
  );
}

function renderSide(side, hostId) {
  const activeName = state.active[side];
  const mon = activeName ? state.sides[side][activeName] : null;
  const host = $(hostId);
  setKids(host, mon
    ? el('div', {},
        el('div', { class: 'mon-line' },
          el('span', { class: 'mon-name', text: mon.name }),
          mon.level ? el('span', { class: 'lvl', text: `L${mon.level}` }) : null),
        hpBar(mon))
    : el('p', { class: 'none', text: 'No Pokémon on the field' }));
}

function renderDots() {
  for (const side of ['p1', 'p2']) {
    const total = state.counts[side] || 6;
    const down = state.fainted[side];
    // Living first, so the gold run reads as "what is left".
    $(side === 'p1' ? '#youTeam' : '#foeTeam').replaceChildren(
      ...Array.from({ length: total }, (_, i) => el('span', { class: `dot ${i >= total - down ? 'fainted' : ''}` })));
  }
}

function appendLog(entries) {
  const host = $('#log');
  const atBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 40;
  for (const entry of entries) {
    host.append(entry.kind === 'turn'
      ? el('div', { class: 'turn-sep', text: entry.text })
      : el('div', { class: `l ${entry.kind}`, text: entry.text }));
  }
  if (atBottom) host.scrollTop = host.scrollHeight;
}

function renderActions() {
  const host = $('#actions');
  const battle = state.battle;
  const title = $('#actionTitle');

  if (!battle || battle.ended) {
    title.textContent = 'Battle over';
    setKids(host,
      el('button', { class: 'gold', onclick: () => location.reload(), text: 'New battle' }),
      el('a', { class: 'btn', href: '/teams', text: 'Back to the builder' }));
    return;
  }
  if (state.busy) {
    title.textContent = 'Resolving…';
    host.replaceChildren(el('p', { class: 'waiting', text: 'AetherAI is choosing.' }));
    return;
  }

  const req = battle.request;
  if (!req || req.wait) {
    title.textContent = 'Waiting';
    host.replaceChildren(el('p', { class: 'waiting', text: 'Waiting for the other side…' }));
    return;
  }

  if (req.teamPreview) {
    title.textContent = 'Team preview';
    const picked = state.preview;
    setKids(host,
      el('p', { class: 'section-label', text: `Click to set your lead order (${picked.length}/${req.side.pokemon.length})` }),
      ...req.side.pokemon.map((mon, i) => {
        const order = picked.indexOf(i + 1);
        return el('button', {
          class: 'switch-row',
          onclick: () => {
            state.preview = order >= 0 ? picked.filter((n) => n !== i + 1) : [...picked, i + 1];
            renderActions();
          },
        },
          el('span', { class: 's-name', text: mon.details.split(',')[0] }),
          el('span', { class: 's-hp', text: order >= 0 ? `#${order + 1}` : '' }));
      }),
      el('button', {
        class: 'gold',
        onclick: () => {
          const order = [...picked, ...req.side.pokemon.map((_, i) => i + 1).filter((n) => !picked.includes(n))];
          state.preview = [];
          void choose(`team ${order.join(',')}`);
        },
        text: picked.length ? 'Confirm order' : 'Use default order',
      }));
    return;
  }

  if (req.forceSwitch) {
    title.textContent = 'Choose a replacement';
    const options = req.side.pokemon
      .map((mon, i) => ({ mon, slot: i + 1 }))
      .filter(({ mon }) => !mon.active && !mon.condition.endsWith(' fnt'));
    setKids(host,
      el('p', { class: 'section-label', text: 'Send out' }),
      ...(options.length ? options.map(({ mon, slot }) => switchButton(mon, slot))
        : [el('p', { class: 'waiting', text: 'No replacements left.' })]));
    return;
  }

  const active = req.active?.[0];
  if (!active) {
    title.textContent = 'Waiting';
    host.replaceChildren(el('p', { class: 'waiting', text: 'Nothing to choose right now.' }));
    return;
  }

  title.textContent = 'Your move';
  const canSwitch = !active.trapped && !active.maybeTrapped;
  const benched = req.side.pokemon
    .map((mon, i) => ({ mon, slot: i + 1 }))
    .filter(({ mon }) => !mon.active && !mon.condition.endsWith(' fnt'));

  setKids(host,
    ...active.moves.map((move, i) => {
      const info = state.moveDex[move.id] || {};
      return el('button', {
        class: 'move-btn',
        disabled: move.disabled || move.pp === 0,
        onclick: () => choose(`move ${i + 1}${state.tera ? ' terastallize' : ''}`),
      },
        el('span', { class: 'm-name', text: move.move }),
        el('span', { class: 'm-badges' },
          info.type ? el('span', { class: typeClass(info.type), text: info.type }) : false,
          move.pp !== undefined ? el('span', { class: 'cat', text: `${move.pp}/${move.maxpp} PP` }) : false),
        el('span', { class: 'm-meta' },
          info.category ? el('span', { class: 'cat', text: info.category }) : false,
          info.basePower ? el('span', { text: `${info.basePower} BP` }) : false,
          info.accuracy ? el('span', { text: `${info.accuracy}% acc` }) : false,
          move.disabled ? el('span', { text: 'Disabled' }) : false),
      );
    }),
    active.canTerastallize
      ? el('button', {
          class: 'tera-toggle',
          'aria-pressed': String(state.tera),
          onclick: () => { state.tera = !state.tera; renderActions(); },
        },
          el('span', { text: state.tera ? `Terastallizing into ${active.canTerastallize}` : `Terastallize into ${active.canTerastallize}` }),
          el('span', { class: 'hint', text: state.tera ? 'applies to your next move' : 'tap, then pick a move' }))
      : false,
    benched.length ? el('p', { class: 'section-label', text: canSwitch ? 'Or switch to' : 'Trapped — cannot switch' }) : null,
    ...benched.map(({ mon, slot }) => switchButton(mon, slot, !canSwitch)),
  );
}

function switchButton(mon, slot, disabled = false) {
  const cond = parseCondition(mon.condition) || { hp: 0, maxhp: 100 };
  return el('button', { class: 'switch-row', disabled, onclick: () => choose(`switch ${slot}`) },
    el('span', { class: 's-name', text: mon.details.split(',')[0] }),
    cond.status && cond.status !== 'fnt' ? el('span', { class: `status ${cond.status}`, text: cond.status }) : false,
    el('span', { class: 's-hp', text: `${cond.hp}/${cond.maxhp}` }));
}

function renderBanner() {
  const banner = $('#banner');
  if (!state.battle?.ended) { banner.hidden = true; return; }
  const youWon = state.battle.winner && state.battle.winner === $('#youLabel').textContent;
  banner.hidden = false;
  banner.className = youWon ? 'win' : 'loss';
  setKids(banner,
    el('h2', { text: state.battle.winner ? (youWon ? 'You win.' : 'AetherAI wins.') : 'A tie.' }),
    el('span', { class: 'spacer' }),
    el('button', { class: 'gold', onclick: () => location.reload(), text: 'Rematch' }));
}

function absorb(view) {
  state.battle = view;
  const entries = [];
  for (const line of view.log) entries.push(...applyLine(line));
  state.logSeen = view.logLength;
  appendLog(entries);
  renderSide('p2', '#foeActive');
  renderSide('p1', '#youActive');
  renderDots();
  $('#turnChip').textContent = state.turn ? `Turn ${state.turn}` : 'Starting';
  renderBanner();
  renderActions();
  if (view.error) toast(view.error, 'bad');
}

async function choose(choice) {
  if (!state.battle || state.busy) return;
  state.busy = true;
  renderActions();
  try {
    const view = await api(`/api/battle/${state.battle.id}/choose?since=${state.logSeen}`, {
      method: 'POST', body: { choice },
    });
    if (choice.includes('terastallize')) state.tera = false;
    state.busy = false;
    absorb(view);
  } catch (err) {
    state.busy = false;
    toast(err.message, 'bad');
    renderActions();
  }
}

/* ---------- setup ---------- */

function teamOptions() {
  const saved = loadTeams();
  const handoff = sessionStorage.getItem('aether.battleTeam');
  const options = [{ value: 'random', label: 'Random team (generated by the engine)' }];
  if (handoff) {
    try {
      const parsed = JSON.parse(handoff);
      options.unshift({ value: 'handoff', label: 'Team from the builder', paste: parsed.paste, format: parsed.format });
    } catch { /* ignore */ }
  }
  saved.forEach((team, i) => options.push({
    value: `saved:${i}`, label: `${team.name} (${team.format})`, paste: team.paste, format: team.format,
  }));
  return options;
}

function refreshTeamNote() {
  const option = state.teamOptions.find((o) => o.value === $('#teamSource').value);
  const format = state.formats.find((f) => f.id === $('#format').value);
  const note = $('#teamNote');
  if (!format) return;
  if (format.random) {
    note.textContent = 'Random Battle generates a full team for both sides — no team needed.';
  } else if (!option || option.value === 'random') {
    note.textContent = `${format.name} needs your own team. Build and save one first, or switch to Random Battle.`;
  } else {
    note.textContent = option.format && option.format !== format.id
      ? `Heads up: this team was built for ${option.format}. It will be validated against ${format.name}.`
      : `Using ${option.label}.`;
  }
}

async function start() {
  const button = $('#start');
  const format = state.formats.find((f) => f.id === $('#format').value);
  const option = state.teamOptions.find((o) => o.value === $('#teamSource').value);
  const errorHost = $('#setupError');
  errorHost.replaceChildren();
  button.disabled = true;
  button.textContent = 'Starting…';
  try {
    const view = await api('/api/battle', {
      method: 'POST',
      body: { format: format.id, paste: option?.paste || '' },
    });
    $('#setup').hidden = true;
    $('#arena').hidden = false;
    $('#formatChip').textContent = format.name;
    absorb(view);
  } catch (err) {
    setKids(errorHost, el('div', { class: 'notice notice-bad' },
      el('b', { text: err.message }),
      err.problems ? el('ul', {}, ...err.problems.map((p) => el('li', { text: p }))) : null));
  } finally {
    button.disabled = false;
    button.textContent = 'Start battle';
  }
}

async function main() {
  const [{ formats }, moveDex] = await Promise.all([api('/api/formats'), api('/api/movedex')]);
  state.moveDex = moveDex.moves;
  // Singles only for now: doubles needs per-slot targeting this UI does not have yet.
  state.formats = formats.filter((f) => f.gameType === 'singles');
  $('#format').replaceChildren(...state.formats.map((f) =>
    el('option', { value: f.id, text: f.random ? `${f.name} — no team needed` : f.name })));

  state.teamOptions = teamOptions();
  $('#teamSource').replaceChildren(...state.teamOptions.map((o) => el('option', { value: o.value, text: o.label })));

  const handoff = state.teamOptions.find((o) => o.value === 'handoff');
  if (handoff?.format && state.formats.some((f) => f.id === handoff.format)) $('#format').value = handoff.format;

  refreshTeamNote();
  $('#format').addEventListener('change', refreshTeamNote);
  $('#teamSource').addEventListener('change', refreshTeamNote);
  $('#start').addEventListener('click', start);
  $('#forfeit').addEventListener('click', () => location.reload());
}

main().catch((err) => {
  $('#setupError').replaceChildren(el('div', { class: 'notice notice-bad', text: `Could not load: ${err.message}` }));
});
