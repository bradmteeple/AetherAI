import { RoomMessage } from '../showdown/protocol';
import { toID } from '../util/id';
import {
  ChoiceRequest, parseCondition, parseDetails, parseIdent, RequestPokemon, SideId,
} from './request';
import {
  BattleState, emptyBoosts, FieldState, opponentOf, PokemonState, SideState,
} from './types';
import { TeamSheet } from '../team/OpenTeamSheetParser';

export interface BattleStateEngineOptions {
  roomId: string;
  gameNumber: number;
  ourUserId: string;
  ourUsername: string;
}

function newSide(id: SideId): SideState {
  return { id, name: '', isUs: false, totalPokemon: 0, pokemon: [], active: [null, null], conditions: [] };
}

function newField(): FieldState {
  return { weather: null, weatherStartedTurn: null, terrain: null, terrainStartedTurn: null, pseudoWeather: [] };
}

/**
 * Applies battle-log lines and `|request|` JSON to a `BattleState`.
 *
 * Only public information (SIM-PROTOCOL.md) and our own request are used.
 * The engine is deliberately conservative: unknown message types are logged
 * but never break state tracking.
 */
export class BattleStateEngine {
  readonly state: BattleState;
  private readonly ourUserId: string;
  private readonly listeners = new Set<(msg: RoomMessage, state: BattleState) => void>();

  constructor(options: BattleStateEngineOptions) {
    this.ourUserId = options.ourUserId;
    this.state = {
      roomId: options.roomId,
      gameNumber: options.gameNumber,
      formatId: '',
      formatName: '',
      gameType: 'doubles',
      gen: 9,
      phase: 'init',
      turn: 0,
      ourSide: 'p1',
      players: {},
      sides: { p1: newSide('p1'), p2: newSide('p2') },
      field: newField(),
      request: null,
      rqid: null,
      sentChoice: null,
      winner: null,
      tie: false,
      ended: false,
      log: [],
      teamSheets: {},
      timerOn: false,
      lastError: null,
    };
  }

  onApplied(listener: (msg: RoomMessage, state: BattleState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get us(): SideState {
    return this.state.sides[this.state.ourSide];
  }

  get opponent(): SideState {
    return this.state.sides[opponentOf(this.state.ourSide)];
  }

  /** Attach the opponent's OTS so opponent Pokémon carry sheet knowledge. */
  applyTeamSheet(sheet: TeamSheet): void {
    const side = this.state.sides[sheet.side];
    for (const entry of sheet.pokemon) {
      const existing = side.pokemon.find((p) => p.slot === entry.slot) ?? this.ensurePokemonBySlot(sheet.side, entry.slot, entry.species);
      existing.species = existing.species || entry.species;
      existing.baseSpecies = existing.baseSpecies || entry.species;
      existing.level = entry.level;
      existing.gender = existing.gender || (entry.gender ?? '');
      if (!side.isUs) {
        existing.item = entry.item;
        existing.itemKnownFrom = existing.itemKnownFrom === 'reveal' ? 'reveal' : 'sheet';
        existing.ability = entry.ability;
        existing.abilityKnownFrom = existing.abilityKnownFrom === 'reveal' ? 'reveal' : 'sheet';
        existing.moves = entry.moves.map((name, i) => ({
          id: entry.moveIds[i] ?? toID(name), name, pp: null, maxpp: null, disabled: false, target: null,
        }));
      }
    }
  }

  apply(msg: RoomMessage): void {
    const s = this.state;
    s.log.push(msg.raw);
    try {
      this.handle(msg);
    } finally {
      for (const l of this.listeners) l(msg, s);
    }
  }

  private handle(msg: RoomMessage): void {
    const s = this.state;
    const a = msg.args;
    switch (msg.type) {
      case 'player': {
        const [side, name, avatar, rating] = a as [SideId, string, string, string];
        if (!side) break;
        if (name) {
          s.players[side] = { side, name, avatar: avatar ?? '', rating: rating ?? '' };
          s.sides[side].name = name;
          if (toID(name) === this.ourUserId) {
            s.ourSide = side;
            s.sides[side].isUs = true;
            s.sides[opponentOf(side)].isUs = false;
          }
        }
        break;
      }
      case 'teamsize':
        s.sides[a[0] as SideId].totalPokemon = Number(a[1]);
        break;
      case 'gametype':
        s.gameType = a[0];
        break;
      case 'gen':
        s.gen = Number(a[0]);
        break;
      case 'tier':
        s.formatName = a[0];
        s.formatId = toID(a[0]);
        break;
      case 'clearpoke':
        s.phase = 'teampreview';
        for (const side of ['p1', 'p2'] as SideId[]) s.sides[side].pokemon = [];
        break;
      case 'poke': {
        const side = a[0] as SideId;
        const details = parseDetails(a[1] ?? '');
        const slot = s.sides[side].pokemon.length + 1;
        const mon = this.ensurePokemonBySlot(side, slot, details.species);
        mon.details = a[1] ?? '';
        mon.gender = details.gender;
        mon.level = details.level;
        if (a[2] === 'item' && !mon.item) mon.itemKnownFrom = mon.itemKnownFrom ?? null;
        break;
      }
      case 'showteam':
        s.teamSheets[a[0] as SideId] = msg.rest.slice((a[0] ?? '').length + 1);
        break;
      case 'teampreview':
        s.phase = 'teampreview';
        break;
      case 'start':
        s.phase = 'battle';
        break;
      case 'turn':
        s.turn = Number(a[0]);
        for (const side of ['p1', 'p2'] as SideId[]) {
          for (const mon of s.sides[side].pokemon) {
            mon.volatiles = mon.volatiles.filter((v) => !SINGLE_TURN_VOLATILES.has(v));
          }
        }
        break;
      case 'request': {
        if (!msg.rest || msg.rest === 'null') {
          s.request = null;
          break;
        }
        let req: ChoiceRequest;
        try {
          req = JSON.parse(msg.rest);
        } catch {
          s.lastError = 'Unparseable request JSON';
          break;
        }
        s.request = req;
        s.rqid = req.rqid ?? null;
        s.sentChoice = null;
        this.applyRequestSide(req);
        break;
      }
      case 'sentchoice':
        s.sentChoice = msg.rest;
        break;
      case 'error':
        s.lastError = msg.rest;
        break;
      case 'switch':
      case 'drag':
      case 'replace':
        this.onSwitch(msg.type, a[0], a[1], a[2]);
        break;
      case 'detailschange': {
        const mon = this.find(a[0]);
        if (mon) {
          const d = parseDetails(a[1] ?? '');
          mon.species = d.species;
          mon.details = a[1] ?? '';
        }
        break;
      }
      case '-formechange': {
        const mon = this.find(a[0]);
        if (mon) mon.species = a[1] ?? mon.species;
        break;
      }
      case '-mega': {
        const mon = this.find(a[0]);
        if (mon) {
          mon.megaEvolved = true;
          if (a[2] && !mon.isUsRevealed()) mon.setItem(a[2], 'reveal');
        }
        break;
      }
      case 'swap': {
        const mon = this.find(a[0]);
        if (mon) {
          const side = s.sides[mon.side];
          const newPos = Number(a[1]);
          const other = side.active[newPos];
          const oldPos = mon.position ?? 0;
          side.active[newPos] = mon;
          side.active[oldPos] = other;
          mon.position = newPos;
          if (other) other.position = oldPos;
        }
        break;
      }
      case 'faint': {
        const mon = this.find(a[0]);
        if (mon) {
          mon.fainted = true;
          mon.hp = 0;
          mon.hpPercent = 0;
          mon.status = 'fnt';
        }
        break;
      }
      case 'move': {
        const mon = this.find(a[0]);
        if (mon) {
          mon.lastMove = a[1] ?? null;
          if (a[1] && !mon.revealedMoves.includes(a[1]) && !msg.rest.includes('[from]')) mon.revealedMoves.push(a[1]);
        }
        break;
      }
      case '-damage':
      case '-heal':
      case '-sethp': {
        const mon = this.find(a[0]);
        if (mon && a[1]) this.setCondition(mon, a[1]);
        break;
      }
      case '-status': {
        const mon = this.find(a[0]);
        if (mon) mon.status = a[1] ?? '';
        break;
      }
      case '-curestatus': {
        const mon = this.find(a[0]);
        if (mon) mon.status = '';
        break;
      }
      case '-cureteam': {
        const mon = this.find(a[0]);
        if (mon) for (const p of s.sides[mon.side].pokemon) if (!p.fainted) p.status = '';
        break;
      }
      case '-boost':
      case '-unboost': {
        const mon = this.find(a[0]);
        const stat = a[1] as keyof PokemonState['boosts'];
        if (mon && stat in mon.boosts) {
          const delta = Number(a[2]) * (msg.type === '-boost' ? 1 : -1);
          mon.boosts[stat] = Math.max(-6, Math.min(6, mon.boosts[stat] + delta));
        }
        break;
      }
      case '-setboost': {
        const mon = this.find(a[0]);
        const stat = a[1] as keyof PokemonState['boosts'];
        if (mon && stat in mon.boosts) mon.boosts[stat] = Number(a[2]);
        break;
      }
      case '-swapboost': {
        const src = this.find(a[0]);
        const tgt = this.find(a[1]);
        if (src && tgt) {
          const stats = (a[2] ? a[2].split(',').map((x) => x.trim()) : Object.keys(src.boosts)) as (keyof PokemonState['boosts'])[];
          for (const st of stats) {
            const tmp = src.boosts[st];
            src.boosts[st] = tgt.boosts[st];
            tgt.boosts[st] = tmp;
          }
        }
        break;
      }
      case '-invertboost': {
        const mon = this.find(a[0]);
        if (mon) for (const k of Object.keys(mon.boosts) as (keyof PokemonState['boosts'])[]) mon.boosts[k] = -mon.boosts[k];
        break;
      }
      case '-clearboost': {
        const mon = this.find(a[0]);
        if (mon) mon.boosts = emptyBoosts();
        break;
      }
      case '-clearallboost':
        for (const side of ['p1', 'p2'] as SideId[]) for (const p of s.sides[side].pokemon) p.boosts = emptyBoosts();
        break;
      case '-clearpositiveboost': {
        const mon = this.find(a[0]);
        if (mon) for (const k of Object.keys(mon.boosts) as (keyof PokemonState['boosts'])[]) if (mon.boosts[k] > 0) mon.boosts[k] = 0;
        break;
      }
      case '-clearnegativeboost': {
        const mon = this.find(a[0]);
        if (mon) for (const k of Object.keys(mon.boosts) as (keyof PokemonState['boosts'])[]) if (mon.boosts[k] < 0) mon.boosts[k] = 0;
        break;
      }
      case '-copyboost': {
        const src = this.find(a[0]);
        const tgt = this.find(a[1]);
        if (src && tgt) src.boosts = { ...tgt.boosts };
        break;
      }
      case '-weather': {
        const w = a[0] ?? 'none';
        if (w === 'none' || !w) {
          s.field.weather = null;
          s.field.weatherStartedTurn = null;
        } else if (!msg.rest.includes('[upkeep]')) {
          s.field.weather = w;
          s.field.weatherStartedTurn = s.turn;
        }
        break;
      }
      case '-fieldstart': {
        const name = stripEffectPrefix(a[0] ?? '');
        const id = toID(name);
        if (id.endsWith('terrain')) {
          s.field.terrain = name;
          s.field.terrainStartedTurn = s.turn;
        } else if (!s.field.pseudoWeather.some((p) => p.id === id)) {
          s.field.pseudoWeather.push({ id, name, startedTurn: s.turn });
        }
        break;
      }
      case '-fieldend': {
        const name = stripEffectPrefix(a[0] ?? '');
        const id = toID(name);
        if (id.endsWith('terrain')) {
          s.field.terrain = null;
          s.field.terrainStartedTurn = null;
        } else {
          s.field.pseudoWeather = s.field.pseudoWeather.filter((p) => p.id !== id);
        }
        break;
      }
      case '-sidestart': {
        const side = (a[0] ?? '').slice(0, 2) as SideId;
        const name = stripEffectPrefix(a[1] ?? '');
        const id = toID(name);
        const list = s.sides[side]?.conditions;
        if (list && !list.some((c) => c.id === id)) list.push({ id, name, startedTurn: s.turn });
        break;
      }
      case '-sideend': {
        const side = (a[0] ?? '').slice(0, 2) as SideId;
        const id = toID(stripEffectPrefix(a[1] ?? ''));
        if (s.sides[side]) s.sides[side].conditions = s.sides[side].conditions.filter((c) => c.id !== id);
        break;
      }
      case '-swapsideconditions': {
        const tmp = s.sides.p1.conditions;
        s.sides.p1.conditions = s.sides.p2.conditions;
        s.sides.p2.conditions = tmp;
        break;
      }
      case '-start': {
        const mon = this.find(a[0]);
        if (mon) {
          const v = toID(stripEffectPrefix(a[1] ?? ''));
          if (v && !mon.volatiles.includes(v)) mon.volatiles.push(v);
          if (v === 'typechange' || v === 'dynamax') {
            /* no-op for state purposes */
          }
        }
        break;
      }
      case '-end': {
        const mon = this.find(a[0]);
        if (mon) {
          const v = toID(stripEffectPrefix(a[1] ?? ''));
          mon.volatiles = mon.volatiles.filter((x) => x !== v);
        }
        break;
      }
      case '-singleturn':
      case '-singlemove': {
        const mon = this.find(a[0]);
        if (mon) {
          const v = toID(stripEffectPrefix(a[1] ?? ''));
          if (v && !mon.volatiles.includes(v)) mon.volatiles.push(v);
        }
        break;
      }
      case '-item': {
        const mon = this.find(a[0]);
        if (mon) mon.setItem(a[1] ?? '', 'reveal');
        break;
      }
      case '-enditem': {
        const mon = this.find(a[0]);
        if (mon) mon.setItem('', 'reveal');
        break;
      }
      case '-ability': {
        const mon = this.find(a[0]);
        if (mon && a[1]) mon.setAbility(a[1], 'reveal');
        break;
      }
      case '-endability': {
        const mon = this.find(a[0]);
        if (mon && !mon.volatiles.includes('gastroacid')) mon.volatiles.push('gastroacid');
        break;
      }
      case '-transform': {
        const mon = this.find(a[0]);
        if (mon) {
          if (!mon.volatiles.includes('transform')) mon.volatiles.push('transform');
        }
        break;
      }
      case 'win':
        s.ended = true;
        s.phase = 'ended';
        s.winner = a[0] ?? null;
        s.request = null;
        break;
      case 'tie':
        s.ended = true;
        s.phase = 'ended';
        s.tie = true;
        s.request = null;
        break;
      case 'inactive':
        s.timerOn = true;
        break;
      case 'inactiveoff':
        s.timerOn = false;
        break;
      default:
        break;
    }
  }

  private onSwitch(type: string, identArg: string, detailsArg: string, conditionArg: string) {
    const s = this.state;
    const ident = parseIdent(identArg ?? '');
    const details = parseDetails(detailsArg ?? '');
    const side = s.sides[ident.side];
    if (!side) return;
    const position = ident.position ?? 0;
    const previous = side.active[position];
    if (previous && type !== 'replace') {
      previous.active = false;
      previous.position = null;
      previous.boosts = emptyBoosts();
      previous.volatiles = [];
      if (previous.species !== previous.baseSpecies && !previous.megaEvolved) previous.species = previous.baseSpecies;
    }
    let mon: PokemonState | undefined;
    if (type === 'replace') {
      // Illusion ended: the Pokémon in this slot was actually someone else.
      mon = previous ?? undefined;
      if (mon) {
        mon.nickname = ident.name;
        mon.ident = `${ident.side}: ${ident.name}`;
        mon.species = details.species;
        mon.baseSpecies = details.species;
      }
    }
    if (!mon) mon = this.findOrCreateForSwitch(ident.side, ident.name, details.species);
    mon.nickname = ident.name;
    mon.ident = `${ident.side}: ${ident.name}`;
    mon.details = detailsArg ?? mon.details;
    mon.species = details.species;
    if (!mon.baseSpecies) mon.baseSpecies = details.species;
    mon.level = details.level;
    mon.gender = details.gender || mon.gender;
    mon.active = true;
    mon.position = position;
    mon.fainted = false;
    if (type !== 'replace') {
      mon.boosts = emptyBoosts();
      mon.volatiles = [];
      mon.lastSwitchInTurn = s.turn;
      mon.timesSwitchedIn++;
    }
    if (conditionArg) this.setCondition(mon, conditionArg);
    side.active[position] = mon;
  }

  private applyRequestSide(req: ChoiceRequest) {
    const s = this.state;
    const sideId = req.side?.id;
    if (!sideId) return;
    const side = s.sides[sideId];
    if (req.side.name && toID(req.side.name) === this.ourUserId) {
      s.ourSide = sideId;
      side.isUs = true;
      s.sides[opponentOf(sideId)].isUs = false;
    }
    side.name = req.side.name || side.name;
    // The request lists our Pokémon in *current* order (actives first after
    // team preview). We keep `slot` = original preview order, matched by ident.
    const seen = new Set<PokemonState>();
    req.side.pokemon.forEach((rp: RequestPokemon, index: number) => {
      const ident = parseIdent(rp.ident);
      const details = parseDetails(rp.details);
      let mon = side.pokemon.find((p) => toID(p.nickname) === toID(ident.name) && !seen.has(p))
        ?? side.pokemon.find((p) => toID(p.species) === toID(details.species) && !seen.has(p) && !p.nickname);
      if (!mon) {
        mon = this.newPokemon(sideId, side.pokemon.length + 1, details.species);
        side.pokemon.push(mon);
      }
      seen.add(mon);
      mon.requestIndex = index;
      mon.nickname = ident.name;
      mon.ident = `${sideId}: ${ident.name}`;
      mon.details = rp.details;
      mon.species = details.species;
      if (!mon.baseSpecies) mon.baseSpecies = details.species;
      mon.level = details.level;
      mon.gender = details.gender;
      this.setCondition(mon, rp.condition);
      mon.active = rp.active;
      mon.item = rp.item ?? '';
      mon.itemKnownFrom = 'request';
      mon.ability = rp.ability ?? rp.baseAbility ?? '';
      mon.abilityKnownFrom = 'request';
      mon.stats = rp.stats;
      const requestMoves = rp.moves ?? [];
      const existingById = new Map(mon.moves.map((m) => [m.id, m]));
      mon.moves = requestMoves.map((id) => existingById.get(id) ?? { id, name: id, pp: null, maxpp: null, disabled: false, target: null });
      mon.commanding = !!rp.commanding;
      mon.reviving = !!rp.reviving;
    });
    // Active move details (pp, targets, disabled) from req.active
    if (req.active) {
      req.active.forEach((act, position) => {
        const mon = side.active[position] ?? side.pokemon.find((p) => p.active && p.requestIndex === position);
        if (!mon) return;
        mon.moves = act.moves.map((m) => ({
          id: m.id, name: m.move, pp: m.pp ?? null, maxpp: m.maxpp ?? null, disabled: !!m.disabled, target: m.target ?? null,
        }));
        mon.trapped = !!act.trapped;
        mon.maybeTrapped = !!act.maybeTrapped;
        mon.canMegaEvo = !!act.canMegaEvo;
      });
    }
  }

  private setCondition(mon: PokemonState, condition: string) {
    const c = parseCondition(condition);
    mon.hp = c.hp;
    mon.maxhp = c.maxhp;
    mon.hpPercent = c.maxhp ? Math.round((c.hp / c.maxhp) * 1000) / 10 : 0;
    mon.status = c.status;
    mon.fainted = c.fainted;
    if (c.fainted) {
      mon.hp = 0;
      mon.hpPercent = 0;
    }
  }

  private find(identArg: string | undefined): PokemonState | null {
    if (!identArg) return null;
    const ident = parseIdent(identArg);
    const side = this.state.sides[ident.side];
    if (!side) return null;
    if (ident.position !== null && side.active[ident.position]) {
      const active = side.active[ident.position]!;
      if (toID(active.nickname) === toID(ident.name) || !ident.name) return active;
    }
    return (
      side.pokemon.find((p) => toID(p.nickname) === toID(ident.name)) ??
      side.pokemon.find((p) => toID(p.species) === toID(ident.name)) ??
      null
    );
  }

  private findOrCreateForSwitch(sideId: SideId, name: string, species: string): PokemonState {
    const side = this.state.sides[sideId];
    const byName = side.pokemon.find((p) => p.nickname && toID(p.nickname) === toID(name));
    if (byName) return byName;
    const baseSpecies = species.split('-')[0];
    const bySpecies = side.pokemon.find(
      (p) => !p.nickname && (toID(p.species) === toID(species) || toID(p.baseSpecies) === toID(species) || toID(p.species.split('-')[0]) === toID(baseSpecies)),
    );
    if (bySpecies) return bySpecies;
    const mon = this.newPokemon(sideId, side.pokemon.length + 1, species);
    side.pokemon.push(mon);
    return mon;
  }

  private ensurePokemonBySlot(sideId: SideId, slot: number, species: string): PokemonState {
    const side = this.state.sides[sideId];
    let mon = side.pokemon.find((p) => p.slot === slot);
    if (!mon) {
      mon = this.newPokemon(sideId, slot, species);
      side.pokemon.push(mon);
      side.pokemon.sort((x, y) => x.slot - y.slot);
    }
    return mon;
  }

  private newPokemon(sideId: SideId, slot: number, species: string): PokemonState {
    const mon: PokemonState = Object.assign(Object.create(PokemonStateProto), {
      slot,
      ident: `${sideId}: ${species}`,
      side: sideId,
      nickname: '',
      species,
      baseSpecies: species,
      details: species,
      level: 50,
      gender: '',
      hp: 100,
      maxhp: 100,
      hpPercent: 100,
      status: '',
      fainted: false,
      active: false,
      position: null,
      boosts: emptyBoosts(),
      volatiles: [],
      item: null,
      itemKnownFrom: null,
      ability: null,
      abilityKnownFrom: null,
      moves: [],
      revealedMoves: [],
      megaEvolved: false,
      lastSwitchInTurn: null,
      timesSwitchedIn: 0,
      lastMove: null,
    });
    return mon;
  }
}

/** Helper methods hung off PokemonState objects (kept out of the JSON shape). */
const PokemonStateProto = {
  setItem(this: PokemonState, item: string, from: 'request' | 'sheet' | 'reveal') {
    this.item = item;
    this.itemKnownFrom = from;
  },
  setAbility(this: PokemonState, ability: string, from: 'request' | 'sheet' | 'reveal') {
    this.ability = ability;
    this.abilityKnownFrom = from;
  },
  isUsRevealed(this: PokemonState) {
    return this.itemKnownFrom === 'request';
  },
};

declare module './types' {
  interface PokemonState {
    /** Index within the latest request's `side.pokemon` array (our side only). */
    requestIndex?: number;
    stats?: { atk: number; def: number; spa: number; spd: number; spe: number };
    trapped?: boolean;
    maybeTrapped?: boolean;
    canMegaEvo?: boolean;
    commanding?: boolean;
    reviving?: boolean;
    setItem(item: string, from: 'request' | 'sheet' | 'reveal'): void;
    setAbility(ability: string, from: 'request' | 'sheet' | 'reveal'): void;
    isUsRevealed(): boolean;
  }
}

const SINGLE_TURN_VOLATILES = new Set([
  'protect', 'detect', 'spikyshield', 'banefulbunker', 'kingsshield', 'obstruct', 'silktrap', 'burningbulwark',
  'wideguard', 'quickguard', 'matblock', 'craftyshield', 'endure', 'helpinghand', 'followme', 'ragepowder',
  'spotlight', 'powder', 'magiccoat', 'snatch', 'roost', 'electrify', 'focuspunch', 'beakblast', 'shelltrap',
]);

export function stripEffectPrefix(text: string): string {
  return text.replace(/^(move|ability|item|condition|status|rule):\s*/i, '').trim();
}

/** Serialisable snapshot (drops prototype helpers). */
export function snapshotState(state: BattleState): BattleState {
  return JSON.parse(JSON.stringify(state, (key, value) => (key === 'log' ? undefined : value)));
}
