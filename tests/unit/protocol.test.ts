import { describe, expect, it } from 'vitest';
import { parseFrame, parseLine, parsePm, parseChat } from '../../src/showdown/protocol';
import { classifyRoom, extractRoomLinks, parseBattleRoomId, parseBestOfRoomId } from '../../src/showdown/rooms';
import { toID, cleanIdentity } from '../../src/util/id';

describe('protocol parsing', () => {
  it('splits room frames into messages', () => {
    const msgs = parseFrame('>battle-gen9championsvgc2026regmbbo3-12\n|init|battle\n|title|A vs. B\n|turn|3\n');
    expect(msgs.map((m) => m.type)).toEqual(['init', 'title', 'turn']);
    expect(msgs[0].room).toBe('battle-gen9championsvgc2026regmbbo3-12');
    expect(msgs[1].rest).toBe('A vs. B');
    expect(msgs[2].args).toEqual(['3']);
  });

  it('handles global frames without a room header', () => {
    const [msg] = parseFrame('|challstr|4|abc|def');
    expect(msg.room).toBe('');
    expect(msg.type).toBe('challstr');
    expect(msg.rest).toBe('4|abc|def');
  });

  it('keeps pipes inside request JSON', () => {
    const json = JSON.stringify({ side: { name: 'a|b' }, rqid: 2 });
    const msg = parseLine('r', `|request|${json}`);
    expect(JSON.parse(msg.rest)).toEqual({ side: { name: 'a|b' }, rqid: 2 });
  });

  it('parses plain and || log lines', () => {
    expect(parseLine('r', '||Alice is ready for game 2.').rest).toBe('Alice is ready for game 2.');
    expect(parseLine('r', 'plain text').type).toBe('');
  });

  it('parses pm and chat', () => {
    const pm = parsePm(parseLine('', '|pm| Alice| Bob|/challenge gen9championsvgc2026regmbbo3|gen9championsvgc2026regmbbo3|||'));
    expect(pm?.message.startsWith('/challenge gen9championsvgc2026regmbbo3|')).toBe(true);
    const chat = parseChat(parseLine('r', '|c|~|/uhtml controls,<div>x|y</div>'));
    expect(chat?.user).toBe('~');
    expect(chat?.message).toBe('/uhtml controls,<div>x|y</div>');
  });
});

describe('room ids', () => {
  it('classifies best-of and battle rooms', () => {
    expect(classifyRoom('game-bestof3-gen9championsvgc2026regmbbo3-5')).toBe('bestof');
    expect(classifyRoom('battle-gen9championsvgc2026regmbbo3-6')).toBe('battle');
    expect(classifyRoom('lobby')).toBe('lobby');
    expect(classifyRoom('')).toBe('global');
    expect(parseBestOfRoomId('game-bestof3-gen9championsvgc2026regmbbo3-5')).toEqual({ roomId: 'game-bestof3-gen9championsvgc2026regmbbo3-5', bestOf: 3, formatId: 'gen9championsvgc2026regmbbo3', battleNumber: 5 });
    expect(parseBattleRoomId('battle-gen9championsvgc2026regmbbo3-6-abcdefpw')?.battleNumber).toBe(6);
  });
  it('extracts room links from html', () => {
    expect(extractRoomLinks('<h2><strong>Game 2</strong> of <a href="/game-bestof3-gen9championsvgc2026regmbbo3-5">a best-of-3</a></h2>')).toEqual(['game-bestof3-gen9championsvgc2026regmbbo3-5']);
  });
  it('toID and identities', () => {
    expect(toID('Aether Bot!')).toBe('aetherbot');
    expect(cleanIdentity('@Aether Bot@!')).toBe('Aether Bot');
    expect(cleanIdentity(' aetherbot')).toBe('aetherbot');
  });
});
