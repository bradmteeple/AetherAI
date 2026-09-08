import { describe, expect, it } from 'vitest';
import { BattleStateEngine } from '../../src/battle/BattleStateEngine';
import { ObservationTracker } from '../../src/battle/ObservationTracker';
import { parseFrame } from '../../src/showdown/protocol';
import { OpenTeamSheetParser } from '../../src/team/OpenTeamSheetParser';
import { generateLegalActions, TurnLegalActions } from '../../src/battle/LegalActionGenerator';
import { buildSetMemory } from '../../src/set/SetMemory';
import { GameRecord, SetState } from '../../src/set/SetState';

const ROOM = 'battle-gen9championsvgc2026regmbbo3-1';

function run(lines: string[], engine: BattleStateEngine, tracker?: ObservationTracker) {
  for (const msg of parseFrame(`>${ROOM}\n${lines.join('\n')}`)) {
    engine.apply(msg);
    tracker?.observe(msg, engine.state);
  }
}

const previewRequest = {
  teamPreview: true,
  maxChosenTeamSize: 4,
  rqid: 1,
  side: {
    name: 'Aether Bot',
    id: 'p1',
    pokemon: [
      { ident: 'p1: Incineroar', details: 'Incineroar, L50, M', condition: '175/175', active: false, stats: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, moves: ['fakeout', 'flareblitz', 'darkestlariat', 'partingshot'], baseAbility: 'intimidate', item: 'sitrusberry', pokeball: 'pokeball', ability: 'intimidate' },
      { ident: 'p1: Whimsicott', details: 'Whimsicott, L50, F', condition: '135/135', active: false, stats: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, moves: ['tailwind', 'moonblast', 'encore', 'protect'], baseAbility: 'prankster', item: 'focussash', pokeball: 'pokeball', ability: 'prankster' },
      { ident: 'p1: Garchomp', details: 'Garchomp, L50, M', condition: '183/183', active: false, stats: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, moves: ['earthquake', 'dragonclaw', 'rockslide', 'protect'], baseAbility: 'roughskin', item: 'garchompite', pokeball: 'pokeball', ability: 'roughskin' },
      { ident: 'p1: Rotom', details: 'Rotom-Wash, L50', condition: '125/125', active: false, stats: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, moves: ['hydropump', 'thunderbolt', 'willowisp', 'protect'], baseAbility: 'levitate', item: 'leftovers', pokeball: 'pokeball', ability: 'levitate' },
      { ident: 'p1: Kingambit', details: 'Kingambit, L50, M', condition: '175/175', active: false, stats: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, moves: ['kowtowcleave', 'suckerpunch', 'ironhead', 'protect'], baseAbility: 'defiant', item: 'blackglasses', pokeball: 'pokeball', ability: 'defiant' },
      { ident: 'p1: Gholdengo', details: 'Gholdengo, L50', condition: '162/162', active: false, stats: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, moves: ['makeitrain', 'shadowball', 'thunderbolt', 'nastyplot'], baseAbility: 'goodasgold', item: 'choicescarf', pokeball: 'pokeball', ability: 'goodasgold' },
    ],
  },
};

const OPP_SHEET = 'Pelipper||FocusSash|Drizzle|Hurricane,Tailwind,Protect,WeatherBall|Modest||M|||50|]Kingambit||BlackGlasses|Defiant|KowtowCleave,SuckerPunch,IronHead,Protect|Adamant||F|||50|]Dragonite||LumBerry|Multiscale|ExtremeSpeed,DragonClaw,Fly,Protect|Adamant||M|||50|]Amoonguss||RockyHelmet|Regenerator|Spore,RagePowder,PollenPuff,Protect|Calm||F|||50|]Gholdengo||ChoiceScarf|GoodasGold|MakeItRain,ShadowBall,Thunderbolt,Trick|Timid||N|||50|]Garchomp||Garchompite|RoughSkin|Earthquake,DragonClaw,RockSlide,Protect|Jolly||F|||50|';

describe('BattleStateEngine', () => {
  it('tracks team preview, OTS knowledge, switches, damage, field and requests', () => {
    const engine = new BattleStateEngine({ roomId: ROOM, gameNumber: 1, ourUserId: 'aetherbot', ourUsername: 'Aether Bot' });
    const tracker = new ObservationTracker();
    run([
      '|init|battle',
      '|player|p1|Aether Bot|1|',
      '|player|p2|Rival|2|',
      '|teamsize|p1|6', '|teamsize|p2|6', '|gametype|doubles', '|gen|9', '|tier|[Gen 9 Champions] VGC 2026 Reg M-B (Bo3)',
      '|clearpoke',
      '|poke|p1|Incineroar, M|item', '|poke|p1|Whimsicott, F|item', '|poke|p1|Garchomp, M|item', '|poke|p1|Rotom-Wash|item', '|poke|p1|Kingambit, M|item', '|poke|p1|Gholdengo|item',
      '|poke|p2|Pelipper, M|item', '|poke|p2|Kingambit, F|item', '|poke|p2|Dragonite, M|item', '|poke|p2|Amoonguss, F|item', '|poke|p2|Gholdengo|item', '|poke|p2|Garchomp, F|item',
      '|teampreview|4',
      `|showteam|p2|${OPP_SHEET}`,
      `|request|${JSON.stringify(previewRequest)}`,
    ], engine, tracker);
    const s = engine.state;
    expect(s.ourSide).toBe('p1');
    expect(s.phase).toBe('teampreview');
    expect(s.formatId).toBe('gen9championsvgc2026regmbbo3');
    expect(s.sides.p2.pokemon.map((p) => p.species)).toEqual(['Pelipper', 'Kingambit', 'Dragonite', 'Amoonguss', 'Gholdengo', 'Garchomp']);
    expect(s.request?.teamPreview).toBe(true);
    expect(s.rqid).toBe(1);
    expect(engine.us.pokemon[0].item).toBe('sitrusberry');

    const sheet = new OpenTeamSheetParser().parsePacked('p2', OPP_SHEET);
    engine.applyTeamSheet(sheet);
    const oppKing = s.sides.p2.pokemon[1];
    expect(oppKing.item).toBe('BlackGlasses');
    expect(oppKing.itemKnownFrom).toBe('sheet');
    expect(oppKing.moves.map((m) => m.id)).toEqual(['KowtowCleave', 'SuckerPunch', 'IronHead', 'Protect']);

    run([
      '|start',
      '|switch|p1a: Incineroar|Incineroar, L50, M|175/175',
      '|switch|p1b: Whimsicott|Whimsicott, L50, F|135/135',
      '|switch|p2a: Pelipper|Pelipper, L50, M|100/100',
      '|switch|p2b: Kingambit|Kingambit, L50, F|100/100',
      '|-weather|RainDance|[from] ability: Drizzle|[of] p2a: Pelipper',
      '|-ability|p1a: Incineroar|Intimidate|boost',
      '|-unboost|p2a: Pelipper|atk|1',
      '|-boost|p2b: Kingambit|atk|1',
      '|turn|1',
    ], engine, tracker);
    expect(s.phase).toBe('battle');
    expect(s.turn).toBe(1);
    expect(s.field.weather).toBe('RainDance');
    expect(s.sides.p1.active.map((m) => m?.species)).toEqual(['Incineroar', 'Whimsicott']);
    expect(s.sides.p2.active[1]?.boosts.atk).toBe(1);
    expect(s.sides.p2.active[0]?.boosts.atk).toBe(-1);
    expect(tracker.observations.leads.p2).toEqual(['Pelipper', 'Kingambit']);
    expect(tracker.observations.brought.p2).toEqual(['Pelipper', 'Kingambit']);

    run([
      '|move|p1b: Whimsicott|Tailwind|p1b: Whimsicott',
      '|-sidestart|p1: Aether Bot|move: Tailwind',
      '|move|p2b: Kingambit|Protect|p2b: Kingambit',
      '|-singleturn|p2b: Kingambit|Protect',
      '|move|p1a: Incineroar|Fake Out|p2a: Pelipper',
      '|-damage|p2a: Pelipper|61/100',
      '|move|p2a: Pelipper|Hurricane|p1a: Incineroar',
      '|-supereffective|p1a: Incineroar',
      '|-damage|p1a: Incineroar|20/175',
      '|-fieldstart|move: Trick Room|[of] p2b: Kingambit',
      '|upkeep',
      '|turn|2',
    ], engine, tracker);
    expect(s.sides.p1.conditions.map((c) => c.id)).toEqual(['tailwind']);
    expect(s.sides.p2.active[0]?.hpPercent).toBe(61);
    expect(s.sides.p1.active[0]?.hp).toBe(20);
    expect(s.sides.p1.active[0]?.hpPercent).toBeCloseTo(11.4, 1);
    expect(s.field.pseudoWeather.map((p) => p.id)).toEqual(['trickroom']);
    expect(s.sides.p2.active[1]?.volatiles).toEqual([]); // single-turn cleared on |turn|
    expect(s.sides.p2.active[0]?.revealedMoves).toEqual(['Hurricane']);
    const o = tracker.observations;
    expect(o.protects).toHaveLength(1);
    expect(o.protects[0]).toMatchObject({ side: 'p2', species: 'Kingambit' });
    expect(o.damage.map((d) => [d.move, d.damagePercent, d.effectiveness])).toEqual([
      ['Fake Out', 39, 'neutral'],
      ['Hurricane', expect.any(Number), 'super'],
    ]);
    expect(o.speedOrders[0].order.map((x) => x.species)).toEqual(['Whimsicott', 'Kingambit', 'Incineroar', 'Pelipper']);
    expect(o.targeting.filter((t) => t.side === 'p2')[0]).toMatchObject({ move: 'Hurricane', targetSpecies: 'Incineroar' });

    run([
      '|move|p2b: Kingambit|Kowtow Cleave|p1a: Incineroar',
      '|-damage|p1a: Incineroar|0 fnt',
      '|faint|p1a: Incineroar',
      '|upkeep',
      `|request|${JSON.stringify({ rqid: 3, forceSwitch: [true, false], side: { ...previewRequest.side, pokemon: [
        { ...previewRequest.side.pokemon[0], condition: '0 fnt', active: true },
        { ...previewRequest.side.pokemon[1], active: true },
        { ...previewRequest.side.pokemon[2] },
        { ...previewRequest.side.pokemon[3] },
      ] } })}`,
    ], engine, tracker);
    expect(s.sides.p1.active[0]?.fainted).toBe(true);
    expect(o.kos[0]).toMatchObject({ species: 'Incineroar', byMove: 'Kowtow Cleave' });
    const legal = generateLegalActions(s.request!, s);
    expect(legal.kind).toBe('switch');
    if (legal.kind === 'switch') expect(legal.slots[0].switches.map((x) => x.species)).toEqual(['Garchomp', 'Rotom-Wash']);

    run([
      '|switch|p1a: Garchomp|Garchomp, L50, M|183/183',
      '|turn|3',
      `|request|${JSON.stringify({ rqid: 4, active: [
        { moves: [{ move: 'Earthquake', id: 'earthquake', pp: 16, maxpp: 16, target: 'allAdjacent', disabled: false }, { move: 'Dragon Claw', id: 'dragonclaw', pp: 24, maxpp: 24, target: 'normal', disabled: false }], canMegaEvo: true },
        { moves: [{ move: 'Moonblast', id: 'moonblast', pp: 24, maxpp: 24, target: 'normal', disabled: false }] },
      ], side: { ...previewRequest.side, pokemon: [
        { ...previewRequest.side.pokemon[2], active: true },
        { ...previewRequest.side.pokemon[1], active: true },
        { ...previewRequest.side.pokemon[0], condition: '0 fnt' },
        { ...previewRequest.side.pokemon[3] },
      ] } })}`,
    ], engine, tracker);
    const turn = generateLegalActions(s.request!, s) as TurnLegalActions;
    expect(turn.slots[0].species).toBe('Garchomp');
    expect(turn.slots[0].canMegaEvo).toBe(true);
    expect(turn.slots[0].moves[1].targets.filter((t) => t.side === 'foe').map((t) => [t.loc, t.species, t.occupied])).toEqual([[1, 'Pelipper', true], [2, 'Kingambit', true]]);
    expect(turn.slots[0].switches.map((x) => x.slot)).toEqual([4]);
    expect(o.switches.filter((x) => x.side === 'p1')[0]).toMatchObject({ inSpecies: 'Garchomp', forced: true });

    run(['|win|Rival'], engine, tracker);
    expect(s.ended).toBe(true);
    expect(s.winner).toBe('Rival');
  });

  it('builds set memory from game records', () => {
    const engine = new BattleStateEngine({ roomId: ROOM, gameNumber: 1, ourUserId: 'aetherbot', ourUsername: 'Aether Bot' });
    const tracker = new ObservationTracker();
    run(['|player|p1|Aether Bot|1|', '|player|p2|Rival|2|', '|start', '|switch|p1a: A|Garchomp, L50|100/100', '|switch|p1b: B|Whimsicott, L50|100/100', '|switch|p2a: C|Pelipper, L50|100/100', '|switch|p2b: D|Kingambit, L50|100/100', '|turn|1', '|move|p2b: D|Protect|p2b: D', '|upkeep', '|turn|2', '|switch|p2a: E|Amoonguss, L50|100/100', '|upkeep', '|win|Rival'], engine, tracker);
    const record: GameRecord = {
      gameNumber: 1, roomId: ROOM, ourSide: 'p1', startedAt: '', endedAt: '', result: 'loss', winnerName: 'Rival', turns: 2,
      ourBringFour: ['Garchomp', 'Whimsicott', 'Rotom-Wash', 'Kingambit'], opponentBringFour: tracker.observations.brought.p2,
      ourLead: tracker.observations.leads.p1, opponentLead: tracker.observations.leads.p2, observations: tracker.observations,
      opponentSummary: tracker.summarizeOpponent(engine.state), decisions: [], battleEvents: [], finalState: engine.state,
    };
    const set = { games: [record], opponentTeamSheet: new OpenTeamSheetParser().parsePacked('p2', OPP_SHEET) } as unknown as SetState;
    const memory = buildSetMemory(set);
    expect(memory.previousGames).toHaveLength(1);
    expect(memory.previousGames[0].opponentLead).toEqual(['Pelipper', 'Kingambit']);
    expect(memory.previousGames[0].opponentProtects).toHaveLength(1);
    expect(memory.previousGames[0].opponentSwitches).toHaveLength(1);
    expect(memory.opponentTendencies.leadFrequency).toEqual({ Pelipper: 1, Kingambit: 1 });
    expect(memory.opponentTendencies.neverBrought).toEqual(['Dragonite', 'Gholdengo', 'Garchomp']);
    expect(memory.opponentTendencies.protectRateBySpecies.Kingambit.protects).toBe(1);
  });
});
