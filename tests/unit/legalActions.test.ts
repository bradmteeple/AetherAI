import { describe, expect, it } from 'vitest';
import { generateLegalActions, TurnLegalActions, ForceSwitchLegalActions, TeamPreviewLegalActions } from '../../src/battle/LegalActionGenerator';
import { validateDecision, safeFallback } from '../../src/battle/ActionValidator';
import { encodeTeamPreview, encodeTurn } from '../../src/battle/ActionEncoder';
import { ChoiceRequest } from '../../src/battle/request';

const side = (pokemon: Partial<ChoiceRequest['side']['pokemon'][number]>[]): ChoiceRequest['side'] => ({
  name: 'Aether',
  id: 'p1',
  pokemon: pokemon.map((p, i) => ({
    ident: `p1: Mon${i + 1}`,
    details: `Mon${i + 1}, L50`,
    condition: '100/100',
    active: i < 2,
    stats: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 },
    moves: ['a', 'b'],
    baseAbility: 'x',
    item: 'y',
    pokeball: 'pokeball',
    ability: 'x',
    ...p,
  })),
});

describe('team preview', () => {
  const req: ChoiceRequest = { teamPreview: true, maxChosenTeamSize: 4, rqid: 1, side: side([{}, {}, {}, {}, {}, {}].map(() => ({ active: false }))) };
  const legal = generateLegalActions(req) as TeamPreviewLegalActions;
  it('lists six slots and requires four distinct picks', () => {
    expect(legal.kind).toBe('teampreview');
    expect(legal.pokemon.map((p) => p.slot)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(validateDecision({ lead1: 3, lead2: 1, back1: 5, back2: 2 }, legal).ok).toBe(true);
    expect(validateDecision({ lead1: 3, lead2: 3, back1: 5, back2: 2 }, legal).errors.join()).toMatch(/distinct/);
    expect(validateDecision({ lead1: 7, lead2: 1, back1: 5, back2: 2 }, legal).errors.join()).toMatch(/not a valid/);
    expect(validateDecision({ lead1: 'x' }, legal).ok).toBe(false);
  });
  it('encodes leads first', () => {
    expect(encodeTeamPreview({ lead1: 3, lead2: 1, back1: 5, back2: 2 }, 1)).toBe('/choose team 3,1,5,2|1');
  });
  it('fallback is legal', () => {
    const fb = safeFallback(legal)!;
    expect(validateDecision(fb, legal).ok).toBe(true);
  });
});

describe('doubles move requests', () => {
  const req: ChoiceRequest = {
    rqid: 7,
    active: [
      {
        moves: [
          { move: 'Fake Out', id: 'fakeout', pp: 16, maxpp: 16, target: 'normal', disabled: false },
          { move: 'Rock Slide', id: 'rockslide', pp: 16, maxpp: 16, target: 'allAdjacentFoes', disabled: false },
          { move: 'Protect', id: 'protect', pp: 16, maxpp: 16, target: 'self', disabled: true },
          { move: 'Helping Hand', id: 'helpinghand', pp: 32, maxpp: 32, target: 'adjacentAlly', disabled: false },
        ],
        canMegaEvo: true,
      },
      {
        moves: [
          { move: 'Pollen Puff', id: 'pollenpuff', pp: 24, maxpp: 24, target: 'any', disabled: false },
          { move: 'Acupressure', id: 'acupressure', pp: 48, maxpp: 48, target: 'adjacentAllyOrSelf', disabled: false },
        ],
        trapped: true,
      },
    ],
    side: side([{}, {}, {}, { condition: '0 fnt' }]),
  };
  const legal = generateLegalActions(req) as TurnLegalActions;

  it('derives targets per target type (doubles geometry)', () => {
    const a = legal.slots[0];
    expect(a.moves[0].requiresTarget).toBe(true);
    expect(a.moves[0].targets.map((t) => t.loc)).toEqual([1, 2, -2]);
    expect(a.moves[1].requiresTarget).toBe(false);
    expect(a.moves[1].implicitTarget).toMatch(/both opposing/);
    expect(a.moves[2].disabled).toBe(true);
    expect(a.moves[3].targets.map((t) => t.loc)).toEqual([-2]);
    expect(a.canMegaEvo).toBe(true);
    expect(a.switches.map((s) => s.slot)).toEqual([3]); // slot 4 fainted, 1-2 active
    const b = legal.slots[1];
    expect(b.moves[0].targets.map((t) => t.loc)).toEqual([1, 2, -1]);
    expect(b.moves[1].targets.map((t) => t.loc)).toEqual([-1, -2]);
    expect(b.trapped).toBe(true);
    expect(b.switches).toEqual([]);
  });

  it('validates and encodes a legal doubles turn', () => {
    const decision = { actions: [{ type: 'move', moveIndex: 1, target: 2, mega: true }, { type: 'move', moveIndex: 2, target: -2 }] } as const;
    expect(validateDecision(decision, legal).ok).toBe(true);
    expect(encodeTurn(decision as never, legal, 7)).toBe('/choose move 1 +2 mega, move 2 -2|7');
    const withSwitch = { actions: [{ type: 'switch', toSlot: 3 }, { type: 'move', moveIndex: 1, target: 1 }] } as const;
    expect(validateDecision(withSwitch, legal).ok).toBe(true);
    expect(encodeTurn(withSwitch as never, legal, 7)).toBe('/choose switch 3, move 1 +1|7');
  });

  it('rejects illegal decisions with explanations', () => {
    const r = (d: unknown) => validateDecision(d, legal).errors.join(' | ');
    expect(r({ actions: [{ type: 'move', moveIndex: 3 }, { type: 'move', moveIndex: 1, target: 1 }] })).toMatch(/disabled/);
    expect(r({ actions: [{ type: 'move', moveIndex: 1 }, { type: 'move', moveIndex: 1, target: 1 }] })).toMatch(/requires a target/);
    expect(r({ actions: [{ type: 'move', moveIndex: 2, target: 1 }, { type: 'move', moveIndex: 1, target: 1 }] })).toMatch(/does not take a target/);
    expect(r({ actions: [{ type: 'move', moveIndex: 1, target: -1 }, { type: 'move', moveIndex: 1, target: 1 }] })).toMatch(/not valid/);
    expect(r({ actions: [{ type: 'move', moveIndex: 1, target: 1 }, { type: 'switch', toSlot: 3 }] })).toMatch(/trapped/);
    expect(r({ actions: [{ type: 'move', moveIndex: 1, target: 1 }, { type: 'move', moveIndex: 1, target: 1, mega: true }] })).toMatch(/cannot Mega/);
    expect(r({ actions: [{ type: 'move', moveIndex: 1, target: 1 }] })).toMatch(/Expected 2 actions/);
    expect(r({ actions: [{ type: 'pass' }, { type: 'move', moveIndex: 1, target: 1 }] })).toMatch(/cannot pass/);
  });

  it('safe fallback is legal', () => {
    const fb = safeFallback(legal)!;
    expect(validateDecision(fb, legal).ok).toBe(true);
  });
});

describe('forced switches', () => {
  const req: ChoiceRequest = { rqid: 9, forceSwitch: [true, false], side: side([{ condition: '0 fnt' }, {}, {}, {}]) };
  const legal = generateLegalActions(req) as ForceSwitchLegalActions;
  it('requires a switch for the fainted slot only', () => {
    expect(legal.kind).toBe('switch');
    expect(legal.slots[0].mustSwitch).toBe(true);
    expect(legal.slots[0].switches.map((s) => s.slot)).toEqual([3, 4]);
    expect(legal.slots[1].mustSwitch).toBe(false);
    expect(validateDecision({ actions: [{ type: 'switch', toSlot: 3 }, { type: 'pass' }] }, legal).ok).toBe(true);
    expect(validateDecision({ actions: [{ type: 'pass' }, { type: 'pass' }] }, legal).errors.join()).toMatch(/must switch/);
    expect(validateDecision({ actions: [{ type: 'switch', toSlot: 3 }, { type: 'switch', toSlot: 4 }] }, legal).errors.join()).toMatch(/not switching/);
    expect(encodeTurn({ actions: [{ type: 'switch', toSlot: 4 }, { type: 'pass' }] }, legal, 9)).toBe('/choose switch 4, pass|9');
  });
  it('double KO requires two distinct switches', () => {
    const both = generateLegalActions({ rqid: 10, forceSwitch: [true, true], side: side([{ condition: '0 fnt' }, { condition: '0 fnt' }, {}, {}]) }) as ForceSwitchLegalActions;
    expect(validateDecision({ actions: [{ type: 'switch', toSlot: 3 }, { type: 'switch', toSlot: 3 }] }, both).errors.join()).toMatch(/already chosen/);
    expect(validateDecision(safeFallback(both)!, both).ok).toBe(true);
  });
  it('passes when nobody is left to switch in', () => {
    const none = generateLegalActions({ rqid: 11, forceSwitch: [true, false], side: side([{ condition: '0 fnt' }, {}, { condition: '0 fnt' }, { condition: '0 fnt' }]) }) as ForceSwitchLegalActions;
    expect(none.slots[0].switches).toEqual([]);
    expect(validateDecision({ actions: [{ type: 'pass' }, { type: 'pass' }] }, none).ok).toBe(true);
  });
});
