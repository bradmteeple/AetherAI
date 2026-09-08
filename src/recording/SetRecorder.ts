import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DecisionRecord, GameRecord, SetState } from '../set/SetState';
import { snapshotState } from '../battle/BattleStateEngine';

/**
 * One folder per set:
 *   runs/set_<date>_<nnn>/
 *     set.json          – SetState (updated on every transition)
 *     ots.json          – both team sheets
 *     game1.json ...    – GameRecord per game
 *     decisions.jsonl   – every agent decision with legal actions & validation
 *     protocol.log      – raw protocol lines for the set's rooms
 */
export class SetRecorder {
  readonly dir: string;
  readonly setId: string;

  constructor(runsDir: string, date = new Date()) {
    mkdirSync(runsDir, { recursive: true });
    const day = date.toISOString().slice(0, 10);
    const existing = readdirSync(runsDir).filter((d) => d.startsWith(`set_${day}_`));
    const n = existing.length + 1;
    this.setId = `set_${day}_${String(n).padStart(3, '0')}`;
    this.dir = join(runsDir, this.setId);
    mkdirSync(this.dir, { recursive: true });
  }

  writeSet(set: SetState): void {
    const slim: SetState = {
      ...set,
      games: set.games.map((g) => ({ ...g, battleEvents: [], finalState: null, observations: g.observations, decisions: [] })),
    };
    writeFileSync(join(this.dir, 'set.json'), JSON.stringify(slim, null, 2));
  }

  writeOts(set: SetState): void {
    writeFileSync(
      join(this.dir, 'ots.json'),
      JSON.stringify({ ours: set.ourTeamSheet, opponent: set.opponentTeamSheet, ourFullTeam: set.ourTeam }, null, 2),
    );
  }

  writeGame(record: GameRecord): void {
    const out = { ...record, finalState: record.finalState ? snapshotState(record.finalState) : null };
    writeFileSync(join(this.dir, `game${record.gameNumber}.json`), JSON.stringify(out, null, 2));
  }

  appendDecision(decision: DecisionRecord): void {
    appendFileSync(join(this.dir, 'decisions.jsonl'), JSON.stringify(decision) + '\n');
  }

  appendProtocol(room: string, line: string): void {
    appendFileSync(join(this.dir, 'protocol.log'), `${new Date().toISOString()} ${room}\t${line}\n`);
  }

  static exists(dir: string): boolean {
    return existsSync(dir);
  }
}
