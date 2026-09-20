'use strict';
/**
 * Live battles against the vendored engine. You are p1; p2 is Showdown's own
 * RandomPlayerAI. Each session holds the real BattleStream, the protocol lines
 * you are allowed to see, and whatever choice the engine is waiting on.
 */
const { randomUUID } = require('node:crypto');
const { DIST } = require('./showdown');
const { BattleStream: Stream, getPlayerStreams: playerStreams, Teams: TeamsLib } = require(DIST);
const { RandomPlayerAI } = require(`${DIST}/tools/random-player-ai`);

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 50;

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
  constructor({ formatId, team, playerName }) {
    this.id = randomUUID();
    this.formatId = formatId;
    this.touched = Date.now();
    this.log = [];            // protocol lines as p1 sees them
    this.request = null;      // what the engine is waiting on
    this.lastRequest = null;  // kept so a rejected choice can be retried
    this.ended = false;
    this.winner = null;
    this.error = null;
    this.waiters = [];

    this.streams = playerStreams(new Stream());
    this.ai = new RandomPlayerAI(this.streams.p2);
    this.ai.start();

    void this.pump();

    const spec = { formatid: formatId };
    const p1 = { name: playerName || 'You' };
    const p2 = { name: 'AetherAI' };
    if (team) {
      p1.team = TeamsLib.pack(TeamsLib.import(team));
      p2.team = p1.team; // mirror match when a team is supplied
    }
    this.streams.omniscient.write(
      `>start ${JSON.stringify(spec)}\n` +
      `>player p1 ${JSON.stringify(p1)}\n` +
      `>player p2 ${JSON.stringify(p2)}`
    );
  }

  /** Read p1's view forever, recording lines and the pending request. */
  async pump() {
    try {
      for await (const chunk of this.streams.p1) {
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
          if (line.startsWith('|win|')) {
            this.ended = true;
            this.winner = line.slice('|win|'.length).trim();
          }
          // Exactly `|tie` — `|tier|<format>` is a different line entirely.
          if (line === '|tie') {
            this.ended = true;
            this.winner = null;
          }
        }
        this.release();
      }
    } catch (err) {
      this.error = err.message;
    } finally {
      this.ended = true;
      this.release();
    }
  }

  release() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Resolve once the engine has produced something new to act on: a request to
   * answer, an error to show, or the end of the battle.
   */
  settled(timeoutMs = 8000) {
    const start = Date.now();
    const done = () => this.ended || this.error || (this.request && !this.request.wait);
    return new Promise((resolve) => {
      const check = () => {
        if (done() || Date.now() - start > timeoutMs) return resolve();
        this.waiters.push(() => setImmediate(check));
      };
      check();
    });
  }

  choose(choice) {
    if (this.ended) throw new Error('This battle is already over.');
    if (!/^[a-z0-9 ,+-]{1,120}$/i.test(choice)) throw new Error('That is not a valid choice.');
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
    };
  }

  destroy() {
    try { this.streams.omniscient.writeEnd(); } catch { /* already gone */ }
  }
}

async function create({ formatId, team, playerName }) {
  sweep();
  const session = new BattleSession({ formatId, team, playerName });
  sessions.set(session.id, session);
  await session.settled();
  return session;
}

function get(id) {
  const session = sessions.get(id);
  if (session) session.touched = Date.now();
  return session || null;
}

module.exports = { create, get, sessions };
