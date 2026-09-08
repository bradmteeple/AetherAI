import { describe, expect, it } from 'vitest';
import { BestOfSetManager, SetManagerEvent } from '../../src/set/BestOfSetManager';
import { parseFrame } from '../../src/showdown/protocol';

const PARENT = 'game-bestof3-gen9championsvgc2026regmbbo3-3';
const G = (n: number) => `battle-gen9championsvgc2026regmbbo3-${10 + n}`;

function feed(m: BestOfSetManager, frame: string): SetManagerEvent[] {
  return parseFrame(frame).flatMap((msg) => m.handleMessage(msg));
}

function newManager() {
  return new BestOfSetManager({ ourUserId: 'aetherbot', formatId: 'gen9championsvgc2026regmbbo3' });
}

function gameStart(m: BestOfSetManager, n: number) {
  const ev = [
    ...feed(m, `>${PARENT}\n|html|<h2>Game ${n}</h2>\n|uhtml|game${n}|<a href="/${G(n)}">Aether Bot vs. Rival</a>`),
    ...feed(m, `>${G(n)}\n|init|battle\n|title|Aether Bot vs. Rival\n|uhtml|bestof|<h2><strong>Game ${n}</strong> of <a href="/${PARENT}">a best-of-3</a></h2>`),
  ];
  return ev;
}

function readyPrompt(m: BestOfSetManager, n: number) {
  return feed(
    m,
    `>${PARENT}\n|tempnotify|choice|Next game|It's time for game ${n} in your best-of-3!\n|c|~|/uhtml controls,<div class="infobox"><p style="margin:6px">Are you ready for game ${n}, Aether Bot?</p><p style="margin:6px"><button class="button notifying" name="send" value="/msgroom ${PARENT},/confirmready">I'm ready!</button></p></div>`,
  );
}

describe('BestOfSetManager', () => {
  it('detects the parent room, links games and tracks the score through a 2-0', () => {
    const m = newManager();
    let ev = feed(m, `>${PARENT}\n|init|battle\n|title|Aether Bot vs. Rival`);
    expect(ev.find((e) => e.type === 'setCreated')).toMatchObject({ parentRoomId: PARENT, bestOf: 3 });
    expect(ev.find((e) => e.type === 'players')).toMatchObject({ names: ['Aether Bot', 'Rival'] });
    ev = gameStart(m, 1);
    expect(ev.filter((e) => e.type === 'gameRoomLinked')).toEqual([{ type: 'gameRoomLinked', roomId: G(1), gameNumber: 1 }]);
    expect(m.currentGameNumber).toBe(1);

    ev = feed(m, `>${G(1)}\n|win|Aether Bot`);
    expect(ev.find((e) => e.type === 'gameEnded')).toMatchObject({ gameNumber: 1, ourResult: 'win', winnerName: 'Aether Bot' });
    expect(m.scoreForUs()).toEqual({ ourWins: 1, opponentWins: 0, ties: 0 });
    expect(m.expectedSetOver()).toBe(false);

    ev = readyPrompt(m, 2);
    expect(ev.filter((e) => e.type === 'readyPrompt')).toEqual([{ type: 'readyPrompt', parentRoomId: PARENT, nextGameNumber: 2 }]);
    expect(m.phase).toBe('BETWEEN_GAMES');
    // duplicate prompt in the battle room is ignored
    expect(feed(m, `>${G(1)}\n|tempnotify|choice|Next game|It's time for game 2 in your best-of-3!`).filter((e) => e.type === 'readyPrompt')).toEqual([]);
    ev = feed(m, `>${PARENT}\n||Aether Bot is ready for game 2.`);
    expect(ev.find((e) => e.type === 'playerReady')).toMatchObject({ isUs: true, gameNumber: 2 });
    expect(m.phase).toBe('READY_CONFIRMED');

    ev = gameStart(m, 2);
    expect(ev.find((e) => e.type === 'gameRoomLinked')).toMatchObject({ roomId: G(2), gameNumber: 2 });
    ev = feed(m, `>${G(2)}\n|win|Aether Bot`);
    expect(m.scoreForUs()).toEqual({ ourWins: 2, opponentWins: 0, ties: 0 });
    expect(m.expectedSetOver()).toBe(true);
    ev = feed(m, `>${PARENT}\n|html|Aether Bot won game 2!\n|allowleave|\n|win|Aether Bot`);
    expect(ev.find((e) => e.type === 'setEnded')).toMatchObject({ ourResult: 'win', winnerName: 'Aether Bot' });
    expect(m.phase).toBe('SET_COMPLETE');
  });

  it('goes to game 3 at 1-1 and reports a 1-2 loss', () => {
    const m = newManager();
    feed(m, `>${PARENT}\n|init|battle\n|title|Aether Bot vs. Rival`);
    gameStart(m, 1);
    feed(m, `>${G(1)}\n|win|Rival`);
    readyPrompt(m, 2);
    gameStart(m, 2);
    feed(m, `>${G(2)}\n|win|Aether Bot`);
    expect(m.scoreForUs()).toEqual({ ourWins: 1, opponentWins: 1, ties: 0 });
    expect(m.expectedSetOver()).toBe(false);
    const ev = readyPrompt(m, 3);
    expect(ev.find((e) => e.type === 'readyPrompt')).toMatchObject({ nextGameNumber: 3 });
    gameStart(m, 3);
    expect(m.currentGameNumber).toBe(3);
    feed(m, `>${G(3)}\n|win|Rival`);
    expect(m.scoreForUs()).toEqual({ ourWins: 1, opponentWins: 2, ties: 0 });
    const end = feed(m, `>${PARENT}\n|win|Rival`);
    expect(end.find((e) => e.type === 'setEnded')).toMatchObject({ ourResult: 'loss' });
  });

  it('links a battle room that arrives before the parent (reconnect ordering)', () => {
    const m = newManager();
    const ev = feed(m, `>${G(1)}\n|init|battle\n|uhtml|bestof|<h2><strong>Game 1</strong> of <a href="/${PARENT}">a best-of-3</a></h2>`);
    expect(ev.find((e) => e.type === 'setCreated')).toMatchObject({ parentRoomId: PARENT });
    expect(ev.find((e) => e.type === 'gameRoomLinked')).toMatchObject({ gameNumber: 1 });
    // parent init afterwards is a no-op
    expect(feed(m, `>${PARENT}\n|init|battle`).filter((e) => e.type === 'setCreated')).toEqual([]);
  });

  it('ignores battles from a different set and the disabled ready button', () => {
    const m = newManager();
    feed(m, `>${PARENT}\n|init|battle`);
    const other = 'game-bestof3-gen9championsvgc2026regmbbo3-99';
    const ev = feed(m, `>battle-gen9championsvgc2026regmbbo3-500\n|init|battle\n|uhtml|bestof|<h2><strong>Game 1</strong> of <a href="/${other}">a best-of-3</a></h2>`);
    expect(ev.filter((e) => e.type === 'gameRoomLinked')).toEqual([]);
    gameStart(m, 1);
    feed(m, `>${G(1)}\n|win|Rival`);
    const disabled = feed(m, `>${PARENT}\n|c|~|/uhtml controls,<div class="infobox"><p>Are you ready for game 2, Aether Bot?</p><p><button class="button" disabled><i class="fa fa-check"></i> I'm ready!</button> &ndash; waiting for opponent...</p></div>`);
    expect(disabled.filter((e) => e.type === 'readyPrompt')).toEqual([]);
  });

  it('handles ties by lowering the win threshold', () => {
    const m = newManager();
    feed(m, `>${PARENT}\n|init|battle`);
    gameStart(m, 1);
    feed(m, `>${G(1)}\n|tie`);
    expect(m.scoreForUs().ties).toBe(1);
    expect(m.winThreshold).toBe(2);
    gameStart(m, 2);
    feed(m, `>${G(2)}\n|win|Aether Bot`);
    expect(m.expectedSetOver()).toBe(false);
  });
});
