import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { packTeam, unpackTeam } from '../../src/team/PackedTeam';
import { parseTeamText, loadTeamFile } from '../../src/team/TeamLoader';
import { OpenTeamSheetParser } from '../../src/team/OpenTeamSheetParser';
import { staticChecks, validateLocally } from '../../src/team/TeamValidator';
import { parseLine } from '../../src/showdown/protocol';
import { loadShowdown, dexNameResolver } from '../../src/team/dex';

const TEAM_FILE = 'teams/regmb-team.txt';

describe('team loading & packing', () => {
  it('parses the sample team file', () => {
    const team = loadTeamFile(TEAM_FILE);
    expect(team).toHaveLength(6);
    expect(team[0].species).toBe('Incineroar');
    expect(team[0].item).toBe('Sitrus Berry');
    expect(team[0].evs).toEqual({ hp: 32, atk: 4, def: 12, spa: 0, spd: 18, spe: 0 });
    expect(team[3].species).toBe('Rotom-Wash');
    expect(team[5].moves).toEqual(['Make It Rain', 'Shadow Ball', 'Thunderbolt', 'Nasty Plot']);
  });

  it('packs exactly like Showdown', () => {
    const team = loadTeamFile(TEAM_FILE);
    const packed = packTeam(team);
    expect(packed.startsWith('Incineroar||SitrusBerry|Intimidate|FakeOut,FlareBlitz,DarkestLariat,PartingShot|Careful|32,4,12,,18,||||50|')).toBe(true);
    expect(packed).toContain(']Rotom-Wash||Leftovers|Levitate|');
    const sd = loadShowdown();
    if (sd) {
      const text = readFileSync(TEAM_FILE, 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n');
      const theirs = sd.Teams.pack(sd.Teams.import(text)!);
      // Showdown's importer fills genders (N) for genderless species; ignore that field.
      expect(packed.replace(/\|N\|/g, '||')).toBe(theirs.replace(/\|N\|/g, '||'));
    }
  });

  it('unpacks what it packs', () => {
    const team = loadTeamFile(TEAM_FILE);
    const sets = unpackTeam(packTeam(team));
    expect(sets).toHaveLength(6);
    expect(sets[0].species).toBe('Incineroar');
    expect(sets[0].item).toBe('SitrusBerry');
    expect(sets[0].evs).toEqual({ hp: 32, atk: 4, def: 12, spa: 0, spd: 18, spe: 0 });
    expect(sets[0].level).toBe(50);
    expect(sets[3].speciesId).toBe('rotomwash');
  });

  it('parses nickname/gender headers and stat point aliases', () => {
    const [set] = parseTeamText('Sparky (Garchomp) (M) @ Garchompite\nAbility: Rough Skin\nStat Points: 32 Atk / 30 Spe\nJolly Nature\n- Earthquake\n');
    expect(set.name).toBe('Sparky');
    expect(set.species).toBe('Garchomp');
    expect(set.gender).toBe('M');
    expect(set.evs.atk).toBe(32);
    expect(set.evs.spe).toBe(30);
  });

  it('static checks flag Reg M-B mistakes', () => {
    const team = loadTeamFile(TEAM_FILE);
    expect(staticChecks(team).ok).toBe(true);
    const bad = JSON.parse(JSON.stringify(team));
    bad[1].item = 'Sitrus Berry';
    bad[2].evs.atk = 40;
    bad[4].level = 100;
    const res = staticChecks(bad);
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/Item Clause/);
    expect(res.problems.join('\n')).toMatch(/max is 32/);
    expect(res.problems.join('\n')).toMatch(/level 50/);
  });

  it('validates with the real champions validator when Showdown is available', () => {
    const team = loadTeamFile(TEAM_FILE);
    const res = validateLocally(team);
    if (!res) return; // no local checkout
    expect(res.ok).toBe(true);
    const bad = JSON.parse(JSON.stringify(team));
    bad[0].item = 'Safety Goggles';
    const badRes = validateLocally(bad)!;
    expect(badRes.ok).toBe(false);
    expect(badRes.problems.join(' ')).toMatch(/Safety Goggles/);
  });
});

describe('OpenTeamSheetParser', () => {
  // Exactly what showOpenTeamSheets() packs for champions: name '', evs/ivs null, nature kept.
  const packed = 'Incineroar||SitrusBerry|Intimidate|FakeOut,FlareBlitz,DarkestLariat,PartingShot|Careful||M|||50|]Rotom|RotomWash|Leftovers|Levitate|HydroPump,Thunderbolt,WillOWisp,Protect|Calm||N|||50|';

  it('extracts only sheet-legal fields', () => {
    const sheet = new OpenTeamSheetParser().parseMessage(parseLine('battle-x-1', `|showteam|p2|${packed}`))!;
    expect(sheet.side).toBe('p2');
    expect(sheet.pokemon).toHaveLength(2);
    const inc = sheet.pokemon[0];
    expect(inc.slot).toBe(1);
    expect(inc.species).toBe('Incineroar');
    expect(inc.itemId).toBe('SitrusBerry');
    expect(inc.abilityId).toBe('Intimidate');
    expect(inc.moveIds).toEqual(['FakeOut', 'FlareBlitz', 'DarkestLariat', 'PartingShot']);
    expect(inc.nature).toBe('Careful');
    expect(inc.gender).toBe('M');
    expect(inc.level).toBe(50);
    expect((inc as unknown as Record<string, unknown>).evs).toBeUndefined();
    expect((inc as unknown as Record<string, unknown>).ivs).toBeUndefined();
    expect(sheet.pokemon[1].speciesId).toBe('rotomwash');
  });

  it('drops EVs even if a server included them', () => {
    const leaky = 'Incineroar||SitrusBerry|Intimidate|FakeOut|Careful|32,4,12,,18,|M|||50|';
    const sheet = new OpenTeamSheetParser().parsePacked('p1', leaky);
    expect(JSON.stringify(sheet.pokemon[0])).not.toMatch(/32,4,12|"evs"/);
  });

  it('prettifies names when a Dex is available', () => {
    const sd = loadShowdown();
    if (!sd) return;
    const sheet = new OpenTeamSheetParser(dexNameResolver(sd.Dex)).parsePacked('p1', packed);
    expect(sheet.pokemon[0].item).toBe('Sitrus Berry');
    expect(sheet.pokemon[0].moves[0]).toBe('Fake Out');
    expect(sheet.pokemon[1].species).toBe('Rotom-Wash');
  });
});
