'use strict';
/**
 * Live VGC battles against the vendored engine. You are p1; p2 is Showdown's
 * own RandomPlayerAI. Best-of-three formats play their games back to back in
 * one session, keeping a set score — the engine models a single game, the
 * match around it is ours.
 */
const { randomUUID } = require('node:crypto');
const { DIST } = require('./showdown');
const { BattleStream, getPlayerStreams, Teams } = require(DIST);
const { RandomPlayerAI } = require(`${DIST}/tools/random-player-ai`);

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 50;

/** A synthetic line so the client can tell one game of a set from the next. */
const GAME_MARKER = (n) => `|aether-game|${n}`;

const sessions = new Map();

function sweep() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.touched > SESSION_TTL_MS) {
      session.destroy();
      sessions.delete(id);
    }
  }
  while (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
    oldest[1].destroy();
    sessions.delete(oldest[0]);
  }
}

class BattleSession {
  constructor({ formatId, packedTeam, playerName, bestOf }) {
    this.id = randomUUID();
    this.formatId = formatId;
    this.packedTeam = packedTeam;
    this.playerName = playerName || 'You';
    this.bestOf = bestOf || 0;
    this.winsNeeded = this.bestOf ? Math.ceil(this.bestOf / 2) : 1;

    this.touched = Date.now();
    this.log = [];
    this.request = null;
    this.lastRequest = null;
    this.error = null;
    this.ended = false;         // the whole match is over
    this.winner = null;         // match winner
    this.gameNumber = 0;
    this.score = { you: 0, foe: 0 };
    this.games = [];
    this.waiters = [];
    this.streams = null;

    this.startGame();
  }

  startGame() {
    this.gameNumber += 1;
    this.request = null;
    this.lastRequest = null;
    if (this.gameNumber > 1) this.log.push(GAME_MARKER(this.gameNumber));

    this.streams = getPlayerStreams(new BattleStream());
    new RandomPlayerAI(this.streams.p2).start();
    void this.pump(this.streams);

    const p1 = { name: this.playerName };
    const p2 = { name: 'AetherAI' };
    if (this.packedTeam) {
      p1.team = this.packedTeam;
      p2.team = this.packedTeam; // mirror match: the AI brings the same six
    }
    try {
      this.streams.omniscient.write(
        `>start ${JSON.stringify({ formatid: this.formatId })}\n` +
        `>player p1 ${JSON.stringify(p1)}\n` +
        `>player p2 ${JSON.stringify(p2)}`
      );
    } catch (err) {
      // A format with no team and no generator throws synchronously here; never
      // let that escape and take the server down.
      this.error = `Could not start this battle: ${err.message}`;
      this.ended = true;
      this.release();
    }
  }

  /** Read p1's view of one game, recording lines and the pending request. */
  async pump(streams) {
    try {
      for await (const chunk of streams.p1) {
        if (streams !== this.streams) return; // a later game owns the session now
        for (const line of chunk.split('\n')) {
          if (!line) continue;
          if (line.startsWith('|request|')) {
            const payload = line.slice('|request|'.length);
            this.request = payload ? JSON.parse(payload) : null;
            if (this.request) this.lastRequest = this.request;
            continue;
          }
          if (line.startsWith('|error|')) {
            this.error = line.slice('|error|'.length);
            // A rejected choice is not followed by a fresh |request|, so put the
            // last one back — otherwise the battle sits with nothing to click.
            if (!this.request) this.request = this.lastRequest;
            continue;
          }
          this.log.push(line);
          if (line.startsWith('|win|')) this.endGame(line.slice('|win|'.length).trim());
          else if (line === '|tie') this.endGame(null);
        }
        this.release();
      }
    } catch (err) {
      if (streams === this.streams) {
        this.error = err.message;
        this.ended = true;
      }
    } finally {
      this.release();
    }
  }

  endGame(winnerName) {
    const youWon = winnerName === this.playerName;
    this.games.push({ game: this.gameNumber, winner: winnerName });
    if (winnerName) {
      if (youWon) this.score.you += 1; else this.score.foe += 1;
    }
    const decided = this.score.you >= this.winsNeeded || this.score.foe >= this.winsNeeded;
    const outOfGames = this.bestOf ? this.gameNumber >= this.bestOf : true;
    if (decided || outOfGames) {
      this.ended = true;
      this.winner = this.score.you === this.score.foe ? null
        : this.score.you > this.score.foe ? this.playerName : 'AetherAI';
      return;
    }
    // More games to play: hand over to a fresh stream.
    const finished = this.streams;
    setImmediate(() => {
      if (this.streams !== finished) return;
      try { finished.omniscient.writeEnd(); } catch { /* already closed */ }
      this.startGame();
    });
  }

  release() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Resolve once there is something to act on, or the match is over. */
  settled(timeoutMs = 10_000) {
    const done = () => this.ended || this.error || (this.request && !this.request.wait);
    return new Promise((resolve) => {
      if (done()) return resolve();
      let finished = false;
      const finish = () => { if (!finished) { finished = true; resolve(); } };
      const timer = setTimeout(finish, timeoutMs);
      if (timer.unref) timer.unref();
      const check = () => {
        if (done()) { clearTimeout(timer); return finish(); }
        this.waiters.push(() => setImmediate(check));
      };
      check();
    });
  }

  choose(choice) {
    if (this.ended) throw new Error('This match is already over.');
    if (!/^[a-z0-9 ,+-]{1,200}$/i.test(choice)) throw new Error('That is not a valid choice.');
    this.error = null;
    this.request = null;
    this.touched = Date.now();
    this.streams.p1.write(choice);
  }

  view(since = 0) {
    return {
      id: this.id,
      formatId: this.formatId,
      log: this.log.slice(since),
      logLength: this.log.length,
      request: this.request,
      ended: this.ended,
      winner: this.winner,
      error: this.error,
      bestOf: this.bestOf,
      gameNumber: this.gameNumber,
      score: { ...this.score },
      games: this.games.slice(),
    };
  }

  destroy() {
    try { this.streams?.omniscient.writeEnd(); } catch { /* already gone */ }
  }
}

async function create({ formatId, team, playerName, bestOf }) {
  sweep();
  let packedTeam = null;
  if (team) {
    const parsed = Teams.import(team);
    if (!parsed || !parsed.length) throw new Error('That team could not be read.');
    packedTeam = Teams.pack(parsed);
  }
  const session = new BattleSession({ formatId, packedTeam, playerName, bestOf });
  sessions.set(session.id, session);
  await session.settled();
  return session;
}

function get(id) {
  const session = sessions.get(id);
  if (session) session.touched = Date.now();
  return session || null;
}

module.exports = { create, get, sessions, GAME_MARKER };
