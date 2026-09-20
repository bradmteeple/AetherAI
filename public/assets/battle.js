import { el, $, setKids, api, typeClass, loadTeams, toast } from '/assets/common.js';
import { needsTarget, targetOptions } from '/assets/targeting.js';

const state = {
  formats: [],
  format: 'gen9randombattle',
  battle: null,       // server view
  logSeen: 0,
  sides: { p1: {}, p2: {} },   // ident -> { name, hp, maxhp, status, fainted }
  active: { p1: [], p2: [] },  // position index -> name on the field
  counts: { p1: 4, p2: 4 },
  fainted: { p1: 0, p2: 0 },
  turn: 0,
  format: null,
  draft: null,                 // the doubles choice being assembled
  busy: false,
  preview: [],
  tera: false,
  moveDex: {},
};

/* ---------- protocol → readable log + board state ---------- */

const nameOf = (ident) => (ident || '').split(': ').slice(1).join(': ') || ident;
const sideOf = (ident) => (ident || '').slice(0, 2);
/** `p1a:` / `p1b:` — the letter is the field position. */
const posOf = (ident) => Math.max(0, (ident || '').charCodeAt(2) - 97);

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
    case 'aether-game':
      // Our own marker: a new game of a best-of-three set starts here.
      state.sides = { p1: {}, p2: {} };
      state.active = { p1: [], p2: [] };
      state.fainted = { p1: 0, p2: 0 };
      state.turn = 0;
      out.push({ kind: 'game', text: `Game ${args[0]}` });
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
      state.active[sideOf(ident)][posOf(ident)] = nameOf(ident);
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
      {
        const side = state.active[sideOf(args[0])];
        const at = side.indexOf(nameOf(args[0]));
        if (at >= 0) side[at] = null;
      }
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
    case 'win': {
      const you = $('#youLabel').textContent;
      out.push({ kind: 'big', text: args[0] === you ? 'You win.' : `${args[0]} wins.` });
      break;
    }
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
  const host = $(hostId);
  const slots = Math.max(1, state.format?.gameType === 'doubles' ? 2 : 1);
  const targets = state.draft?.awaitingTarget ? state.draft.targets : null;

  setKids(host, ...Array.from({ length: slots }, (_, pos) => {
    const name = state.active[side][pos];
    const mon = name ? state.sides[side][name] : null;
    const isActingSlot = side === 'p1' && state.draft && state.draft.slot === pos && !state.draft.awaitingTarget;
    const option = targets?.find((t) => (t.side === 'foe' ? 'p2' : 'p1') === side && t.index === pos);

    return el('div', {
      class: `slot-mon${isActingSlot ? ' acting' : ''}${option ? ' targetable' : ''}${mon && mon.fainted ? ' gone' : ''}`,
      onclick: option ? () => pickTarget(option.loc) : undefined,
      title: option ? 'Aim here' : undefined,
    },
      el('span', { class: 'slot-tag', text: slots > 1 ? `Slot ${pos + 1}` : '' }),
      mon
        ? el('div', {},
            el('div', { class: 'mon-line' },
              el('span', { class: 'mon-name', text: mon.name }),
              mon.level ? el('span', { class: 'lvl', text: `L${mon.level}` }) : false),
            hpBar(mon))
        : el('p', { class: 'none', text: 'Empty' }));
  }));
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

/* ---------- choosing, one field slot at a time ---------- */

const activeCount = () => state.battle?.request?.active?.length || 1;

/** Start (or restart) assembling a choice for the current request. */
function beginDraft() {
  const req = state.battle?.request;
  if (!req || req.teamPreview || req.wait) { state.draft = null; return; }
  state.draft = { slot: 0, parts: [], awaitingTarget: null, targets: null, switched: new Set() };
  skipSlotsThatCannotAct();
}

/** Slots with nothing to decide (fainted, commanding) are passed over. */
function skipSlotsThatCannotAct() {
  const req = state.battle.request;
  const draft = state.draft;
  const total = req.forceSwitch ? req.forceSwitch.length : req.active.length;
  while (draft.slot < total) {
    if (req.forceSwitch) {
      if (req.forceSwitch[draft.slot]) break;
      draft.parts.push('pass');
    } else {
      const slot = req.active[draft.slot];
      const mon = req.side.pokemon[draft.slot];
      if (slot && !slot.commanding && !(mon && mon.condition.endsWith(' fnt'))) break;
      draft.parts.push('pass');
    }
    draft.slot += 1;
  }
  if (draft.slot >= total) submitDraft();
}

function commitPart(part) {
  const draft = state.draft;
  draft.parts.push(part);
  draft.slot += 1;
  draft.awaitingTarget = null;
  draft.targets = null;
  const req = state.battle.request;
  const total = req.forceSwitch ? req.forceSwitch.length : req.active.length;
  if (draft.slot >= total) return submitDraft();
  skipSlotsThatCannotAct();
  render();
}

function submitDraft() {
  const parts = state.draft.parts;
  state.draft = null;
  void choose(parts.join(', '));
}

function pickTarget(loc) {
  const draft = state.draft;
  if (!draft?.awaitingTarget) return;
  commitPart(`${draft.awaitingTarget.command} ${loc}`);
}

function chooseMove(index, move) {
  const draft = state.draft;
  const count = activeCount();
  const command = `move ${index + 1}${state.tera ? ' terastallize' : ''}`;
  if (state.tera) state.tera = false;
  if (!needsTarget(move.target, count)) return commitPart(command);
  draft.awaitingTarget = { command, move };
  draft.targets = targetOptions({ slotIndex: draft.slot, activeCount: count, targetType: move.target });
  render();
}

function slotName(index) {
  const req = state.battle.request;
  const mon = req.side.pokemon[index];
  return mon ? mon.details.split(',')[0] : `Slot ${index + 1}`;
}

function targetLabel(option) {
  const side = option.side === 'foe' ? 'p2' : 'p1';
  const name = state.active[side][option.index];
  if (option.self) return `${name || slotName(state.draft.slot)} (itself)`;
  return name || (option.side === 'foe' ? `Opposing slot ${option.index + 1}` : `Your slot ${option.index + 1}`);
}

function renderActions() {
  const host = $('#actions');
  const battle = state.battle;
  const title = $('#actionTitle');

  if (!battle || battle.ended) {
    title.textContent = battle?.ended ? 'Match over' : 'Battle over';
    setKids(host,
      el('button', { class: 'gold', onclick: () => location.reload(), text: 'New battle' }),
      el('a', { class: 'btn', href: '/teams', text: 'Back to the builder' }));
    return;
  }
  if (state.busy) {
    title.textContent = 'Resolving…';
    setKids(host, el('p', { class: 'waiting', text: 'AetherAI is choosing.' }));
    return;
  }

  const req = battle.request;
  if (!req || req.wait) {
    title.textContent = 'Waiting';
    setKids(host, el('p', { class: 'waiting', text: 'Waiting for the other side…' }));
    return;
  }

  if (req.teamPreview) return renderTeamPreview(host, title, req);

  if (!state.draft) beginDraft();
  if (!state.draft) return;
  const draft = state.draft;

  const total = req.forceSwitch ? req.forceSwitch.length : req.active.length;
  const steps = total > 1
    ? el('div', { class: 'build-steps' }, ...Array.from({ length: total }, (_, i) =>
        el('span', {
          class: `step ${i < draft.slot ? 'done' : i === draft.slot ? 'current' : ''}`,
          text: `${i + 1}. ${slotName(i)}`,
        })))
    : false;

  const restart = total > 1
    ? el('div', { class: 'builder-actions' },
        el('button', { class: 'btn-sm', onclick: () => { beginDraft(); render(); }, text: 'Start over' }))
    : false;

  // Waiting on a target for the move just picked.
  if (draft.awaitingTarget) {
    title.textContent = 'Pick a target';
    return setKids(host,
      steps,
      el('p', { class: 'acting-for' }, el('b', { text: slotName(draft.slot) }), el('span', { text: ` will use ${draft.awaitingTarget.move.move}` })),
      el('p', { class: 'target-prompt', text: 'Choose a target — or click one on the field above.' }),
      ...draft.targets.map((option) => el('button', { class: 'target-btn', onclick: () => pickTarget(option.loc) },
        el('span', { class: 't-name', text: targetLabel(option) }),
        el('span', { class: 't-side', text: option.self ? 'self' : option.side === 'foe' ? 'opponent' : 'ally' }))),
      el('div', { class: 'builder-actions' },
        el('button', { class: 'btn-sm', onclick: () => { draft.awaitingTarget = null; draft.targets = null; render(); }, text: 'Back' })));
  }

  const benched = req.side.pokemon
    .map((mon, i) => ({ mon, slot: i + 1, i }))
    .filter(({ mon, i }) => !mon.active && !mon.condition.endsWith(' fnt') && !draft.switched.has(i));

  // Replacing a fainted Pokémon.
  if (req.forceSwitch) {
    title.textContent = 'Choose a replacement';
    return setKids(host,
      steps,
      el('p', { class: 'acting-for' }, el('span', { text: 'Send out for ' }), el('b', { text: `slot ${draft.slot + 1}` })),
      ...(benched.length
        ? benched.map(({ mon, slot, i }) => switchButton(mon, slot, false, () => {
            draft.switched.add(i);
            commitPart(`switch ${slot}`);
          }))
        : [el('p', { class: 'waiting', text: 'Nothing left to send out.' })]),
      restart);
  }

  const active = req.active[draft.slot];
  if (!active) {
    title.textContent = 'Waiting';
    return setKids(host, el('p', { class: 'waiting', text: 'Nothing to choose right now.' }));
  }

  title.textContent = total > 1 ? `Choose for ${slotName(draft.slot)}` : 'Your move';
  const canSwitch = !active.trapped && !active.maybeTrapped;

  setKids(host,
    steps,
    total > 1 ? el('p', { class: 'acting-for' }, el('b', { text: slotName(draft.slot) }), el('span', { text: ' is up' })) : false,
    ...active.moves.map((move, i) => {
      const info = state.moveDex[move.id] || {};
      return el('button', {
        class: 'move-btn',
        disabled: move.disabled || move.pp === 0,
        onclick: () => chooseMove(i, move),
      },
        el('span', { class: 'm-name', text: move.move }),
        el('span', { class: 'm-badges' },
          info.type ? el('span', { class: typeClass(info.type), text: info.type }) : false,
          move.pp !== undefined ? el('span', { class: 'cat', text: `${move.pp}/${move.maxpp} PP` }) : false),
        el('span', { class: 'm-meta' },
          info.category ? el('span', { class: 'cat', text: info.category }) : false,
          info.basePower ? el('span', { text: `${info.basePower} BP` }) : false,
          info.accuracy ? el('span', { text: `${info.accuracy}% acc` }) : false,
          needsTarget(move.target, activeCount()) ? el('span', { text: 'pick a target' }) : false,
          move.disabled ? el('span', { text: 'Disabled' }) : false),
      );
    }),
    active.canTerastallize
      ? el('button', {
          class: 'tera-toggle',
          'aria-pressed': String(state.tera),
          onclick: () => { state.tera = !state.tera; render(); },
        },
          el('span', { text: `Terastallize into ${active.canTerastallize}` }),
          el('span', { class: 'hint', text: state.tera ? 'applies to your next move' : 'tap, then pick a move' }))
      : false,
    benched.length ? el('p', { class: 'section-label', text: canSwitch ? 'Or switch to' : 'Trapped — cannot switch' }) : false,
    ...benched.map(({ mon, slot, i }) => switchButton(mon, slot, !canSwitch, () => {
      draft.switched.add(i);
      commitPart(`switch ${slot}`);
    })),
    restart);
}

function renderTeamPreview(host, title, req) {
  const bring = req.maxChosenTeamSize || req.side.pokemon.length;
  const picked = state.preview;
  title.textContent = `Bring ${bring}`;
  setKids(host,
    el('p', { class: 'section-label', text: `Pick ${bring} of ${req.side.pokemon.length}, in lead order (${picked.length}/${bring})` }),
    el('div', { class: 'preview-grid' }, ...req.side.pokemon.map((mon, i) => {
      const order = picked.indexOf(i + 1);
      return el('button', {
        class: `preview-mon${order >= 0 ? ' picked' : ''}`,
        onclick: () => {
          if (order >= 0) state.preview = picked.filter((n) => n !== i + 1);
          else if (picked.length < bring) state.preview = [...picked, i + 1];
          render();
        },
      },
        el('span', { class: 'p-order', text: order >= 0 ? String(order + 1) : '' }),
        el('span', { class: 'p-name', text: mon.details.split(',')[0] }));
    })),
    el('button', {
      class: 'gold',
      disabled: picked.length !== bring,
      onclick: () => {
        const order = picked.join(',');
        state.preview = [];
        void choose(`team ${order}`);
      },
      text: picked.length === bring ? 'Send them out' : `Pick ${bring - picked.length} more`,
    }));
}

function switchButton(mon, slot, disabled, onPick) {
  const cond = parseCondition(mon.condition) || { hp: 0, maxhp: 100 };
  return el('button', { class: 'switch-row', disabled, onclick: onPick },
    el('span', { class: 's-name', text: mon.details.split(',')[0] }),
    cond.status && cond.status !== 'fnt' ? el('span', { class: `status ${cond.status}`, text: cond.status }) : false,
    el('span', { class: 's-hp', text: `${cond.hp}/${cond.maxhp}` }));
}

function renderBanner() {
  const banner = $('#banner');
  const view = state.battle;
  if (!view?.ended) { banner.hidden = true; return; }
  const youWon = view.winner && view.winner === $('#youLabel').textContent;
  banner.hidden = false;
  banner.className = youWon ? 'win' : 'loss';
  const headline = view.winner ? (youWon ? 'You win.' : 'AetherAI wins.') : 'A tie.';
  setKids(banner,
    el('div', {},
      el('h2', { text: headline }),
      view.bestOf
        ? el('p', { style: 'margin:4px 0 0;color:var(--text-dim);font-size:13.5px',
            text: `Set ${view.score.you}–${view.score.foe} over ${view.gameNumber} game${view.gameNumber === 1 ? '' : 's'}.` })
        : false),
    el('span', { class: 'spacer' }),
    el('button', { class: 'gold', onclick: () => location.reload(), text: 'Rematch' }));
}

function render() {
  renderSide('p2', '#foeActive');
  renderSide('p1', '#youActive');
  renderActions();
}

function absorb(view) {
  state.battle = view;
  state.draft = null;
  const entries = [];
  for (const line of view.log) entries.push(...applyLine(line));
  state.logSeen = view.logLength;
  appendLog(entries);
  renderDots();
  $('#turnChip').textContent = state.turn ? `Turn ${state.turn}` : 'Starting';
  if (view.bestOf) {
    $('#gameChip').hidden = false;
    $('#gameChip').textContent = `Game ${view.gameNumber} of ${view.bestOf}`;
    $('#scoreChip').hidden = false;
    $('#scoreChip').textContent = `${view.score.you} – ${view.score.foe}`;
  }
  renderBanner();
  render();
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

async function teamOptions(formatId) {
  const options = [];
  const handoff = sessionStorage.getItem('aether.battleTeam');
  if (handoff) {
    try {
      const parsed = JSON.parse(handoff);
      options.push({ value: 'handoff', label: 'Team from the builder', paste: parsed.paste, format: parsed.format });
    } catch { /* ignore a malformed handoff */ }
  }
  loadTeams().forEach((team, i) => options.push({
    value: `saved:${i}`, label: `${team.name} (${team.format})`, paste: team.paste, format: team.format,
  }));
  try {
    const { teams } = await api(`/api/sampleteams?format=${encodeURIComponent(formatId)}`);
    for (const team of teams) options.push({ value: `sample:${team.id}`, label: team.name, paste: team.paste, format: formatId });
  } catch { /* samples are a convenience, not a requirement */ }
  return options;
}

async function refreshTeamSources() {
  const formatId = $('#format').value;
  state.format = state.formats.find((f) => f.id === formatId) || null;
  state.teamOptions = await teamOptions(formatId);
  const select = $('#teamSource');
  setKids(select, ...(state.teamOptions.length
    ? state.teamOptions.map((o) => el('option', { value: o.value, text: o.label }))
    : [el('option', { value: '', text: 'No team yet — build one first' })]));
  refreshTeamNote();
}

function refreshTeamNote() {
  const option = state.teamOptions.find((o) => o.value === $('#teamSource').value);
  const format = state.format;
  const note = $('#teamNote');
  if (!format) return;
  const rules = [
    `${format.name}: doubles, level ${format.level}, bring ${format.bring} of ${format.teamSize}.`,
    format.stats.statPoints ? `Champions rules — ${format.stats.label}, ${format.stats.perStat} per stat.` : '',
    format.bestOf ? `Best of ${format.bestOf}.` : '',
  ].filter(Boolean).join(' ');

  if (!state.teamOptions.length) {
    note.textContent = `${rules} No team for this regulation yet — build one in the team builder.`;
  } else if (option?.format && option.format !== format.id) {
    note.textContent = `${rules} Heads up: "${option.label}" was built for ${option.format} and will be validated against this format.`;
  } else {
    note.textContent = rules;
  }
}

async function start() {
  const button = $('#start');
  const format = state.format;
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
  state.formats = formats;
  setKids($('#format'), ...formats.map((f) =>
    el('option', { value: f.id, text: f.bestOf ? `${f.name}` : f.name })));

  const handoff = sessionStorage.getItem('aether.battleTeam');
  if (handoff) {
    try {
      const parsed = JSON.parse(handoff);
      if (formats.some((f) => f.id === parsed.format)) $('#format').value = parsed.format;
    } catch { /* ignore */ }
  }

  await refreshTeamSources();
  $('#format').addEventListener('change', () => void refreshTeamSources());
  $('#teamSource').addEventListener('change', refreshTeamNote);
  $('#start').addEventListener('click', start);
  $('#forfeit').addEventListener('click', () => location.reload());
}

main().catch((err) => {
  $('#setupError').replaceChildren(el('div', { class: 'notice notice-bad', text: `Could not load: ${err.message}` }));
});
